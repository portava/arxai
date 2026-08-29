import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, CandlestickSeries, createSeriesMarkers, ColorType, CrosshairMode, LineStyle, type UTCTimestamp, type IChartApi, type ISeriesApi, type IPriceLine, type SeriesType, type SeriesMarker } from "lightweight-charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CandlestickChart, RefreshCw, Loader2, X, Flame, AlertTriangle, Clock } from "lucide-react";
import { formatMarketClosedLabel } from "@/components/charts/marketFrozenFormat";
import { useChartSymbol, bareSymbol } from "@/lib/use-chart-symbol";
// `Candle` + the pure `adaptChartCandles` mapping live in scannerCandleAdapter.ts
// so the field-shape handling is unit-tested (Task #367 — see that test).
import { adaptChartCandles, type Candle } from "@/components/scanner/scannerCandleAdapter";
import {
  PRIMARY_TIMEFRAMES,
  coerceVisibleTimeframe,
  formatCandleCountdown,
  NEWS_MARKER_LOOKAHEAD_BARS,
  isFeedConfirmedForEventMarkers,
  inferBarSeconds,
  resolveEventMarkerSec,
} from "@/components/scanner/scannerChartFormat";
import { RubyChartRead } from "@/components/scanner/RubyChartRead";
import {
  applyStructureLines,
  clearStructureLines,
  EMPTY_STRUCTURE_HANDLES,
  type StructureLinesHandles,
} from "@/lib/chart-engine/structureLines";
import type { ChartStructureLine, ChartStructureMarker } from "@/lib/chart-engine";
import { sanitizeCandlestickData } from "@/lib/chart-engine/candleSanitize";
import { snapSecToCandle } from "@/components/scanner/scannerChartFormat";
import { useAssistantName } from "@/lib/assistant-name";
import { overlayBadgeLabel, OVERLAY_DEGRADED_TITLE } from "@/lib/scannerResilience";
import { OneClickArmedBadge } from "@/components/mt5/OneClickArmedBadge";
import { ChartCommandMenu, type ChartCommandAnchor, type RubyChartIntent } from "@/components/scanner/ChartCommandMenu";
import { useLocation } from "wouter";
import { executeInstantTrade, type InstantTradeResponse } from "@/lib/instantTradeRouter";
import { computeRiskReward, pipDistance, validateModifyLevels } from "@/lib/chart-drag-modify";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { useSymbolTruth } from "@/hooks/useSymbolTruth";
import { resolveTradeAffordance } from "@/lib/trade-affordance";
import { resolveLiveActionCapabilities } from "@/lib/liveActionCapabilities";
import { useSelectedActionStore } from "./selectedActionStore";
import { useRubyReadStore } from "./rubyReadStore";
import {
  resolveSelectedSymbolActionabilityDisplay,
  actionabilityDisplayUi,
  resolveVisibleActionButtonLabel,
  biasToActionDirection,
  type ScannerActionabilityDisplay,
  type ActionDirection,
} from "@/lib/scannerActionability";
import {
  chartCandlesQueryKey,
  fetchChartCandles,
  toApiTimeframe,
  type ChartCandlesResult,
} from "@/lib/chartCandlesQuery";
import { useChartDeepHistory } from "@/lib/useChartDeepHistory";
import { ChartHistoryBadge } from "@/components/charts/ChartHistoryBadge";
import { ChartFeedStatusBadge } from "@/components/charts/ChartFeedStatusBadge";
import { useProductRole } from "@/hooks/useProductRole";
import { useToast } from "@/hooks/use-toast";
import { humanizeReason } from "@/lib/humanize";
import {
  type FeedStatus,
  type ChartDisplayStatus,
  resolveDisplayStatus,
  isLivePriceDisplay,
} from "@/lib/chart-display-status";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetMeChartAnnotations,
  getGetMeChartAnnotationsQueryKey,
  usePostMeChartAnnotation,
  useDeleteMeChartAnnotation,
  usePostMeChartAiAlertsScan,
  getGetAlertUnreadCountQueryKey,
  useGetMeChartIntelligence,
  getGetMeChartIntelligenceQueryKey,
  type GetMeChartIntelligenceTimeframe,
  useGetMeChartSmartLayers,
  getGetMeChartSmartLayersQueryKey,
  useGetAlertPreferences,
  useGetMeTradeHealth,
  getGetMeTradeHealthQueryKey,
  useGetTimingBrain,
  getGetTimingBrainQueryKey,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import type {
  ChartAnnotation,
  ChartAnnotationCreateRequestKind,
  ChartAnnotationCreateRequestTimeframe,
  SmartChartLayer,
  SmartChartOverlayHandshake,
  GetMeChartSmartLayersTimeframe,
} from "@workspace/api-client-react";
import { buildOverlayHandshake, isWithinQuietHoursUtc, newsToastDecision } from "@workspace/domain/smart-chart";

// The overlay contracts (chart annotations + smart layers) intentionally stay on
// the original 7-value timeframe vocabulary (M1,M5,M15,M30,H1,H4,D1) — they are
// advisory CONTEXT tags, NOT the candle-data feed (which now spans all 21 MT5
// timeframes). Map every chart id to its NEAREST supported overlay bucket (ties
// resolve to the coarser one) so an exotic selection like 1W tags/queries D1
// rather than collapsing to the M5 default.
type OverlayTf = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
function toOverlayTf(tf: string): OverlayTf {
  switch (tf) {
    case "1m": case "2m": return "M1";
    case "3m": case "4m": case "5m": case "6m": return "M5";
    case "10m": case "12m": case "15m": case "20m": return "M15";
    case "30m": return "M30";
    case "1h": case "2h": return "H1";
    case "3h": case "4h": case "6h": case "8h": case "12h": return "H4";
    case "1d": case "1w": case "1mo": return "D1";
    default: return "M5";
  }
}
function toAnnotationTf(tf: string): ChartAnnotationCreateRequestTimeframe {
  return toOverlayTf(tf);
}

// ── Smart Chart Layers (Task #197) — per-layer visibility toggles, persisted
//    across sessions. Defaults: everything visible. Keyed globally (not
//    per-symbol) so a trader's preference follows them between instruments.
type SmartLayerGroup =
  | "structure"
  | "signal_zones"
  | "targets"
  | "execution_cost"
  | "trade_health"
  | "news";

const SMART_LAYER_TOGGLES: { id: SmartLayerGroup; label: string }[] = [
  { id: "structure", label: "Structure" },
  { id: "signal_zones", label: "Signal zones" },
  { id: "targets", label: "TP / SL" },
  { id: "news", label: "Economic events" },
  { id: "execution_cost", label: "Execution cost" },
  { id: "trade_health", label: "Health" },
];

const LAYER_TOGGLE_KEY = "arx.smartChart.layerToggles.v1";

function loadLayerToggles(): Record<SmartLayerGroup, boolean> {
  const base: Record<SmartLayerGroup, boolean> = {
    structure: true,
    signal_zones: true,
    targets: true,
    execution_cost: true,
    trade_health: true,
    news: true,
  };
  if (typeof window === "undefined") return base;
  try {
    const raw = window.localStorage.getItem(LAYER_TOGGLE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Record<SmartLayerGroup, boolean>>;
    return { ...base, ...saved };
  } catch {
    return base;
  }
}

// Colour a layer by its semantic severity (never by an internal token).
function smartLayerColor(severity: string): string {
  switch (severity) {
    case "success": return "#10b981";
    case "danger": return "#ef4444";
    case "warning": return "#f59e0b";
    case "info": return "#38bdf8";
    default: return "#a1a1aa";
  }
}

// Map the chart's timeframe ids to the smart-layers contract enum.
function toSmartLayersTf(tf: string): GetMeChartSmartLayersTimeframe {
  return toOverlayTf(tf);
}

// Plain-English countdown for a news event (no internal token).
function formatCountdown(seconds: number): string {
  if (seconds <= 0 && seconds > -1800) return "live now";
  const abs = Math.abs(seconds);
  const m = Math.round(abs / 60);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  const span = h > 0 ? `${h}h ${rem}m` : `${m}m`;
  return seconds > 0 ? `in ${span}` : `${span} ago`;
}

// News severity → badge styling + human label. Critical/High additionally
// route to a toast alert; Medium/Low stay visual-only in the radar strip.
function newsSeverityStyle(sev: string): { cls: string; label: string } {
  switch (sev) {
    case "CRITICAL": return { cls: "border-danger/25 text-danger", label: "Critical" };
    case "HIGH": return { cls: "border-warning/25 text-warning", label: "High" };
    case "MEDIUM": return { cls: "border-ruby/25 text-ruby", label: "Medium" };
    default: return { cls: "border-border text-muted-foreground", label: "Low" };
  }
}

// News severity → chart-marker colour. Events that do NOT affect the selected
// symbol are deliberately de-emphasised to a muted grey so they read as context,
// not a call to action on this instrument.
function newsMarkerColor(sev: string, affectsSymbol: boolean): string {
  if (!affectsSymbol) return "#52525b"; // zinc-600 — de-emphasised context
  switch (sev) {
    case "CRITICAL": return "#ef4444";
    case "HIGH": return "#f59e0b";
    case "MEDIUM": return "#38bdf8";
    default: return "#a1a1aa";
  }
}

// Overlay-handshake status → badge styling (no internal token surfaced).
function handshakeBadgeStyle(status: string): string {
  switch (status) {
    case "PASS": return "border-success/25 text-success";
    case "WARN": return "border-warning/25 text-warning";
    case "BLOCK": return "border-danger/25 text-danger";
    default: return "border-border text-muted-foreground";
  }
}

// ScannerChartPanel — Phase 1 (container) + Phase 2 (real selected-symbol data)
//                      + Phase 3 (the logged-in user's own positions/pending orders)
//                      + Phase 4 (draggable Entry/SL/TP draft lines)
//                      + Phase 5/6 (chart trade actions, fully backend-gated).
//
// SAFETY:
//  - Real candles only via the single chart-truth endpoint /api/chart/candles
//    (through chartCandlesQuery). When the provider returns nothing we show an
//    honest empty state — we NEVER fabricate candles or fall back to
//    simulator/paper data.
//  - Position/pending overlays come ONLY from per-user endpoints
//    (/api/me/positions/all, /api/me/pending-order-drafts) which are scoped
//    server-side to the calling user. We never render master-account data.
//  - EVERY trade action (place / close / break-even / reverse) routes through
//    the Global Instant Trade Router (`executeInstantTrade`, source:"chart"),
//    which re-runs the same audited 23-gate evaluator + kill switch server-side
//    as one-click BUY/SELL. There is NO frontend-only trade path here and the
//    UI never bypasses a refusal — it surfaces the server's primaryReason.
//  - PAPER accounts get NO trade buttons (the instant router rejects paper);
//    we never render a dead/fake action for a mode the backend won't accept.
//  - The chart follows the global chart-symbol bus so picking a symbol in
//    Focus / Symbols / opportunity cards updates this chart in one paint.

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

// ── Feed-status truth contract ──────────────────────────────────────────────
// Resolver + types now live in the shared chart-display-status module so EVERY
// chart surface stays honest identically (Task #349). Behaviour is unchanged.

type ChartPosition = {
  scope: "demo" | "live";
  brokerTicket: string | null;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  lotSize: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  floatingPnl: number | null;
  accountMode: "DEMO" | "LIVE";
};

type ChartPending = {
  id: number;
  orderType: string | null;
  symbol: string;
  side: string;
  lotSize: number;
  entryPrice: number | null;
  stopTriggerPrice: number | null;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  pendingStatus: string | null;
  status: string;
};

// Normalised symbol compare — strips exchange prefixes/suffixes so "EURUSD",
// "FX:EURUSD" and "EURUSD.r" all match the same chart symbol.
function normSym(s: string | null | undefined): string {
  if (!s) return "";
  const bare = s.includes(":") ? s.split(":")[1]! : s;
  return bare.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// Phase 3 — compact timing status chip for the chart header. Advisory only,
// fail-open (absent when data unavailable). Never an execution gate.
function ChartTimingChip({ symbol }: { symbol: string }) {
  const q = useGetTimingBrain(symbol, undefined, {
    query: { queryKey: getGetTimingBrainQueryKey(symbol, undefined), refetchInterval: 30_000, staleTime: 20_000 },
  });
  const read = q.data as { timingGrade?: string; entryPermission?: string; heatScore?: number } | undefined;
  if (!read?.timingGrade || !read.entryPermission) return null;
  const permColor: Record<string, string> = {
    GO: "border-success/25 bg-success/10 text-success",
    WAIT_FOR_ENTRY: "border-warning/25 bg-warning/10 text-warning",
    WAIT_NEWS: "border-warning/25 bg-warning/10 text-warning",
    NO_TRADE: "border-danger/25 bg-danger/10 text-danger",
    STAND_DOWN: "border-danger/25 bg-danger/10 text-danger",
  };
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-[10px]", permColor[read.entryPermission] ?? "border-border text-txt-muted")}
      title={`Heat grade ${read.timingGrade} · ${read.entryPermission} (H:${read.heatScore ?? "?"}) — advisory only`}
      data-testid="scanner-chart-timing-chip"
    >
      <Flame className="h-2.5 w-2.5" />
      {read.timingGrade} · {read.entryPermission.replace(/_/g, " ")}
    </Badge>
  );
}

// Candle-close countdown chip (Task #524). HONESTY-GATED by the parent: it only
// mounts this when the feed is genuinely LIVE and a live (non-frozen) forming bar
// exists, so a frozen / stale / analysis feed shows nothing. It runs its OWN 1s
// ticker so the large chart panel does not re-render every second. `closeTimeMs`
// is the broker-aligned forming-bar close (openMs + interval) lifted straight
// from the SSE tip — never client calendar math, so 1D respects the broker's
// daily boundary and 1W the broker's weekly close.
function CandleCloseCountdown({
  closeTimeMs,
  timeframe,
}: {
  closeTimeMs: number;
  timeframe: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const remainingMs = closeTimeMs - nowMs;
  // Bar already closed; the next forming frame supplies the new close time.
  if (remainingMs <= 0) return null;
  return (
    <Badge
      variant="outline"
      className="gap-1 font-mono text-[10px] border-success/25 text-success"
      data-testid="scanner-chart-countdown"
      title="Time until the current candle closes"
    >
      <Clock className="h-2.5 w-2.5" />
      {formatCandleCountdown(remainingMs, timeframe)}
    </Badge>
  );
}

export function ScannerChartPanel() {
  const { name } = useAssistantName();
  const [chartSym] = useChartSymbol();
  const symbol = useMemo(() => bareSymbol(chartSym || "EURUSD").toUpperCase(), [chartSym]);

  // Graceful fallback (Task #524): a persisted / bus / deep-link timeframe outside
  // the nine visible chips coerces to FALLBACK_TIMEFRAME so the chart, the
  // highlighted chip, and the shared scanner truth never disagree. We also
  // normalise the bus itself (setTimeframe) so the other read-only consumers and
  // cross-tab listeners converge on the same value. ScannerChartPanel is the only
  // writer of this bus, so this can never fight another surface.
  const [rawTimeframe, setTimeframe] = useScannerTimeframe();
  const timeframe = coerceVisibleTimeframe(rawTimeframe);
  useEffect(() => {
    if (rawTimeframe !== timeframe) setTimeframe(timeframe);
  }, [rawTimeframe, timeframe, setTimeframe]);

  // ── Candles come from the ONE shared honest source (Task #391). This uses the
  //    same React Query key as useScannerTruth, so the chart, the header truth
  //    strip, and the read-gate all read identical candles + feedStatus from a
  //    single deduped network call — no parallel /api/chart/candles fetch, no
  //    independent freshness logic. Never the simulator quote.
  const apiTf = toApiTimeframe(timeframe);
  const candlesQuery = useQuery<ChartCandlesResult>({
    queryKey: chartCandlesQueryKey(symbol, apiTf, 200),
    queryFn: () => fetchChartCandles(symbol, apiTf, 200),
    enabled: symbol.length > 0,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
  const candles: Candle[] = candlesQuery.data?.candles ?? [];
  const feedStatus = (candlesQuery.data?.feedStatus as FeedStatus | undefined) ?? null;
  const loading = candlesQuery.isLoading;
  const error = candlesQuery.isError ? (candlesQuery.error instanceof Error ? candlesQuery.error.message : "Network error") : null;
  const hasCandles = candles.length > 0;

  // ── Deep history scroll-back (Task #438). Accumulates OLDER bars from
  //    GET /api/chart/history as the user pans left. View-only: this loads market
  //    data and never touches an execution path; the hook never fabricates a bar,
  //    and a provider ceiling is reported honestly via the history badge.
  const deepHistory = useChartDeepHistory(symbol, apiTf, hasCandles);

  // Older history bars (Candle ms shape) merged IN FRONT of the live window,
  // deduped by time with the live window winning a collision (it carries the
  // freshest forming bar). Both arrays already share the scanner Candle ms shape.
  const mergedCandles = useMemo<Candle[]>(() => {
    if (deepHistory.olderCandles.length === 0) return candles;
    const byTime = new Map<number, Candle>();
    for (const c of deepHistory.olderCandles) byTime.set(c.time, c);
    for (const c of candles) byTime.set(c.time, c); // live window wins
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }, [deepHistory.olderCandles, candles]);
  // Shared resolved truth — drives the live-price affordance so the chart can
  // never look more live/actionable than the header strip says it is.
  const { truth } = useScannerTruth(symbol, timeframe);

  // Canonical verdict for display convergence (Task #818). The chart derives a
  // single shared actionability verdict from the SAME lifted + data-only sources
  // as the header. This gates the Plan Buy/Plan Sell CTAs and is forwarded to
  // the Eleanor panel so every scanner surface converges on ONE verdict per
  // symbol/timeframe/read cycle. DISPLAY-ONLY — no execution gate.
  const chartActionStore = useSelectedActionStore();
  const rubyStore = useRubyReadStore();
  const liftedChartAction = chartActionStore.get(symbol, timeframe);
  const canonicalChartAction: ScannerActionabilityDisplay = resolveSelectedSymbolActionabilityDisplay(
    liftedChartAction,
    truth?.consolidated.scannerActionability ?? null,
  );
  // Eleanor-feed downgrade: if Eleanor's read is gated (withheld) for this
  // symbol+tf and the base verdict is READY_NOW, cap to WAIT_FOR_CONFIRMATION —
  // so the chart CTAs and the Eleanor panel never claim "ready" while Eleanor says
  // the feed is unconfirmed. Downgrade-only; no execution gate changes.
  const eleanorChartGated = rubyStore.get(symbol, timeframe)?.gated === true;
  const canonicalChartActionFinal: ScannerActionabilityDisplay = (
    eleanorChartGated && canonicalChartAction === "READY_NOW"
  ) ? "WAIT_FOR_CONFIRMATION" : canonicalChartAction;
  const canonicalChartUi = actionabilityDisplayUi(canonicalChartActionFinal);
  // canonicalChartDirection is derived from symbolVerdict (useSymbolTruth, declared
  // later in the component body). Assigned below after that hook is called.

  const [reloadAt, setReloadAt] = useState(0);

  // ── Structural trendline overlay (Task #670). SAME source as the ARX native
  //    chart: the backend Chart Intelligence `trendlineOverlay` verdict, already
  //    honesty-folded server-side (visible:false unless feed-confirmed + a real
  //    trendline was detected). NON-BLOCKING + contained: candles render
  //    regardless, and any error here never throws into render. We never compute
  //    geometry here — we only DRAW the server's already-decided lines/markers,
  //    re-gated below on the panel's own live-feed verdict.
  const intelligenceQuery = useGetMeChartIntelligence(
    { symbol, timeframe: apiTf as GetMeChartIntelligenceTimeframe, limit: 200 },
    {
      query: {
        queryKey: getGetMeChartIntelligenceQueryKey({ symbol, timeframe: apiTf as GetMeChartIntelligenceTimeframe, limit: 200 }),
        enabled: symbol.length > 0,
        refetchInterval: 8000,
        staleTime: 4000,
      },
    },
  );
  const trendlineOverlay = intelligenceQuery.data?.state?.trendlineOverlay ?? null;

  const [positions, setPositions] = useState<ChartPosition[]>([]);
  const [pending, setPending] = useState<ChartPending[]>([]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Chart instance handle, kept so the SEPARATE data effect can push candles +
  // shift the visible logical range (prepend preserve) without recreating the
  // chart. didFitRef makes the smart-initial-range run exactly once per rebuild.
  const chartApiRef = useRef<IChartApi | null>(null);
  const didFitRef = useRef(false);
  // Oldest bar currently merged (ISO) — cursor seed for the reach-start handler.
  // Held in a ref so the handler bound on the time scale always reads the latest.
  const oldestIsoRef = useRef<string | null>(null);
  // Previous oldest bar time (sec) used to compute how many bars were PREPENDED
  // so the visible logical range can be shifted to keep the user's view fixed.
  const prevOldestSecRef = useRef<number | null>(null);
  // Newest bar time (sec) currently in the series. The real-time forming-tip SSE
  // (Task #496) only ever calls series.update() with a time >= this value, so a
  // late/out-of-order tick can never throw lightweight-charts' ordering error.
  const newestBarSecRef = useRef<number | null>(null);
  // Latest deepHistory.loadOlder, held in a ref so the reach-start handler (bound
  // ONCE per chart rebuild) always calls the CURRENT closure. The hook recreates
  // loadOlder when `hasMore` flips to false; without this ref a stale closure
  // would keep firing back-page fetches after history is exhausted.
  const loadOlderRef = useRef(deepHistory.loadOlder);
  useEffect(() => {
    loadOlderRef.current = deepHistory.loadOlder;
  }, [deepHistory.loadOlder]);
  const seriesRef = useRef<{ priceToCoordinate: (p: number) => number | null; coordinateToPrice: (c: number) => number | null } | null>(null);
  // Real candlestick series handle used for incremental price-line overlays.
  // Kept separate from `seriesRef` (coordinate-conversion shape only) so the
  // position/pending price lines can be redrawn WITHOUT recreating the chart.
  const lineSeriesRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  // Last-known price stamp (Task #524). Separate from priceLinesRef so the
  // muted dotted axis label survives independently of the draft/overlay lines.
  const lastKnownLineRef = useRef<IPriceLine | null>(null);
  // News event markers (Task #197). lightweight-charts v5 surfaces markers via
  // the standalone createSeriesMarkers(series, markers) plugin (the v4
  // series.setMarkers() was removed). We keep the plugin handle so events can be
  // re-drawn without recreating the chart, and detach it on rebuild.
  const newsMarkersApiRef = useRef<ReturnType<typeof createSeriesMarkers> | null>(null);
  // Structural trendline overlay handles (Task #670). Detected trendlines /
  // channel rails draw on their OWN diagonal line series + a marker channel,
  // kept here so they can be cleared/redrawn without recreating the chart and
  // detached on rebuild (symbol/timeframe switch) so structure from instrument A
  // never bleeds onto B. Drawn through the SHARED applyStructureLines routine so
  // it can never diverge from the ARX native chart's structure path.
  const structureHandlesRef = useRef<StructureLinesHandles>(EMPTY_STRUCTURE_HANDLES);
  // Bumped each time the chart is (re)created so the overlay effect re-draws
  // its price lines onto the fresh series after a candle/symbol rebuild.
  const [chartEpoch, setChartEpoch] = useState(0);

  // Forming-bar close time (epoch ms) lifted from the SSE tick-stream for the
  // candle-close countdown (Task #524). null whenever there is no live forming
  // bar (frozen / silent / no tip yet). The ref mirrors the state so the SSE
  // handler only triggers a re-render on an actual interval rollover (a new
  // closeTimeMs), not on every incoming tick.
  const [formingCloseMs, setFormingCloseMs] = useState<number | null>(null);
  const formingCloseRef = useRef<number | null>(null);
  // Market-frozen / closed-market indicator (display/telemetry only). Driven by
  // the tick-stream `feed_status` event, whose verdict is derived from the
  // latest tick's BROKER-time staleness (calendar-independent). null = not
  // frozen (or no tick seen yet → assert nothing).
  const [marketFrozen, setMarketFrozen] = useState<{ lastBrokerTimeMs: number | null } | null>(
    null,
  );

  // ── Phase 4 — draggable draft-order lines (Entry/SL/TP).
  //    These are purely a *proposal* the user shapes by dragging; nothing
  //    fires on drag. Phase 5/6 turn the draft into a real gated action.
  const [draft, setDraft] = useState<{ side: "BUY" | "SELL"; entry: number; sl: number; tp: number } | null>(null);
  const [handleY, setHandleY] = useState<{ entry: number | null; sl: number | null; tp: number | null }>({ entry: null, sl: null, tp: null });
  const dragKeyRef = useRef<"entry" | "sl" | "tp" | null>(null);

  // ── Phase 5/6 — chart trade actions. EVERY action below routes through the
  //    Global Instant Trade Router (source:"chart"); the backend re-runs the
  //    full 23-gate evaluator + kill switch + per-user allocation. We never
  //    place, close, or modify anything client-side and never bypass a refusal.
  const mode = useTradingMode();
  // INVESTOR accounts are view-only and route-contained out of the scanner,
  // but we ALSO suppress every chart command-menu action + the AI-alert scan
  // for them here as defence-in-depth: the backend product-role gate refuses
  // investor mutations (annotations + scan), so showing those controls would
  // be dead buttons / 403 loops. Read-only role => read-only chart.
  const { isInvestor } = useProductRole();
  const { toast } = useToast();

  // Map the unified account mode to the only two modes the instant router
  // accepts. PAPER is intentionally unmapped — paper has no real broker path,
  // so we render NO trade buttons rather than a dead/fake action.
  const tradeMode: "live" | "demo" | null = mode.isLiveShared
    ? "live"
    : mode.isDemo
      ? "demo"
      : null;
  const canTrade =
    tradeMode != null &&
    resolveLiveActionCapabilities({
      canManualTrade: mode.canManualTrade,
      isFrozen: mode.isFrozen,
    }).canOpen;

  // Honest, NON-BLOCKING feed-truth note for the chart trade controls. Uses the
  // SAME resolved scanner-truth as the header/result rows, so a chart trade can
  // never be planned while implying the price is live when it is not. This warns
  // only — it never disables Confirm and never gates the 23-gate server pipeline.
  const chartAffordance = resolveTradeAffordance(
    truth,
    tradeMode === "live" ? "live" : tradeMode === "demo" ? "demo" : "read_only",
  );

  const [lot, setLot] = useState<string>("0.01");
  const [busy, setBusy] = useState<string | null>(null);

  // ── Chart Brain v2 Task 6 — per-user chart annotations (marked S/R levels,
  //    watch zones, user price alerts). These are read-only decision-support
  //    artifacts: they can never move price, fire a trade, or read another
  //    user's data. We render the active set as price lines and let the user
  //    create/dismiss them from the role-aware command menu.
  const queryClient = useQueryClient();
  const annotationsQuery = useGetMeChartAnnotations(
    { symbol },
    { query: { queryKey: getGetMeChartAnnotationsQueryKey({ symbol }), refetchInterval: 30_000 } },
  );
  const annotations: ChartAnnotation[] = annotationsQuery.data?.annotations ?? [];
  const invalidateAnnotations = () =>
    void queryClient.invalidateQueries({
      queryKey: getGetMeChartAnnotationsQueryKey({ symbol }),
    });
  const createAnnotation = usePostMeChartAnnotation({
    mutation: {
      onSuccess: () => {
        invalidateAnnotations();
        toast({ title: "Marked on chart", description: "Saved to your chart notes." });
      },
      onError: () =>
        toast({ title: "Could not save", description: "Please try again.", variant: "destructive" }),
    },
  });
  const dismissAnnotation = useDeleteMeChartAnnotation({
    mutation: { onSuccess: () => invalidateAnnotations() },
  });

  // ── Smart Chart Layers & Market Impact Radar (Task #197). Read-only,
  //    advisory overlays: Ruby's structure / zone / target geometry, an
  //    economic-event radar, an honest news-behavior note, and an overlay
  //    handshake. This NEVER places, modifies, or gates a trade. News is real
  //    or honestly absent — the service never fabricates an event as real.
  const [layerToggles, setLayerToggles] = useState<Record<SmartLayerGroup, boolean>>(loadLayerToggles);
  const toggleLayer = (id: SmartLayerGroup) =>
    setLayerToggles((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { window.localStorage.setItem(LAYER_TOGGLE_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
      return next;
    });

  const smartLayersParams = { symbol, timeframe: toSmartLayersTf(timeframe) };
  const smartLayersQuery = useGetMeChartSmartLayers(smartLayersParams, {
    query: {
      queryKey: getGetMeChartSmartLayersQueryKey(smartLayersParams),
      refetchInterval: 45_000,
    },
  });
  const smartData = smartLayersQuery.data ?? null;
  const smartLayers: SmartChartLayer[] = smartData?.layers ?? [];
  // Task #515 — the chart's NEWS state (event markers, high-impact toasts, and
  // the Impact Radar strip) now comes from the ONE per-symbol Truth Snapshot, so
  // the chart can never disagree with the scanner rows or the Ruby read on the
  // same page. The smart-layers query above still drives the NON-news overlays
  // (structure, exec-cost, trade-health) and the overlay handshake below.
  const { news, verdict: symbolVerdict } = useSymbolTruth(symbol, timeframe);
  // Directional CTA label for Plan Buy/Sell and the Eleanor button. Derived here
  // (after symbolVerdict is available) and forwarded to child surfaces so they all
  // agree on the same direction without independent bias lookups.
  const canonicalChartDirection: ActionDirection = biasToActionDirection(symbolVerdict?.bias);
  // Re-run the overlay handshake on the CLIENT with the live chart facts: the
  // real chart-bus symbol and whether candles are actually loaded. The server
  // computes a data-side handshake assuming the chart is rendered for the
  // requested symbol; this recompute catches a symbol mismatch (chart shows X
  // while the overlay was built for Y) and a not-yet-loaded chart, using the
  // same pure domain builder so the two can never disagree.
  const handshake: SmartChartOverlayHandshake | null = useMemo(() => {
    if (!smartData) return null;
    const hi = smartData.handshakeInputs;
    const genMs = smartData.signal?.generatedAt
      ? Date.parse(smartData.signal.generatedAt)
      : NaN;
    const overlayAgeMs = Number.isFinite(genMs)
      ? Math.max(0, Date.now() - genMs)
      : null;
    return buildOverlayHandshake({
      chartLoaded: candles.length > 0,
      chartSymbol: symbol,
      signalSymbol: hi.signalSymbol ?? null,
      signalExists: hi.signalExists,
      hasSufficientData: hi.hasSufficientData,
      levelCount: hi.levelCount,
      newsMapped: hi.newsMapped,
      overlayAgeMs,
    });
  }, [smartData, candles.length, symbol]);
  const reservedLayers = useMemo(() => smartLayers.filter((l) => l.reserved), [smartLayers]);
  // The overlay handshake badge must defer to a neutral "unavailable" label
  // while the smart-layer query is degraded (errored / refetch-failed). React
  // Query keeps the last successful `smartData` around during a refetch error,
  // so without this gate a stale PASS handshake would keep reading "verified"
  // even though the layers feed is down. Display-only; no execution concern.
  const overlayDegraded = smartLayersQuery.isError;

  // ── Live Trade Health (Task #198) — active, per-user post-entry overlays for
  //    the symbol on the chart. READ-ONLY; the endpoint returns honest empty
  //    when there are no open positions on this symbol (never fabricated).
  const tradeHealthParams = { chartSymbol: symbol };
  const tradeHealthQuery = useGetMeTradeHealth(tradeHealthParams, {
    query: {
      queryKey: getGetMeTradeHealthQueryKey(tradeHealthParams),
      refetchInterval: 20_000,
    },
  });
  const tradeHealthOverlays: SmartChartLayer[] =
    tradeHealthQuery.data?.overlays ?? [];

  // ── Derive the honest display status for this chart render.
  //    The shared scanner-truth (useScannerTruth) is the SINGLE resolved state:
  //    it already folds in feedStatus, per-timeframe min-candle gating AND the
  //    header-ok cap, so the chart consumes truth.displayStatus directly and can
  //    never disagree with the header strip / read-gate. rawDisplayStatus is only
  //    a transient fallback while truth is still loading (Task #391).
  const rawDisplayStatus = resolveDisplayStatus(feedStatus, candles.length > 0);
  const displayStatus = truth?.displayStatus ?? rawDisplayStatus;
  // The live-price affordance (last-value/price-line label, marker) is gated
  // through the shared helper so every chart surface decides "may I look live?"
  // identically (Task #351).
  const isLiveDisplay = isLivePriceDisplay(displayStatus);

  // The user's own alert preferences govern whether a high-impact news event is
  // allowed to interrupt with a toast. Market-condition news routes through the
  // "Market condition alerts" category + quiet hours; CRITICAL safety-level
  // events can never be silenced (mirrors the Alert Preferences page rule).
  const alertPrefsQuery = useGetAlertPreferences();
  const alertPrefs = alertPrefsQuery.data ?? null;
  const alertPrefsLoaded = alertPrefsQuery.isSuccess;

  // Dedicated price-line ref so smart layers never collide with the
  // position/pending overlay set; reset alert dedupe per symbol below.
  const smartLayerLinesRef = useRef<IPriceLine[]>([]);
  const newsAlertedRef = useRef<Set<string>>(new Set());

  // ── Chart command menu — opens on right-click (desktop) or long-press
  //    (touch) over the chart at the price under the pointer. Trade entries are
  //    DRAFT-ONLY and only render when `canTrade`; mark/alert entries are safe
  //    for any user who can reach the scanner.
  const [menu, setMenu] = useState<ChartCommandAnchor | null>(null);
  const longPressRef = useRef<number | null>(null);
  const [, setLocation] = useLocation();

  // ── Chart Brain v2 Task 6 — read-only "Ruby read" result overlay. Filled by
  //    the menu's Ask-Ruby / agent-disagreement actions (read-only endpoints).
  type RubyReadView = {
    title: string;
    headline?: string;
    points?: string[];
    cautions?: string[];
    bestNextAction?: string;
    consensus?: { headline?: string; note?: string } | null;
  };
  const [rubyRead, setRubyRead] = useState<RubyReadView | null>(null);
  const [rubyBusy, setRubyBusy] = useState(false);

  const priceAtClientY = (clientY: number): number | null => {
    const s = seriesRef.current;
    const el = containerRef.current;
    if (!s || !el) return null;
    const rect = el.getBoundingClientRect();
    const price = s.coordinateToPrice(clientY - rect.top);
    if (price == null || !Number.isFinite(price) || price <= 0) return null;
    return Number(price);
  };

  const openMenuAt = (clientX: number, clientY: number) => {
    // View-only investors get no command menu (all its actions are backend-
    // refused mutations). Read-only role => read-only chart.
    if (isInvestor) return;
    const el = containerRef.current;
    const price = priceAtClientY(clientY);
    if (!el || price == null) return;
    const rect = el.getBoundingClientRect();
    setMenu({ x: clientX - rect.left, y: clientY - rect.top, price });
  };

  // ── Chart Brain v2 Task 6 — AI-aware alert scan. While the user views a
  //    chart we periodically ask the backend to evaluate real chart-intelligence
  //    state transitions + the user's own price-alert annotations and fire any
  //    new alerts through the existing notification system (deduped + expiring +
  //    role-aware server-side). This NEVER trades. The loop pauses on a hidden
  //    tab (RQ's hidden-tab pause covers queries, not this POST), and on a new
  //    alert we invalidate the bell's unread-count so the badge updates.
  const scanAiAlerts = usePostMeChartAiAlertsScan({
    mutation: {
      onSuccess: () => {
        invalidateAnnotations();
        void queryClient.invalidateQueries({ queryKey: getGetAlertUnreadCountQueryKey() });
      },
    },
  });
  const scanRef = useRef(scanAiAlerts);
  scanRef.current = scanAiAlerts;
  useEffect(() => {
    if (!symbol) return;
    // INVESTOR accounts are view-only — the backend refuses the scan POST, so
    // never start the loop for them (no 403 spin).
    if (isInvestor) return;
    const tf = toAnnotationTf(timeframe);
    const runScan = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (scanRef.current.isPending) return;
      scanRef.current.mutate({ data: { symbol, timeframe: tf } });
    };
    runScan();
    const id = window.setInterval(runScan, 30_000);
    return () => window.clearInterval(id);
  }, [symbol, timeframe, isInvestor]);

  // Honest live-command outcome as reported by the broker via the EA. A
  // non-null `brokerTicket` is ONLY ever set on a real MT5 LIVE_FILLED, so the
  // UI can gate the word "executed" on a genuine broker ticket.
  type LiveCommandStatus = {
    status: string | null;
    commandType?: string | null;
    brokerTicket?: string | null;
    fillPrice?: number | null;
    mt5Retcode?: number | null;
    brokerMessage?: string | null;
    rejectionReason?: string | null;
    // Task #402 — real close-evidence verdict for CLOSE commands (null for
    // non-close). A terminal-success status is NOT proof a close happened.
    closeConfirmed?: boolean | null;
    closeConfirmationReason?: string | null;
  };

  // Poll the REAL MT5 outcome for a dispatched live command and update the
  // toast in place. Critically: ARX accepting + dispatching a command to the
  // bridge is NOT execution. We only say "executed" once MT5 returns a real
  // broker ticket; otherwise we surface the real rejection, or stay honestly
  // "pending" if MT5 has not confirmed within the window. We never fabricate a
  // fill and never imply execution from a mere dispatch.
  const trackLiveOutcome = async (
    label: string,
    commandId: string,
    handle: ReturnType<typeof toast>,
  ) => {
    const deadline = Date.now() + 15_000;
    let delay = 700;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay + 400, 2500);
      let s: LiveCommandStatus | null = null;
      try {
        const r = await fetch(
          `/api/me/live/command-status/${encodeURIComponent(commandId)}`,
          { credentials: "include" },
        );
        if (r.ok) s = (await r.json()) as LiveCommandStatus;
      } catch {
        // transient network error — keep polling until the deadline
      }
      if (!s || !s.status) continue;
      // Only declare execution on a genuine broker-confirmed terminal success:
      // a LIVE_FILLED carrying a real broker ticket, or a LIVE_CLOSED (the
      // close leg's confirmed terminal state). Never from a mere dispatch.
      const terminalSuccess =
        (s.status === "LIVE_FILLED" && s.brokerTicket) || s.status === "LIVE_CLOSED";
      if (terminalSuccess) {
        // Task #402 — for a CLOSE command a terminal-success status (incl. a
        // retcode-10009 LIVE_FILLED) is NOT proof the position closed. The
        // backend resolves real close evidence (`closeConfirmed`): only when it
        // is true do we tell the user the position is closed. A phantom close
        // (terminal-success but closeConfirmed !== true) is held as pending —
        // never reported as done — and keeps polling.
        if (s.commandType === "CLOSE_LIVE_POSITION" && s.closeConfirmed !== true) {
          // keep waiting — evidence has not confirmed the close yet
        } else {
          handle.update({
            id: handle.id,
            title: `${label} executed`,
            description: `MT5 confirmed${
              s.brokerTicket ? ` — ticket #${s.brokerTicket}` : ""
            }${s.fillPrice ? ` @ ${s.fillPrice}` : ""}.`,
          });
          return;
        }
      }
      if (
        s.status === "LIVE_REJECTED" ||
        s.status === "LIVE_FAILED" ||
        s.status === "LIVE_EXPIRED"
      ) {
        const reason = humanizeReason(s.rejectionReason || s.brokerMessage || s.status);
        handle.update({
          id: handle.id,
          variant: "destructive",
          title: `${label} rejected by MT5`,
          description: reason.description,
        });
        return;
      }
      // still LIVE_DRAFT / LIVE_CONFIRMED / SENT_TO_MT5_LIVE → keep waiting
    }
    // No terminal MT5 outcome within the window — stay honest: pending, not
    // executed. The final result will still land in the live command ledger.
    handle.update({
      id: handle.id,
      title: `${label}: still pending`,
      description:
        "MT5 has not confirmed execution yet. Check Open Live Positions or Trade Logs for the final result.",
    });
  };

  // Single, honest result surface — we relay the server's verdict verbatim
  // (its primaryReason on refusal) and never invent a success. On acceptance,
  // ARX has only dispatched the command to the bridge; for live commands we
  // then poll MT5 for the genuine execution/rejection outcome.
  const relay = (label: string, res: InstantTradeResponse) => {
    if (!res.ok) {
      // Humanise the gate code so the chart banner reads in plain English
      // (e.g. LIVE_ONE_CLICK_DISABLED → "ARX Single Confirm (live) is off …")
      // rather than surfacing the raw technical code to the user.
      const h = humanizeReason(res.primaryReason || res.error);
      toast({ variant: "destructive", title: `${label} blocked`, description: h.description });
      return;
    }
    if (tradeMode === "live" && res.commandId) {
      const handle = toast({
        title: `${label} sent to bridge`,
        description: "Waiting for MT5 to confirm execution…",
      });
      void trackLiveOutcome(label, res.commandId, handle);
      return;
    }
    // Demo / non-tracked path: acknowledge the dispatch honestly without
    // implying the broker has executed anything.
    toast({
      title: `${label} sent to bridge`,
      description: "Waiting for MT5 to confirm execution.",
    });
  };

  // Place the dragged draft as a real market order (entry tracks the live
  // price for a market order; SL/TP come from the dragged lines).
  const placeDraft = async () => {
    if (!draft || !tradeMode) return;
    const volume = Number(lot);
    if (!Number.isFinite(volume) || volume <= 0) {
      toast({ variant: "destructive", title: "Invalid lot size", description: "Enter a positive lot size." });
      return;
    }
    setBusy("place");
    try {
      const res = await executeInstantTrade({
        source: "chart",
        action: draft.side,
        accountMode: tradeMode,
        symbol,
        volume,
        stopLoss: draft.sl,
        takeProfit: draft.tp,
        oneClick: true,
      });
      relay(`${draft.side} ${symbol}`, res);
      if (res.ok) {
        setDraft(null);
        setReloadAt(Date.now());
      }
    } catch (e) {
      toast({ variant: "destructive", title: "Order failed", description: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusy(null);
    }
  };

  const closePosition = async (p: ChartPosition, fraction: number) => {
    if (!p.brokerTicket || !tradeMode) return;
    const key = `close:${p.brokerTicket}:${fraction}`;
    setBusy(key);
    try {
      const partial = fraction < 1 && p.lotSize != null && p.lotSize > 0;
      const res = await executeInstantTrade({
        source: "chart",
        action: "CLOSE",
        accountMode: tradeMode,
        positionId: p.brokerTicket,
        ...(partial ? { volume: Math.max(0.01, Number((p.lotSize! * fraction).toFixed(2))) } : {}),
        oneClick: true,
      });
      relay(partial ? "Partial close" : "Close", res);
      if (res.ok) setReloadAt(Date.now());
    } catch (e) {
      toast({ variant: "destructive", title: "Close failed", description: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusy(null);
    }
  };

  const breakEven = async (p: ChartPosition) => {
    if (!p.brokerTicket || !tradeMode || p.entryPrice == null) return;
    const key = `be:${p.brokerTicket}`;
    setBusy(key);
    try {
      const res = await executeInstantTrade({
        source: "chart",
        action: "MODIFY_SL_TP",
        accountMode: tradeMode,
        positionId: p.brokerTicket,
        newStopLoss: p.entryPrice,
        newTakeProfit: p.takeProfit ?? null,
      });
      relay("Break-even", res);
      if (res.ok) setReloadAt(Date.now());
    } catch (e) {
      toast({ variant: "destructive", title: "Modify failed", description: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusy(null);
    }
  };

  // Reverse is NOT atomic — there is no single REVERSE backend command. We
  // close the current position, and only if the gated close succeeds do we
  // open the opposite side. Both legs are independently gated; we tell the
  // user honestly that it's a two-step sequence.
  const reversePosition = async (p: ChartPosition) => {
    if (!p.brokerTicket || !tradeMode || !p.side || p.lotSize == null) return;
    const key = `rev:${p.brokerTicket}`;
    setBusy(key);
    try {
      const closeRes = await executeInstantTrade({
        source: "chart",
        action: "CLOSE",
        accountMode: tradeMode,
        positionId: p.brokerTicket,
        oneClick: true,
      });
      if (!closeRes.ok) {
        relay("Reverse (close leg)", closeRes);
        return;
      }
      const opposite = p.side === "BUY" ? "SELL" : "BUY";
      const openRes = await executeInstantTrade({
        source: "chart",
        action: opposite,
        accountMode: tradeMode,
        symbol: p.symbol ?? symbol,
        volume: p.lotSize,
        oneClick: true,
      });
      if (openRes.ok) {
        toast({ title: "Reverse complete", description: `Closed ${p.side}, opened ${opposite} (two gated steps).` });
      } else {
        toast({ variant: "destructive", title: "Reverse partial", description: `Closed ${p.side}, but the ${opposite} leg was blocked: ${humanizeReason(openRes.primaryReason || openRes.error).description}` });
      }
      setReloadAt(Date.now());
    } catch (e) {
      toast({ variant: "destructive", title: "Reverse failed", description: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusy(null);
    }
  };

  // Pending-order cancel — the real per-user draft delete endpoint (the
  // canonical cancel path used across the app; the instant router has no
  // cancel-pending action). Still per-user gated server-side and only shown
  // when the account is in a real (live/demo) trade mode via `canTrade`.
  const cancelPending = async (id: number) => {
    if (!canTrade) return;
    const key = `cancel:${id}`;
    setBusy(key);
    try {
      const r = await fetch(u(`/api/me/pending-order-draft/${id}`), { method: "DELETE", credentials: "include" });
      if (r.ok) {
        toast({ title: "Pending order cancelled" });
        setReloadAt(Date.now());
      } else {
        let reason = `HTTP ${r.status}`;
        try {
          const body = (await r.json()) as { primaryReason?: string; error?: string; message?: string };
          reason = body.primaryReason || body.error || body.message || reason;
        } catch { /* keep HTTP status fallback */ }
        toast({ variant: "destructive", title: "Cancel blocked", description: humanizeReason(reason).description });
      }
    } catch (e) {
      toast({ variant: "destructive", title: "Cancel failed", description: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusy(null);
    }
  };

  // Candle fetching is handled by the shared `candlesQuery` (useQuery) above —
  // the single honest source. No parallel fetch here (Task #391).

  // ── Phase 3 — fetch the logged-in user's own positions + pending orders.
  //    Both endpoints are per-user scoped server-side. Polls every 10s and
  //    pauses while the tab is hidden.
  useEffect(() => {
    let cancelled = false;
    const loadOwned = async () => {
      try {
        const [posRes, penRes] = await Promise.all([
          fetch(u("/api/me/positions/all"), { credentials: "include" }).then((r) => (r.ok ? r.json() : null)),
          fetch(u("/api/me/pending-order-drafts"), { credentials: "include" }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (cancelled) return;
        const live = Array.isArray(posRes?.live) ? (posRes.live as ChartPosition[]) : [];
        const demo = Array.isArray(posRes?.demo) ? (posRes.demo as ChartPosition[]) : [];
        setPositions([...live, ...demo]);
        const drafts = Array.isArray(penRes?.drafts) ? (penRes.drafts as ChartPending[]) : [];
        setPending(drafts.filter((d) => d.status !== "cancelled" && d.pendingStatus !== "CANCELLED"));
      } catch {
        if (!cancelled) {
          setPositions([]);
          setPending([]);
        }
      }
    };
    void loadOwned();
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (id == null) id = setInterval(loadOwned, 10_000); };
    const stop = () => { if (id != null) { clearInterval(id); id = null; } };
    const onVis = () => { if (document.hidden) stop(); else { void loadOwned(); start(); } };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [reloadAt]);

  const symbolPositions = useMemo(
    () => positions.filter((p) => normSym(p.symbol) === normSym(symbol)),
    [positions, symbol],
  );
  const symbolPending = useMemo(
    () => pending.filter((p) => normSym(p.symbol) === normSym(symbol)),
    [pending, symbol],
  );

  // ── Create the candlestick chart ONCE per (symbol, timeframe). Decoupled from
  //    the candle data (Task #438): rebuilding on every 15s poll used to reset
  //    the user's zoom/scroll AND would discard accumulated deep history. The
  //    SEPARATE data effect below pushes bars incrementally with setData, which
  //    preserves the visible range. We only recreate when the symbol/timeframe
  //    changes, or when the FIRST candles arrive (hasCandles flips true once).
  //    Mirrors the proven PositionMiniChart lightweight-charts v5 pattern.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !hasCandles) return;
    el.innerHTML = "";

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 360,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#a1a1aa",
        fontSize: 11,
        // ARX-native renderer: suppress the lightweight-charts TradingView
        // attribution logo so no third-party watermark sits on our chart.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(63, 63, 70, 0.25)" },
        horzLines: { color: "rgba(63, 63, 70, 0.25)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: "rgba(63, 63, 70, 0.5)",
        // Phase 2: keep the forming bar from clipping against the price axis.
        rightOffset: 8,
        lockVisibleTimeRangeOnResize: false,
      },
      rightPriceScale: {
        borderColor: "rgba(63, 63, 70, 0.5)",
        // Phase 2: autoScale ensures the y-axis fits only visible candles,
        // eliminating the compressed-flat-line symptom on H4/D1 views where a
        // distant outlier forces a giant price range.
        autoScale: true,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    });

    // lightweight-charts v5: series are created with addSeries(SeriesDefinition,
    // options). The legacy v4 `addCandlestickSeries()` was removed and throws at
    // runtime (it is undefined on the chart instance) — see the chart-lib note in
    // .agents/memory. Do NOT cast back to a synthetic addCandlestickSeries shape.
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
      // Display-truth (Task #347): the candlestick series draws its OWN last-price
      // line + last-value label by default, which reads as a live price marker.
      // Only allow it when the feed is genuinely LIVE; on any non-LIVE state
      // (stale/composite/analysis) stale candles must never carry a live marker.
      // A dedicated effect below re-applies this on status change without rebuild.
      priceLineVisible: isLiveDisplay,
      lastValueVisible: isLiveDisplay,
    });
    seriesRef.current = series as unknown as {
      priceToCoordinate: (p: number) => number | null;
      coordinateToPrice: (c: number) => number | null;
    };

    // Expose the real series + chart so the data + overlay effects can push bars
    // and add/remove price lines incrementally without recreating the chart.
    chartApiRef.current = chart;
    lineSeriesRef.current = series;
    priceLinesRef.current = [];
    // Fresh engine: the smart-initial-range must run once, and prepend tracking
    // restarts from a clean slate so the first data push fits rather than shifts.
    didFitRef.current = false;
    prevOldestSecRef.current = null;

    // ── Deep-history scroll-back: when the user pans near the oldest loaded bar,
    //    ask the history hook for the next OLDER page (seeded from the oldest bar
    //    currently on screen, read from a ref so this stays bound across pages).
    //    View-only — this loads market data, never a trade.
    const REACH_START_BARS = 20;
    const onRange = (range: { from: number } | null) => {
      if (range && range.from <= REACH_START_BARS) {
        // Call through the ref so an exhausted-history closure can't keep firing.
        loadOlderRef.current(oldestIsoRef.current);
      }
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    // Teardown guard: a ResizeObserver callback already queued before disconnect
    // can still fire after chart.remove(), and applyOptions on a removed chart
    // throws "Object is disposed" (DevicePixelContentBoxBinding → resizeCanvas),
    // which trips the SectionErrorBoundary on unmount/HMR. Short-circuit the
    // callback once disposed and wrap the dispose itself defensively.
    let disposed = false;
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        chart.applyOptions({ width: el.clientWidth });
      } catch { /* chart was removed mid-resize — nothing to size */ }
    });
    ro.observe(el);

    setChartEpoch((e) => e + 1);

    return () => {
      disposed = true;
      ro.disconnect();
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange); } catch { /* chart already removed */ }
      try { chart.remove(); } catch { /* already disposed */ }
      chartApiRef.current = null;
      seriesRef.current = null;
      lineSeriesRef.current = null;
      priceLinesRef.current = [];
    };
    // Chart is rebuilt ONLY when symbol/timeframe changes or the first candles
    // arrive — never on a routine poll. The reach-start handler calls
    // loadOlderRef.current (kept fresh by its own effect) so the latest
    // loadOlder — which no-ops once history is exhausted — always runs; the
    // oldest cursor comes from oldestIsoRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, apiTf, hasCandles]);

  // ── Push candle data into the EXISTING series WITHOUT recreating the chart.
  //    setData keeps the current visible bar-index range, so when older bars are
  //    PREPENDED the same bars shift right; we counter that by shifting the
  //    visible logical range left by the prepended count to keep the view fixed.
  //    On the first push after a rebuild we instead apply the smart initial range.
  useEffect(() => {
    const series = lineSeriesRef.current;
    const chart = chartApiRef.current;
    if (!series || !chart || mergedCandles.length === 0) return;

    // Drop any malformed bar (missing / null / NaN OHLC) before setData: the
    // lightweight-charts candlestick colorer reads bar color data during paint
    // via ensureNotNull and throws "Value is null" on the next repaint otherwise.
    const mapped = sanitizeCandlestickData(
      mergedCandles.map((c) => ({
        time: Math.floor(c.time / 1000) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    if (mapped.length === 0) return;

    const newOldestSec = mapped[0]!.time as number;
    oldestIsoRef.current = new Date(newOldestSec * 1000).toISOString();

    // How many bars were prepended since the last push (older bars added in front).
    let prependedCount = 0;
    const prevOldestSec = prevOldestSecRef.current;
    if (prevOldestSec != null && newOldestSec < prevOldestSec) {
      const idx = mapped.findIndex((b) => (b.time as number) >= prevOldestSec);
      prependedCount = idx > 0 ? idx : 0;
    }

    const before = chart.timeScale().getVisibleLogicalRange();
    series.setData(mapped);
    prevOldestSecRef.current = newOldestSec;
    // Track the newest bar time so the forming-tip SSE never calls update() with
    // an out-of-order time. The 15s poll above carries the authoritative closed
    // CANDLE (and, server-side, the current forming tip), so setData here both
    // reconciles the tip and replaces it with the closed bar — no orphan dup.
    newestBarSecRef.current = mapped[mapped.length - 1]!.time as number;

    if (!didFitRef.current) {
      // Phase 2 — smart initial visible range. Show the last N candles rather
      // than fitting the entire loaded history, so recent price action fills the
      // canvas readably instead of being compressed into a horizontal line.
      const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
      const defaultVisible = isMobile ? 80 : 150;
      if (mapped.length <= defaultVisible) {
        chart.timeScale().fitContent();
      } else {
        chart.timeScale().setVisibleRange({
          from: mapped[mapped.length - defaultVisible]!.time,
          to: mapped[mapped.length - 1]!.time,
        });
      }
      didFitRef.current = true;
    } else if (prependedCount > 0 && before) {
      // Keep the user's view anchored on the same bars by shifting the logical
      // range right by however many older bars were inserted in front.
      chart.timeScale().setVisibleLogicalRange({
        from: before.from + prependedCount,
        to: before.to + prependedCount,
      });
    }
  }, [mergedCandles, chartEpoch]);

  // ── Real-time forming-tip (Task #496). Subscribe to the server SSE tick-stream
  //    for the bus symbol + timeframe and apply each forming bar with
  //    series.update() — NOT setData — so the most-recent candle ticks in real
  //    time without repainting the chart (zoom/scroll preserved). The 15s poll
  //    above is demoted to a reconciliation safety net: it carries the
  //    authoritative closed bar and replaces the synthesized tip (no orphan dup).
  //
  //    HONESTY: we only apply a tip when the stream reports it is NOT frozen
  //    (ticks flowing within the live window) and the time is >= the newest bar,
  //    so a silent/stale stream can never keep a fake bar ticking. The payload is
  //    pure OHLC display telemetry — no execution path is touched here.
  useEffect(() => {
    // Reset the countdown whenever the stream key changes — the previous
    // symbol/timeframe's forming bar is no longer relevant (Task #524).
    formingCloseRef.current = null;
    setFormingCloseMs(null);
    setMarketFrozen(null);
    if (symbol.length === 0) return;
    const url = u(`/api/chart/tick-stream?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(apiTf)}`);
    let es: EventSource | null = null;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      return; // EventSource unavailable — the 15s poll still keeps the tip fresh.
    }
    es.onmessage = (ev) => {
      let msg: {
        type?: string;
        frozen?: boolean;
        tickWallMs?: number;
        marketFrozen?: boolean;
        lastBrokerTimeMs?: number | null;
        bar?: { openTimeMs?: number; closeTimeMs?: number; open?: number; high?: number; low?: number; close?: number };
      };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }
      // Market-frozen / closed-market indicator. Handled BEFORE the forming-bar
      // branch because it must surface even when there is no live tip (a frozen
      // broker quote is exactly the no-tip case).
      if (msg.type === "feed_status") {
        setMarketFrozen(
          msg.marketFrozen === true ? { lastBrokerTimeMs: msg.lastBrokerTimeMs ?? null } : null,
        );
        return;
      }
      if (msg.type !== "forming_bar") return;
      // Candle-close countdown (Task #524): track the forming bar's broker-aligned
      // close time. The server buckets openMs to the broker bar boundary and
      // reports closeTimeMs = openMs + interval, so D1/W1 honour the broker's
      // daily/weekly close — no client calendar math here. A frozen / barless
      // frame clears it so a silent feed shows NO countdown. setState only on an
      // actual rollover (a new closeTimeMs) to avoid a re-render per tick.
      if (msg.frozen || !msg.bar || typeof msg.bar.closeTimeMs !== "number") {
        if (formingCloseRef.current !== null) {
          formingCloseRef.current = null;
          setFormingCloseMs(null);
        }
      } else if (formingCloseRef.current !== msg.bar.closeTimeMs) {
        formingCloseRef.current = msg.bar.closeTimeMs;
        setFormingCloseMs(msg.bar.closeTimeMs);
      }
      // Series tip update — only for a live (non-frozen) forming bar.
      if (msg.frozen || !msg.bar) return;
      const series = lineSeriesRef.current;
      if (!series) return;
      // Task #496 latency addendum: measure ingest→browser latency from the
      // ingest-accept wall clock the server stamped on the tip. Reported in dev
      // for the acceptance run; the server path itself carries no batching delay.
      if (typeof msg.tickWallMs === "number" && import.meta.env.DEV) {
        const latencyMs = Date.now() - msg.tickWallMs;
        if (latencyMs >= 0) {
          // eslint-disable-next-line no-console
          console.debug(`[forming-tip] ingest→browser latency ≈ ${latencyMs}ms`);
        }
      }
      const b = msg.bar;
      // Use Number.isFinite (NOT typeof === "number") so a NaN/Infinity OHLC can
      // never reach series.update(): typeof NaN === "number" passes, but a NaN
      // bar becomes a whitespace point whose candlestick colorer throws
      // "Value is null" deep in lightweight-charts on the next repaint —
      // uncatchable here. This mirrors the chart-engine adapter's guard.
      if (
        typeof b.openTimeMs !== "number" || !Number.isFinite(b.openTimeMs) ||
        typeof b.open !== "number" || !Number.isFinite(b.open) ||
        typeof b.high !== "number" || !Number.isFinite(b.high) ||
        typeof b.low !== "number" || !Number.isFinite(b.low) ||
        typeof b.close !== "number" || !Number.isFinite(b.close)
      )
        return;
      const tipSec = Math.floor(b.openTimeMs / 1000);
      // Never feed an out-of-order time to lightweight-charts (it would throw).
      if (newestBarSecRef.current != null && tipSec < newestBarSecRef.current) return;
      series.update({
        time: tipSec as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      });
      newestBarSecRef.current = tipSec;
    };
    es.onerror = () => {
      // The browser auto-reconnects an EventSource; nothing to do. The poll
      // remains the reconciliation backstop while the stream is down.
    };
    return () => {
      es?.close();
    };
  }, [symbol, apiTf]);

  // ── Display-truth: keep the candlestick series' built-in last-price line +
  //    last-value label in lockstep with the live/non-live display status,
  //    WITHOUT rebuilding the chart (which would reset the user's zoom/scroll).
  //    headerOk flips on the 15s header poll, so applyOptions here — never a deps
  //    change on the chart-create effect — toggles the live marker honestly.
  useEffect(() => {
    const series = lineSeriesRef.current;
    if (!series) return;
    series.applyOptions({ priceLineVisible: isLiveDisplay, lastValueVisible: isLiveDisplay });
  }, [isLiveDisplay, chartEpoch]);

  // ── Phase 3 — overlay the user's own positions + pending orders as price
  //    lines. Runs on every positions/pending poll WITHOUT recreating the
  //    chart: it diffs by removing the previously-drawn lines and adding the
  //    current set onto the existing series.
  useEffect(() => {
    const series = lineSeriesRef.current;
    if (!series) return;

    for (const line of priceLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* line already gone */ }
    }
    priceLinesRef.current = [];

    const addLine = (price: number | null, color: string, title: string, dashed = false) => {
      if (price == null || !Number.isFinite(price) || price <= 0) return;
      priceLinesRef.current.push(
        series.createPriceLine({
          price,
          color,
          lineWidth: 2,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title,
        }),
      );
    };

    for (const p of symbolPositions) {
      const tag = p.accountMode === "LIVE" ? "LIVE" : "DEMO";
      const arrow = p.side === "BUY" ? "▲" : "▼";
      addLine(p.entryPrice, p.side === "BUY" ? "#3b82f6" : "#a855f7", `${tag} ${p.side ?? ""} ${arrow} Entry`);
      addLine(p.stopLoss, "#ef4444", `${tag} SL`, true);
      addLine(p.takeProfit, "#10b981", `${tag} TP`, true);
    }

    for (const o of symbolPending) {
      const entry = o.entryPrice ?? o.stopTriggerPrice ?? o.stopLimitPrice;
      addLine(entry, "#f59e0b", `Pending ${o.side} ${o.orderType ?? ""}`.trim(), true);
      addLine(o.stopLoss, "#ef4444", "Pending SL", true);
      addLine(o.takeProfit, "#10b981", "Pending TP", true);
    }

    // Chart Brain v2 Task 6 — the user's own marked levels / zones / price
    // alerts, drawn as price lines. Read-only overlay; never a trade trigger.
    for (const a of annotations) {
      if (a.kind === "SUPPORT") {
        addLine(a.price, "#22d3ee", `S ${a.note ?? ""}`.trim());
      } else if (a.kind === "RESISTANCE") {
        addLine(a.price, "#fb7185", `R ${a.note ?? ""}`.trim());
      } else if (a.kind === "PRICE_ALERT") {
        const dir = a.direction === "above" ? "↑" : a.direction === "below" ? "↓" : "";
        addLine(a.price, "#fbbf24", `Alert ${dir}`.trim(), true);
      } else if (a.kind === "WATCH_ZONE") {
        addLine(a.price, "#a78bfa", "Zone", true);
        addLine(a.priceTo, "#a78bfa", "Zone", true);
      }
    }
  }, [symbolPositions, symbolPending, annotations, chartEpoch]);

  // ── Smart Chart Layers (Task #197) — draw Ruby / structure / target geometry
  //    AND the live execution-cost overlay (expected-fill band + break-even line)
  //    as price lines on the existing series WITHOUT recreating the chart, via a
  //    dedicated line ref. Each group respects the user's per-layer toggle. News
  //    is time-based (rendered in the radar strip, not as a price line) and the
  //    reserved trade-health slot carries no live value yet, so neither is drawn
  //    here — both are surfaced honestly in the UI below.
  useEffect(() => {
    const series = lineSeriesRef.current;
    if (!series) return;
    for (const line of smartLayerLinesRef.current) {
      try { series.removePriceLine(line); } catch { /* line already gone */ }
    }
    smartLayerLinesRef.current = [];

    const add = (price: number | null | undefined, color: string, title: string, dashed: boolean) => {
      if (price == null || !Number.isFinite(price) || price <= 0) return;
      smartLayerLinesRef.current.push(
        series.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: false,
          title,
        }),
      );
    };

    for (const l of smartLayers) {
      if (l.reserved) continue; // reserved slots: no live value to draw yet
      if (l.group === "news") continue; // news is time-based → drawn as markers
      if (!layerToggles[l.group as SmartLayerGroup]) continue;
      const color = smartLayerColor(l.severity);
      const dashed = l.kind === "zone" || l.group === "signal_zones";
      if (l.kind === "zone") {
        add(l.priceFrom, color, l.label, dashed);
        add(l.priceTo, color, l.label, dashed);
      } else if (l.kind === "line") {
        add(l.price, color, l.label, dashed);
      }
    }

    // Live Trade Health (Task #198) — active per-position health markers at the
    // entry price, drawn as labelled price lines. Gated by the same toggle as
    // the reserved slot; honest empty when there are no open positions here.
    if (layerToggles.trade_health) {
      for (const l of tradeHealthOverlays) {
        if (l.reserved) continue;
        add(l.price, smartLayerColor(l.severity), l.label, true);
      }
    }
  }, [smartLayers, tradeHealthOverlays, layerToggles, chartEpoch]);

  // ── Economic event markers — events are time-based, so they are drawn as
  //    time-positioned markers on the candle series (not price lines). Events
  //    that affect the selected symbol are colour-coded by severity; unrelated
  //    events are muted grey so they read as context. Two honesty rules apply:
  //    (1) markers render ONLY when the chart's feed is CONFIRMED
  //    (isFeedConfirmedForEventMarkers below); and (2) only events inside the
  //    chart's current timeframe window are shown — out-of-range (far-future /
  //    pre-history) events are omitted, never clamped onto the edges.
  //    When no real events exist (no connected calendar) there is nothing to
  //    draw — we never invent a marker.
  useEffect(() => {
    const series = lineSeriesRef.current;
    if (!series) return;
    // Tear down any previous marker layer before redrawing.
    try { newsMarkersApiRef.current?.detach(); } catch { /* already detached */ }
    newsMarkersApiRef.current = null;
    if (!news || !layerToggles.news || candles.length === 0) return;
    // Honesty gate (Task #628): economic-event markers may only render when the
    // chart's own feed is CONFIRMED (LIVE or DELAYED/FALLBACK_COMPOSITE) — see
    // isFeedConfirmedForEventMarkers. On an unconfirmed feed we draw nothing.
    if (!isFeedConfirmedForEventMarkers(displayStatus)) return;

    const firstSec = Math.floor(candles[0]!.time / 1000);
    const lastSec = Math.floor(candles[candles.length - 1]!.time / 1000);
    // Timeframe window (Task #628): only events inside the chart's current window
    // are shown — loaded history [firstSec, lastSec] plus a forward look-ahead
    // sized to this timeframe's bar interval, so an upcoming high-impact event
    // (e.g. NFP) surfaces near the right edge while events far in the future — or
    // before the loaded history — are omitted (never clamped onto the edges, as
    // the old logic did). Windowing/anchoring lives in resolveEventMarkerSec.
    const windowEnd =
      lastSec + inferBarSeconds(candles.slice(-2).map((c) => c.time)) * NEWS_MARKER_LOOKAHEAD_BARS;
    // The ascending open-times (epoch seconds) of the candles ACTUALLY in the
    // series — sanitized identically to setData so a marker can only ever anchor
    // to a bar that exists. lightweight-charts throws "Value is null" if a marker
    // resolves to a missing bar (findBar → null), so every marker time below is
    // snapped onto one of these real bars.
    const candleSecsAsc = sanitizeCandlestickData(
      candles.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    ).map((c) => c.time as number);
    if (candleSecsAsc.length === 0) return;
    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const ev of news.events) {
      const windowedSec = resolveEventMarkerSec(
        Date.parse(ev.eventTimeIso),
        firstSec,
        lastSec,
        windowEnd,
      );
      if (windowedSec == null) continue; // no real time, or outside the chart window
      const markerSec = snapSecToCandle(windowedSec, candleSecsAsc);
      if (markerSec == null) continue; // no real bar to anchor to
      const t = markerSec as UTCTimestamp;
      const { label } = newsSeverityStyle(ev.severity);
      markers.push({
        time: t,
        position: "aboveBar",
        color: newsMarkerColor(ev.severity, ev.affectsSymbol),
        shape: ev.affectsSymbol ? "arrowDown" : "circle",
        text: `${ev.currency} ${label}`,
      });
    }
    if (markers.length === 0) return;
    // lightweight-charts requires markers sorted ascending by time.
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    newsMarkersApiRef.current = createSeriesMarkers(series, markers);
    // Deterministic teardown: detach the marker layer on unmount / re-run so the
    // plugin handle never outlives the series it was attached to.
    return () => {
      try { newsMarkersApiRef.current?.detach(); } catch { /* already detached */ }
      newsMarkersApiRef.current = null;
    };
  }, [news, layerToggles.news, candles, displayStatus, chartEpoch]);

  // ── Structural trendline overlay (Task #670). Mirrors the ARX native chart's
  //    structure effect 1:1 so users see the SAME detected trendlines / channel
  //    rails on the Scanner page where they spend most analysis time. The lines
  //    come from the backend Chart Intelligence `trendlineOverlay` verdict
  //    (already honesty-folded server-side) and are DOUBLE-GATED here:
  //      (1) overlay.visible — the server confirmed a real trendline on a
  //          confirmed feed; and
  //      (2) isLiveDisplay — the panel's own resolved feed verdict says the
  //          chart is showing live/affordable prices.
  //    When either gate is false we CLEAR the structural channel (also covers
  //    symbol/timeframe switch via chartEpoch, so structure from instrument A
  //    never bleeds onto B). Drawn through the SHARED applyStructureLines routine
  //    — the exact same drawing path the adapter uses — so the two charts can
  //    never diverge. Display-only: adds no trade affordance, no execution path.
  useEffect(() => {
    const chart = chartApiRef.current;
    const series = lineSeriesRef.current;
    if (!chart || !series) return;

    const overlay = trendlineOverlay;
    const mayDraw = overlay != null && overlay.visible && isLiveDisplay;

    if (!mayDraw || !overlay) {
      clearStructureLines(chart, structureHandlesRef.current);
      structureHandlesRef.current = EMPTY_STRUCTURE_HANDLES;
      return;
    }

    const lineColor = (bias: string): string =>
      bias === "bullish" ? "#22c55e" : bias === "bearish" ? "#ef4444" : "#94a3b8";
    const markerColor = (kind: string): string =>
      kind === "break"
        ? "#ef4444"
        : kind === "reclaim"
          ? "#22c55e"
          : kind === "retest"
            ? "#f59e0b"
            : "#94a3b8";

    const lines: ChartStructureLine[] = overlay.lines.map((ln) => ({
      id: ln.id,
      start: { time: ln.start.time, price: ln.start.price },
      end: { time: ln.end.time, price: ln.end.price },
      color: lineColor(ln.bias),
      // Channel rails (id suffixed ":rail") draw dashed so they read as the
      // parallel boundary, not a second primary trendline.
      dashed: ln.id.endsWith(":rail"),
      width: ln.dominant ? 2 : 1,
    }));

    // Snap every structure marker onto a real bar present in the series. The
    // engine intends bar-anchored times, but a marker whose time doesn't EXACTLY
    // match a loaded bar makes lightweight-charts' findBar() return null and the
    // candlestick colorer throw "Value is null" on repaint — so we enforce
    // bar-membership here against the SAME sanitized open-times fed to setData,
    // rather than trusting the upstream alignment.
    const structureCandleSecs = sanitizeCandlestickData(
      candles.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    ).map((c) => c.time as number);
    const markers: ChartStructureMarker[] = structureCandleSecs.length === 0
      ? []
      : overlay.markers.flatMap((m) => {
          const snapped = snapSecToCandle(m.time, structureCandleSecs);
          if (snapped == null) return [];
          return [{
            time: snapped,
            // Anchor side by bias (support breaks below, resistance above); the
            // dot sits on the bar — never at an arbitrary price (engine rule).
            position: m.bias === "bullish" ? "belowBar" : "aboveBar",
            color: markerColor(m.kind),
            label: m.label,
          } satisfies ChartStructureMarker];
        });

    structureHandlesRef.current = applyStructureLines(
      chart,
      series,
      lines,
      markers,
      structureHandlesRef.current,
    );
    // Deterministic teardown: clear the structural overlay on unmount / re-run so
    // its series + marker layer never outlive the chart they were drawn onto.
    return () => {
      clearStructureLines(chartApiRef.current, structureHandlesRef.current);
      structureHandlesRef.current = EMPTY_STRUCTURE_HANDLES;
    };
    // isLiveDisplay carries the panel's resolved feed verdict; chartEpoch re-runs
    // this after a chart rebuild so structure is redrawn onto the fresh series
    // and cleared across a symbol/timeframe switch. `candles` MUST be a dep: the
    // markers above are snapped onto the bars in the series at draw time, and the
    // poll's setData slides the fixed-size window forward (oldest bars roll off) —
    // a marker left anchored to a dropped bar makes lightweight-charts' findBar()
    // return null and the candlestick colorer throw "Value is null" on the next
    // repaint (uncatchable here), which crashed the Scanner page when the chart
    // sat open across candle refreshes. Re-running on every candle window keeps
    // every anchor on a real bar.
  }, [trendlineOverlay, isLiveDisplay, chartEpoch, candles]);

  // News alert routing — Critical/High events that are imminent or live AND
  // affect this symbol raise a toast (Critical = destructive). Medium/Low stay
  // visual-only in the radar strip. Deduped per event+state so the 45s poll
  // never spams; the dedupe set resets when the chart symbol changes.
  //
  // Alert-preference routing (mirrors the Alert Preferences page rule):
  //  - CRITICAL events always interrupt — live-risk events cannot be silenced.
  //  - HIGH events interrupt only when the user keeps "Market condition alerts"
  //    on AND is not inside their quiet-hours window.
  //  - MEDIUM/LOW never interrupt — they stay visual-only in the radar strip and
  //    on the chart markers.
  useEffect(() => {
    if (!news || !layerToggles.news) return;
    const hourUtc = new Date().getUTCHours();
    const quiet = isWithinQuietHoursUtc(alertPrefs?.quietHoursStart, alertPrefs?.quietHoursEnd, hourUtc);
    for (const ev of news.events) {
      // CRITICAL always interrupts; HIGH only when prefs are LOADED + market
      // alerts on + outside quiet hours; MEDIUM/LOW stay visual-only. Gating on
      // alertPrefsLoaded (not a permissive default) prevents a stray HIGH toast
      // during the preferences load race.
      const shouldToast = newsToastDecision({
        severity: ev.severity,
        state: ev.state,
        affectsSymbol: ev.affectsSymbol,
        prefsLoaded: alertPrefsLoaded,
        marketAlertsEnabled: alertPrefs?.marketAlertsEnabled ?? false,
        quietHoursActive: quiet,
      });
      if (!shouldToast) continue;
      const key = `${ev.id}:${ev.state}`;
      if (newsAlertedRef.current.has(key)) continue;
      newsAlertedRef.current.add(key);
      toast({
        title: ev.state === "LIVE" ? `High-impact news live: ${ev.title}` : `High-impact news soon: ${ev.title}`,
        description: `${ev.currency} • ${formatCountdown((Date.parse(ev.eventTimeIso) - Date.now()) / 1000)} • spreads can widen — manage risk.`,
        variant: ev.severity === "CRITICAL" ? "destructive" : "default",
      });
    }
  }, [news, layerToggles.news, alertPrefs, alertPrefsLoaded, toast]);

  // A news alert is symbol-specific — clear the dedupe set on symbol change.
  useEffect(() => { newsAlertedRef.current = new Set(); }, [symbol]);

  const lastClose = candles.length > 0 ? candles[candles.length - 1]!.close : null;

  // ── Last-known price stamp (Task #524). The series' built-in last-value label
  //    + price line (toggled in the effect above) ONLY render when the feed is
  //    genuinely LIVE. In every non-live state that still has candles we stamp
  //    the LAST-KNOWN close on the right price axis — muted, dotted, and titled
  //    "last-known" — so the axis is never blank and a stale price is never
  //    styled as a live tick. UNAVAILABLE (no usable candles) shows nothing.
  //    Re-runs on chartEpoch so it re-draws onto a freshly rebuilt series.
  useEffect(() => {
    const series = lineSeriesRef.current;
    if (!series) return;
    if (lastKnownLineRef.current) {
      try {
        series.removePriceLine(lastKnownLineRef.current);
      } catch {
        /* line belonged to a now-destroyed series — ignore */
      }
      lastKnownLineRef.current = null;
    }
    if (!isLiveDisplay && lastClose != null && displayStatus !== "UNAVAILABLE" && candles.length > 0) {
      lastKnownLineRef.current = series.createPriceLine({
        price: lastClose,
        color: "#a1a1aa", // zinc-400 — deliberately NOT the live blue last-value
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "last-known",
      });
    }
  }, [isLiveDisplay, lastClose, displayStatus, candles.length, chartEpoch]);

  // ── Phase 4 — reposition the draggable handles to track the price scale
  //    (zoom / scroll / resize). Runs only while a draft is active.
  useEffect(() => {
    if (!draft) { setHandleY({ entry: null, sl: null, tp: null }); return; }
    // `stopped` (not just clearTimeout) is required: clearTimeout can't cancel a
    // requestAnimationFrame that the fired timeout already scheduled, and that
    // orphaned tick would re-arm the loop forever after cleanup.
    let stopped = false;
    let raf = 0;
    const tick = () => {
      if (stopped) return;
      const s = seriesRef.current;
      if (s) {
        setHandleY({
          entry: s.priceToCoordinate(draft.entry),
          sl: s.priceToCoordinate(draft.sl),
          tp: s.priceToCoordinate(draft.tp),
        });
      }
      raf = window.setTimeout(() => requestAnimationFrame(tick), 60) as unknown as number;
    };
    tick();
    return () => { stopped = true; window.clearTimeout(raf); };
  }, [draft]);

  // ── Phase 4 — pointer drag: convert Y → price via coordinateToPrice.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const key = dragKeyRef.current;
      const s = seriesRef.current;
      const el = containerRef.current;
      if (!key || !s || !el) return;
      const rect = el.getBoundingClientRect();
      const y = ev.clientY - rect.top;
      const price = s.coordinateToPrice(y);
      if (price == null || !Number.isFinite(price) || price <= 0) return;
      setDraft((d) => (d ? { ...d, [key]: Number(price) } : d));
    };
    const onUp = () => { dragKeyRef.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  // Clear an in-progress draft whenever the chart symbol changes — a draft is
  // symbol-specific and must never carry over to a different instrument.
  useEffect(() => { setDraft(null); }, [symbol]);

  // ── Task #764 — drag-to-modify SL/TP for the user's OWN open LIVE positions.
  //    This is NOT a second execution path: a drop routes through the SAME
  //    executeInstantTrade(source:"chart_drag", MODIFY_SL_TP) → /instant/execute
  //    → executeModify → createLiveOpsDraft → confirm → 23-gate dispatch as the
  //    existing chart Break-even button. Entry is shown but NEVER draggable. A
  //    submit is allowed only on a confirmed-LIVE feed (isLiveDisplay); one-click
  //    ON submits on drop, OFF shows an old-vs-new confirm step.
  const [posModify, setPosModify] = useState<{
    ticket: string;
    side: "BUY" | "SELL";
    entry: number;
    sl: number | null;
    tp: number | null;
    origSl: number | null;
    origTp: number | null;
  } | null>(null);
  const [modifyArmed, setModifyArmed] = useState(false);
  const posDragKeyRef = useRef<"sl" | "tp" | null>(null);
  const [posHandleY, setPosHandleY] = useState<{ entry: number | null; sl: number | null; tp: number | null }>({ entry: null, sl: null, tp: null });

  // One-click arming status — same source + queryKey as OneClickArmedBadge so the
  // chart and the badge can never disagree about whether a drop auto-submits.
  const oneClickStatusQuery = useQuery({
    queryKey: ["one-click-status"],
    queryFn: async () => {
      const r = await fetch(u("/api/me/one-click/status"), { credentials: "include" });
      if (!r.ok) return { armed: false } as { armed?: boolean };
      return (await r.json().catch(() => ({ armed: false }))) as { armed?: boolean };
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const oneClickArmed = oneClickStatusQuery.data?.armed === true;

  // Latest-value refs so the once-mounted pointer-up handler reads fresh state
  // instead of a stale closure (mirrors the draft drag infra).
  const posModifyRef = useRef(posModify);
  const oneClickArmedRef = useRef(oneClickArmed);
  const isLiveDisplayRef = useRef(isLiveDisplay);
  const canTradeRef = useRef(canTrade);
  useEffect(() => { posModifyRef.current = posModify; }, [posModify]);
  useEffect(() => { oneClickArmedRef.current = oneClickArmed; }, [oneClickArmed]);
  useEffect(() => { isLiveDisplayRef.current = isLiveDisplay; }, [isLiveDisplay]);
  useEffect(() => { canTradeRef.current = canTrade; }, [canTrade]);

  const startPosModify = (p: ChartPosition) => {
    // Live-only + must have a confirmed broker ticket + a usable entry/side.
    if (p.accountMode !== "LIVE" || !p.brokerTicket || p.entryPrice == null || p.side == null) return;
    setDraft(null); // only one shaping interaction at a time
    setModifyArmed(false);
    posDragKeyRef.current = null;
    setPosModify({
      ticket: p.brokerTicket,
      side: p.side,
      entry: p.entryPrice,
      sl: p.stopLoss,
      tp: p.takeProfit,
      origSl: p.stopLoss,
      origTp: p.takeProfit,
    });
  };
  const cancelPosModify = () => {
    setPosModify(null);
    setModifyArmed(false);
    posDragKeyRef.current = null;
  };

  // Submit a candidate SL/TP through the SANCTIONED modify pipeline. relay()
  // reuses the same honest pending/outcome tracking as every other chart action.
  const submitModify = async (m: NonNullable<typeof posModify>) => {
    // Honesty chokepoint: re-check the confirmed-LIVE feed AND live-trading
    // entitlement at SEND time, not just on drop. Both can change between the drag
    // and a later Confirm click (feed goes unconfirmed/frozen; entitlement is
    // revoked / account frozen), so this single chokepoint guards BOTH the
    // one-click drop path and the confirm button. Backend gates still block
    // dispatch — this is defence-in-depth + an honest UI lock.
    if (!canTradeRef.current) {
      setModifyArmed(false);
      toast({ variant: "destructive", title: "Adjust SL/TP blocked", description: "Live trading isn't available on this account right now, so SL/TP changes can't be sent." });
      return;
    }
    if (!isLiveDisplayRef.current) {
      setModifyArmed(false);
      toast({ variant: "destructive", title: "Adjust SL/TP blocked", description: "The live price feed isn't confirmed right now, so SL/TP changes can't be sent. Try again once the feed is live." });
      return;
    }
    setModifyArmed(false);
    setBusy(`modify:${m.ticket}`);
    try {
      const res = await executeInstantTrade({
        source: "chart_drag",
        action: "MODIFY_SL_TP",
        accountMode: "live",
        positionId: m.ticket,
        newStopLoss: m.sl,
        newTakeProfit: m.tp,
      });
      relay("Adjust SL/TP", res);
      if (res.ok) {
        setPosModify(null);
        setReloadAt(Date.now());
      }
    } catch (e) {
      toast({ variant: "destructive", title: "Adjust SL/TP failed", description: e instanceof Error ? e.message : "Network error" });
    } finally {
      setBusy(null);
    }
  };

  // Runs on pointer-up after a leg drag. Honesty gate (confirmed-LIVE feed) +
  // side/min-distance validation happen here BEFORE anything is sent.
  const handleModifyDrop = () => {
    const m = posModifyRef.current;
    if (!m) return;
    if (!isLiveDisplayRef.current) {
      toast({ variant: "destructive", title: "Adjust SL/TP blocked", description: "The live price feed isn't confirmed right now, so SL/TP changes can't be sent. Try again once the feed is live." });
      return;
    }
    const v = validateModifyLevels({ side: m.side, entry: m.entry, newStopLoss: m.sl, newTakeProfit: m.tp });
    if (!v.ok) {
      toast({ variant: "destructive", title: "Invalid level", description: v.reason ?? "Adjust the line and try again." });
      return;
    }
    if (oneClickArmedRef.current) void submitModify(m);
    else setModifyArmed(true);
  };
  // dropHandlerRef stays fresh every render so the once-mounted pointerup
  // listener never calls a stale submit closure.
  const dropHandlerRef = useRef(handleModifyDrop);
  useEffect(() => { dropHandlerRef.current = handleModifyDrop; });

  // Reposition the SL/TP handles to track zoom/scroll/resize (mirrors draft).
  useEffect(() => {
    if (!posModify) { setPosHandleY({ entry: null, sl: null, tp: null }); return; }
    // Same orphan-loop guard as the draft tracker above: a rAF the fired timeout
    // already scheduled survives clearTimeout, so `stopped` kills the loop.
    let stopped = false;
    let raf = 0;
    const tick = () => {
      if (stopped) return;
      const s = seriesRef.current;
      if (s) {
        setPosHandleY({
          entry: s.priceToCoordinate(posModify.entry),
          sl: posModify.sl != null ? s.priceToCoordinate(posModify.sl) : null,
          tp: posModify.tp != null ? s.priceToCoordinate(posModify.tp) : null,
        });
      }
      raf = window.setTimeout(() => requestAnimationFrame(tick), 60) as unknown as number;
    };
    tick();
    return () => { stopped = true; window.clearTimeout(raf); };
  }, [posModify]);

  // Pointer drag for the SL/TP legs: Y → price; drop runs the validated submit.
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const key = posDragKeyRef.current;
      const s = seriesRef.current;
      const el = containerRef.current;
      if (!key || !s || !el) return;
      const rect = el.getBoundingClientRect();
      const price = s.coordinateToPrice(ev.clientY - rect.top);
      if (price == null || !Number.isFinite(price) || price <= 0) return;
      setModifyArmed(false); // a fresh drag invalidates a pending confirm
      setPosModify((m) => (m ? { ...m, [key]: Number(price) } : m));
    };
    const onUp = () => {
      if (!posDragKeyRef.current) return;
      posDragKeyRef.current = null;
      dropHandlerRef.current();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  // A modify is symbol-specific — clear it when the chart symbol changes.
  useEffect(() => { setPosModify(null); setModifyArmed(false); }, [symbol]);

  const startDraft = (side: "BUY" | "SELL", at?: number) => {
    const base = at ?? lastClose ?? (candles.length > 0 ? candles[candles.length - 1]!.close : 0);
    if (!base || base <= 0) return;
    setPosModify(null); // only one shaping interaction at a time
    const pad = base * 0.0015;
    setDraft(
      side === "BUY"
        ? { side, entry: base, sl: base - pad, tp: base + pad * 2 }
        : { side, entry: base, sl: base + pad, tp: base - pad * 2 },
    );
  };

  // ── Chart command-menu actions. Plan = draft only (no order placed here);
  //    mark/alert = create a per-user annotation. All backend-validated.
  const menuPlan = (side: "BUY" | "SELL", price: number) => {
    if (!canTrade) return; // defence-in-depth: menu already hides these
    startDraft(side, price);
  };
  const menuMarkLevel = (kind: ChartAnnotationCreateRequestKind, price: number) => {
    createAnnotation.mutate({
      data: { symbol, timeframe: toAnnotationTf(timeframe), kind, price },
    });
  };
  const menuPriceAlert = (direction: "above" | "below", price: number) => {
    createAnnotation.mutate({
      data: { symbol, timeframe: toAnnotationTf(timeframe), kind: "PRICE_ALERT", direction, price },
    });
  };

  // Watch zone — a per-user read-only band around the clicked price. WATCH_ZONE
  // requires priceTo; we build a small symmetric band from the click.
  const menuWatchZone = (price: number) => {
    const pad = Math.max(price * 0.001, 0);
    createAnnotation.mutate({
      data: {
        symbol,
        timeframe: toAnnotationTf(timeframe),
        kind: "WATCH_ZONE",
        price,
        priceTo: price + pad,
      },
    });
  };

  // Adjust an EXISTING draft's invalidation (SL) or take-profit (TP) to the
  // clicked price. Local draft only — no order is placed; the real order still
  // routes through the gated instant-trade path on confirm.
  const menuSetDraftLevel = (kind: "SL" | "TP", price: number) => {
    if (!canTrade) return;
    setDraft((d) => (d ? { ...d, [kind === "SL" ? "sl" : "tp"]: price } : d));
  };

  // Ask Ruby (read-only) about the chart at this candle/level. Routes ONLY
  // through the read-only assistant draft-read endpoint — never trades.
  const menuAskRuby = async (intent: RubyChartIntent, _price: number) => {
    setRubyBusy(true);
    try {
      const r = await fetch(u("/api/me/assistant/draft-read"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ symbol, timeframe: toAnnotationTf(timeframe), intent }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { draftRead?: Record<string, unknown> };
      const dr = j.draftRead ?? {};
      const consensusRaw = dr["agentConsensus"] as Record<string, unknown> | undefined;
      setRubyRead({
        title:
          intent === "agent-consensus"
            ? `Agent view — ${symbol}`
            : `${name} read — ${symbol}`,
        headline: typeof dr["headline"] === "string" ? (dr["headline"] as string) : undefined,
        points: Array.isArray(dr["points"]) ? (dr["points"] as string[]) : [],
        cautions: Array.isArray(dr["cautions"]) ? (dr["cautions"] as string[]) : [],
        bestNextAction:
          typeof dr["bestNextAction"] === "string" ? (dr["bestNextAction"] as string) : undefined,
        consensus: consensusRaw
          ? {
              headline:
                typeof consensusRaw["headline"] === "string"
                  ? (consensusRaw["headline"] as string)
                  : undefined,
              note:
                typeof consensusRaw["note"] === "string"
                  ? (consensusRaw["note"] as string)
                  : undefined,
            }
          : null,
      });
    } catch (e) {
      toast({
        title: `${name} read failed`,
        description: e instanceof Error ? e.message : "network error",
        variant: "destructive",
      });
    } finally {
      setRubyBusy(false);
    }
  };

  // Save an immutable decision receipt for the current symbol/timeframe (Task 5
  // surface). Read-only memory write — never trades.
  const menuShowReceipt = async () => {
    setRubyBusy(true);
    try {
      const r = await fetch(u("/api/me/chart/decision-receipt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          symbol,
          timeframe: toAnnotationTf(timeframe),
          intent: "analyze",
          source: "chart_read",
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast({
        title: "Decision receipt saved",
        description: `An immutable read of ${symbol} (${timeframe}) was recorded.`,
      });
    } catch (e) {
      toast({
        title: "Could not save receipt",
        description: e instanceof Error ? e.message : "network error",
        variant: "destructive",
      });
    } finally {
      setRubyBusy(false);
    }
  };

  // Replay from here — opens the market-replay learning surface for this symbol.
  const menuReplay = () => {
    setLocation(`/market-replay?symbol=${encodeURIComponent(symbol)}`);
  };

  // Replay/learning posture: PAPER (no live/demo trade mode engaged) is the
  // review surface; in an active trade mode we keep the quick menu focused.
  const isReviewMode = tradeMode == null;

  const decimals = (() => {
    const sample = lastClose ?? draft?.entry ?? 1;
    return sample < 10 ? 5 : sample < 1000 ? 3 : 2;
  })();
  const fmt = (n: number) => n.toFixed(decimals);

  return (
    <Card data-testid="scanner-chart-panel" className="rounded-2xl border-border bg-card">
      <CardHeader className="py-3">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2">
            <CandlestickChart className="h-4 w-4 text-primary" />
            <span data-testid="scanner-chart-symbol" className="text-base font-semibold text-foreground">
              {symbol}
            </span>
            {lastClose != null && isLiveDisplay && (
              <Badge variant="outline" className="font-mono text-xs" data-testid="scanner-chart-last">
                {lastClose}
              </Badge>
            )}
            {lastClose != null && !isLiveDisplay && displayStatus !== "UNAVAILABLE" && (
              <Badge variant="outline" className="font-mono text-xs text-txt-muted" data-testid="scanner-chart-last-stale" title="Last-known candle close — not a live price">
                {lastClose} <span className="ml-1 text-[9px] uppercase tracking-wide">last-known</span>
              </Badge>
            )}
            {/* Feed-status badge — honest state of the data feed. Single-sourced
                through the shared ChartFeedStatusBadge (Task #510) so the rendered
                Scanner badge can never drift from the canonical feed-status copy /
                state mapping. Copy is FIXED per resolved display state and never
                reuses feedStatus.message / .warning (a clean upstream response can
                phrase those as "Live feed active … (mt5_broker)", which would
                contradict a capped non-LIVE surface and leak a source token —
                Task #347). */}
            <ChartFeedStatusBadge
              status={displayStatus}
              hasCandles={candles.length > 0}
              testIdPrefix="scanner-chart"
              trailingIntervals={candlesQuery.data?.feedStatus?.trailingIntervals}
            />
            {/* Market-frozen / closed-market indicator (display/telemetry only).
                Derived from the latest tick's BROKER-time staleness via the
                tick-stream `feed_status` event, so a still-forming bar reads as
                closed-market, not a broken feed. Calendar-independent. */}
            {marketFrozen && (
              <Badge
                variant="outline"
                className="flex items-center gap-1 border-warning/25 bg-warning/10 text-[10px] text-warning"
                data-testid="scanner-chart-market-closed"
                title="The broker is replaying its last quote — the market is closed (derived from real tick broker-time staleness, not a calendar)."
              >
                <Clock className="h-3 w-3" /> {formatMarketClosedLabel(marketFrozen.lastBrokerTimeMs)}
              </Badge>
            )}
            {/* Candle-close countdown (Task #524). Honesty-gated: only when the
                feed is genuinely LIVE and a live forming bar has reported its
                broker-aligned close time. The child owns its own 1s ticker. */}
            {formingCloseMs != null && isLiveDisplay && (
              <CandleCloseCountdown closeTimeMs={formingCloseMs} timeframe={timeframe} />
            )}
            {hasCandles && (
              <ChartHistoryBadge
                loading={deepHistory.loading}
                hasMore={deepHistory.hasMore}
                providerCapped={deepHistory.providerCapped}
                limitationReason={deepHistory.limitationReason}
                coverageDays={deepHistory.coverageDays}
                depthTargetDays={deepHistory.depthTargetDays}
                loadedAny={deepHistory.loadedAny}
              />
            )}
            {symbolPositions.length > 0 && (
              <Badge variant="outline" className="border-primary/25 text-[10px] text-primary" data-testid="scanner-chart-pos-count">
                {symbolPositions.length} position{symbolPositions.length > 1 ? "s" : ""}
              </Badge>
            )}
            {symbolPending.length > 0 && (
              <Badge variant="outline" className="border-warning/25 text-[10px] text-warning" data-testid="scanner-chart-pending-count">
                {symbolPending.length} pending
              </Badge>
            )}
            {/* Phase 3 — timing overlay chip (advisory, fail-open) */}
            <ChartTimingChip symbol={symbol} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {PRIMARY_TIMEFRAMES.map((tf) => (
              <Button
                key={tf.id}
                size="sm"
                variant={timeframe === tf.id ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setTimeframe(tf.id);
                }}
                data-testid={`scanner-chart-tf-${tf.id}`}
              >
                {tf.label}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={candlesQuery.isFetching}
              onClick={() => { void candlesQuery.refetch(); setReloadAt(Date.now()); }}
              title="Reload candles"
              data-testid="scanner-chart-reload"
            >
              {candlesQuery.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {candles.length === 0 ? (
          <div
            data-testid="scanner-chart-empty"
            className="flex h-[360px] flex-col items-center justify-center rounded-md border border-border bg-background/50 text-center text-xs text-txt-muted"
          >
            {loading ? (
              <>
                <Loader2 className="mb-2 h-5 w-5 animate-spin" />
                Loading candles for <span className="font-mono">{symbol}</span>…
              </>
            ) : (
              <>
                <CandlestickChart className="mb-2 h-6 w-6 opacity-40" />
                <div>
                  No live candles for <span className="font-mono">{symbol}</span> right now.
                </div>
                {/* Surface the backend's own honest cause so a synthetic-feed
                    outage (e.g. "connect MetaTrader 5"), a stale feed, and a
                    provider error read differently — never fabricated. */}
                {(feedStatus?.warning ?? feedStatus?.message) && (
                  <div className="mt-1 max-w-md text-muted-foreground">{feedStatus?.warning ?? feedStatus?.message}</div>
                )}
                {error && <div className="mt-1 text-warning/80">Feed: {error}</div>}
                <div className="mt-1 text-txt-muted">
                  We don't fabricate data — pick another symbol or connect your broker feed.
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative" style={{ height: 360 }}>
              <div
                ref={containerRef}
                data-testid="scanner-chart-canvas"
                className="h-full w-full overflow-hidden rounded-md border border-border bg-background/50"
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenuAt(e.clientX, e.clientY);
                }}
                onPointerDown={(e) => {
                  // Long-press (touch/pen) opens the command menu. Mouse uses
                  // the native context menu above; skip it here to avoid a
                  // double-trigger on right-click.
                  if (e.pointerType === "mouse") return;
                  const { clientX, clientY } = e;
                  if (longPressRef.current) window.clearTimeout(longPressRef.current);
                  longPressRef.current = window.setTimeout(() => openMenuAt(clientX, clientY), 450) as unknown as number;
                }}
                onPointerUp={() => {
                  if (longPressRef.current) { window.clearTimeout(longPressRef.current); longPressRef.current = null; }
                }}
                onPointerMove={() => {
                  if (longPressRef.current) { window.clearTimeout(longPressRef.current); longPressRef.current = null; }
                }}
              />
              {menu && (
                <ChartCommandMenu
                  anchor={menu}
                  canTrade={canTrade}
                  hasDraft={draft != null}
                  isReviewMode={isReviewMode}
                  fmt={fmt}
                  busy={createAnnotation.isPending || rubyBusy}
                  onPlan={menuPlan}
                  onMarkLevel={(k, p) => menuMarkLevel(k, p)}
                  onWatchZone={menuWatchZone}
                  onPriceAlert={menuPriceAlert}
                  onSetDraftLevel={menuSetDraftLevel}
                  onAskRuby={menuAskRuby}
                  onShowReceipt={menuShowReceipt}
                  onReplay={menuReplay}
                  onClose={() => setMenu(null)}
                />
              )}
              {rubyRead && (
                <div
                  className="absolute right-2 top-2 z-30 w-72 max-w-[calc(100%-1rem)] max-h-[320px] overflow-y-auto rounded-md border border-border bg-background/95 p-3 text-xs shadow-xl backdrop-blur"
                  data-testid="scanner-chart-ruby-read"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-semibold text-premium">{rubyRead.title}</span>
                    <button
                      type="button"
                      className="rounded p-0.5 text-txt-muted hover:text-foreground"
                      onClick={() => setRubyRead(null)}
                      aria-label="Close"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {rubyRead.consensus?.headline && (
                    <div className="mb-1 text-primary">{rubyRead.consensus.headline}</div>
                  )}
                  {rubyRead.consensus?.note && (
                    <div className="mb-1 text-muted-foreground">{rubyRead.consensus.note}</div>
                  )}
                  {rubyRead.headline && (
                    <div className="mb-1 text-foreground">{rubyRead.headline}</div>
                  )}
                  {rubyRead.points && rubyRead.points.length > 0 && (
                    <ul className="mb-1 list-disc space-y-0.5 pl-4 text-txt-secondary">
                      {rubyRead.points.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  )}
                  {rubyRead.cautions && rubyRead.cautions.length > 0 && (
                    <ul className="mb-1 list-disc space-y-0.5 pl-4 text-warning/90">
                      {rubyRead.cautions.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                  {rubyRead.bestNextAction && (
                    <div className="mt-1 border-t border-border pt-1 text-success">
                      {rubyRead.bestNextAction}
                    </div>
                  )}
                  <div className="mt-1 text-[10px] text-txt-muted">
                    Read-only — {name} never places a trade.
                  </div>
                </div>
              )}
              {draft && (
                <div className="pointer-events-none absolute inset-0" data-testid="scanner-chart-draft-overlay">
                  {(["entry", "sl", "tp"] as const).map((key) => {
                    const y = handleY[key];
                    if (y == null) return null;
                    const color = key === "entry" ? "#3b82f6" : key === "sl" ? "#ef4444" : "#10b981";
                    const label = key === "entry" ? `${draft.side} Entry` : key.toUpperCase();
                    const value = draft[key];
                    return (
                      <div
                        key={key}
                        className="pointer-events-auto absolute left-0 right-12 flex -translate-y-1/2 cursor-ns-resize items-center"
                        style={{ top: y }}
                        data-testid={`scanner-chart-handle-${key}`}
                        onPointerDown={(e) => {
                          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                          dragKeyRef.current = key;
                        }}
                      >
                        <div className="h-0 w-full border-t-2 border-dashed" style={{ borderColor: color }} />
                        <span
                          className="ml-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shadow"
                          style={{ backgroundColor: color }}
                        >
                          {label} {fmt(value)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {posModify && (
                <div className="pointer-events-none absolute inset-0" data-testid="scanner-chart-modify-overlay">
                  {(["entry", "sl", "tp"] as const).map((key) => {
                    const y = posHandleY[key];
                    if (y == null) return null;
                    const value = key === "entry" ? posModify.entry : key === "sl" ? posModify.sl : posModify.tp;
                    if (value == null) return null;
                    const color = key === "entry" ? "#3b82f6" : key === "sl" ? "#ef4444" : "#10b981";
                    const isEntry = key === "entry";
                    const label = isEntry ? `${posModify.side} Entry` : key.toUpperCase();
                    const pips = isEntry ? null : pipDistance(symbol, posModify.entry, value);
                    return (
                      <div
                        key={key}
                        className={`absolute left-0 right-12 flex -translate-y-1/2 items-center ${isEntry ? "pointer-events-none" : "pointer-events-auto cursor-ns-resize"}`}
                        style={{ top: y }}
                        data-testid={`scanner-chart-modify-handle-${key}`}
                        onPointerDown={isEntry ? undefined : (e) => {
                          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                          posDragKeyRef.current = key as "sl" | "tp";
                        }}
                      >
                        <div className={`h-0 w-full border-t-2 ${isEntry ? "border-solid opacity-70" : "border-dashed"}`} style={{ borderColor: color }} />
                        <span className="ml-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shadow" style={{ backgroundColor: color }}>
                          {label} {fmt(value)}{pips != null ? ` · ${pips.toFixed(1)}p` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Feed-status notice strip — appears between canvas and draft controls
                when the chart is showing candles that are not from a live feed.
                Copy is FIXED per display state; feedStatus.message / .warning are
                never surfaced here (they can carry live wording or an internal
                source token). Only the lastCandleTime timestamp — safe — is
                shown, on the STALE strip (Task #347). */}
            {displayStatus === "FALLBACK_COMPOSITE" && (
              <div className="flex items-center gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-1.5 text-[11px] text-warning" data-testid="scanner-chart-status-composite">
                <span className="font-medium">Delayed market data</span>
                <span className="ml-auto text-warning/50 text-[10px]">Historical context only — no live price marker</span>
              </div>
            )}
            {displayStatus === "STALE" && (
              <div className="flex items-center gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-1.5 text-[11px] text-warning" data-testid="scanner-chart-status-stale">
                <span className="font-medium">Stale · last-known candles</span>
                {feedStatus?.lastCandleTime && (
                  <span className="text-warning/70">· last updated {new Date(feedStatus.lastCandleTime).toLocaleTimeString()}</span>
                )}
                <span className="ml-auto text-warning/50 text-[10px]">No live price marker</span>
              </div>
            )}
            {displayStatus === "ANALYSIS_ONLY" && candles.length > 0 && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="scanner-chart-status-analysis">
                <span className="font-medium">Live feed unavailable · Analysis only</span>
                <span className="ml-auto text-txt-muted text-[10px]">Historical context — no live price marker</span>
              </div>
            )}

            {/* Phase 4 — draft order shaping (drag the lines; nothing fires here). */}
            {canTrade && chartAffordance.warningTitle && (
              <div className="mb-2 flex items-start gap-1.5 text-[11px] text-warning" data-testid="scanner-chart-feed-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span><strong>{chartAffordance.warningTitle}.</strong> {chartAffordance.warningDetail}</span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background/40 p-3" data-testid="scanner-chart-draft-controls">
              {!draft ? (
                canTrade ? (
                  canonicalChartUi.canAct ? (
                    // Canonical verdict allows action — show Plan Buy / Plan Sell.
                    <>
                      <span className="text-xs text-txt-secondary">Plan a trade on the chart:</span>
                      <Button size="sm" className="h-8 bg-success px-3 text-xs font-semibold text-white hover:bg-success/90" onClick={() => startDraft("BUY")} data-testid="scanner-chart-draft-buy">
                        Plan Buy
                      </Button>
                      <Button size="sm" className="h-8 bg-danger px-3 text-xs font-semibold text-white hover:bg-danger/90" onClick={() => startDraft("SELL")} data-testid="scanner-chart-draft-sell">
                        Plan Sell
                      </Button>
                      <OneClickArmedBadge className="ml-auto" />
                    </>
                  ) : (
                    // canTrade is set (execution gate) but canonical verdict says
                    // wait/degraded. Show a plain-English note from the shared contract
                    // instead of live trade buttons. DISPLAY-ONLY convergence — the
                    // execution gate (canTrade) is untouched.
                    <span className="text-[10px] text-txt-secondary" data-testid="scanner-chart-canonical-wait">
                      {canonicalChartUi.copy}
                    </span>
                  )
                ) : (
                  // PAPER / frozen / non-trading accounts get NO trade buttons —
                  // an honest read-only note instead of a dead/fake action.
                  <span className="text-[10px] text-warning" data-testid="scanner-chart-no-trade">
                    {tradeMode == null ? "Trading not available for this account mode." : "Manual trading is currently blocked for your account."}
                  </span>
                )
              ) : (
                <>
                  <Badge variant="outline" className={draft.side === "BUY" ? "border-primary/25 text-primary" : "border-premium/25 text-premium"}>
                    Draft {draft.side}
                  </Badge>
                  <span className="font-mono text-[11px] text-txt-secondary" data-testid="scanner-chart-draft-values">
                    Entry <span className="text-primary">{fmt(draft.entry)}</span>
                    {" · "}SL <span className="text-danger">{fmt(draft.sl)}</span>
                    {" · "}TP <span className="text-success">{fmt(draft.tp)}</span>
                  </span>
                  <span className="text-[10px] text-txt-muted">Drag the dashed lines to adjust.</span>
                  {canTrade ? (
                    <div className="ml-auto flex items-center gap-2">
                      <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        Lot
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          value={lot}
                          onChange={(e) => setLot(e.target.value)}
                          className="h-7 w-16 rounded border border-border bg-card px-1.5 font-mono text-[11px] text-foreground"
                          data-testid="scanner-chart-lot"
                        />
                      </label>
                      <Button
                        size="sm"
                        className={`h-7 px-3 text-xs ${draft.side === "BUY" ? "bg-primary hover:bg-primary" : "bg-premium hover:bg-premium"}`}
                        disabled={busy === "place"}
                        onClick={() => void placeDraft()}
                        data-testid="scanner-chart-draft-confirm"
                      >
                        {busy === "place" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                        Confirm {draft.side} ({tradeMode})
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setDraft(null)} data-testid="scanner-chart-draft-clear">
                        Clear
                      </Button>
                    </div>
                  ) : (
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-[10px] text-warning/80" data-testid="scanner-chart-no-trade">
                        {tradeMode == null ? "Trading not available for this account mode." : "Manual trading is currently blocked for your account."}
                      </span>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setDraft(null)} data-testid="scanner-chart-draft-clear">
                        Clear
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Task #764 — Adjust SL/TP control strip. Active only while the user
                is dragging an own LIVE position's SL/TP. Confirm step shows when
                one-click is OFF; submit routes through the sanctioned pipeline. */}
            {posModify && (
              <div className="space-y-2 rounded-xl border border-warning/25 bg-warning/5 p-3" data-testid="scanner-chart-modify-controls">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="border-warning/25 text-warning">Adjust SL/TP · {posModify.side}</Badge>
                  <span className="font-mono text-[11px] text-txt-secondary" data-testid="scanner-chart-modify-values">
                    Entry <span className="text-primary">{fmt(posModify.entry)}</span>
                    {" · "}SL <span className="text-danger">{posModify.sl != null ? fmt(posModify.sl) : "—"}</span>
                    {" · "}TP <span className="text-success">{posModify.tp != null ? fmt(posModify.tp) : "—"}</span>
                  </span>
                  {(() => {
                    const rr = computeRiskReward({ side: posModify.side, entry: posModify.entry, stopLoss: posModify.sl, takeProfit: posModify.tp });
                    return rr != null ? <span className="text-[10px] text-muted-foreground" data-testid="scanner-chart-modify-rr">R/R {rr.toFixed(2)}</span> : null;
                  })()}
                  <span className="text-[10px] text-txt-muted">Drag the dashed SL/TP lines — entry stays fixed.</span>
                  <OneClickArmedBadge className="ml-auto" />
                </div>
                {modifyArmed ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/25 bg-background/40 p-2" data-testid="scanner-chart-modify-confirm">
                    <span className="text-[11px] text-warning">Confirm change:</span>
                    <span className="font-mono text-[11px] text-txt-secondary">
                      SL <span className="text-txt-muted">{posModify.origSl != null ? fmt(posModify.origSl) : "—"}</span>
                      {" → "}<span className="text-danger">{posModify.sl != null ? fmt(posModify.sl) : "—"}</span>
                      {"  ·  "}TP <span className="text-txt-muted">{posModify.origTp != null ? fmt(posModify.origTp) : "—"}</span>
                      {" → "}<span className="text-success">{posModify.tp != null ? fmt(posModify.tp) : "—"}</span>
                    </span>
                    <div className="ml-auto flex items-center gap-2">
                      <Button size="sm" className="h-7 bg-warning px-3 text-xs text-white hover:bg-warning" disabled={busy === `modify:${posModify.ticket}`} onClick={() => void submitModify(posModify)} data-testid="scanner-chart-modify-submit">
                        {busy === `modify:${posModify.ticket}` ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                        Confirm SL/TP
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={cancelPosModify} data-testid="scanner-chart-modify-cancel">Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-txt-muted" data-testid="scanner-chart-modify-hint">
                      {oneClickArmed ? "One-click is on — releasing a line sends the change instantly." : "One-click is off — releasing a line opens a confirm step."}
                    </span>
                    <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs text-muted-foreground" onClick={cancelPosModify} data-testid="scanner-chart-modify-done">Done</Button>
                  </div>
                )}
              </div>
            )}

            {/* Smart Chart Layers & Market Impact Radar (Task #197) — read-only,
                advisory overlays with honest empty/absent states throughout. */}
            <div className="space-y-2 rounded-md border border-border bg-background/40 p-2" data-testid="scanner-smart-layers">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wide text-txt-muted">Layers:</span>
                {SMART_LAYER_TOGGLES.map((t) => {
                  const on = layerToggles[t.id];
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleLayer(t.id)}
                      className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${on ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-txt-muted"}`}
                      data-testid={`scanner-smart-layer-toggle-${t.id}`}
                      aria-pressed={on}
                    >
                      {t.label}
                    </button>
                  );
                })}
                {handshake && (
                  <Badge
                    variant="outline"
                    className={`ml-auto text-[10px] ${overlayDegraded ? "border-warning/25 text-warning" : handshakeBadgeStyle(handshake.overallStatus)}`}
                    title={overlayDegraded ? OVERLAY_DEGRADED_TITLE : handshake.userFacingMessage}
                    data-testid="scanner-smart-handshake"
                  >
                    Overlays: {overlayBadgeLabel(handshake.overallStatus, overlayDegraded, isLiveDisplay)}
                  </Badge>
                )}
              </div>

              {layerToggles.news && news && (
                <div className="space-y-1" data-testid="scanner-news-radar">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-txt-muted">Impact radar</span>
                    {news.highImpactWindowActive && (
                      <Badge variant="outline" className="border-danger/25 text-[10px] text-danger" data-testid="scanner-news-window">
                        High-impact window
                      </Badge>
                    )}
                    {/* The ONE "no calendar provider" disclaimer for the whole
                        page — rendered here, only when no provider is connected
                        (news.disclaimer is null otherwise). */}
                    {!news.providerConnected && news.disclaimer && (
                      <span className="text-[10px] text-txt-muted">{news.disclaimer}</span>
                    )}
                  </div>
                  {news.events.length === 0 ? (
                    <div className="text-[11px] text-txt-muted">{news.riskLabel}</div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {news.events.slice(0, 8).map((ev) => {
                        const st = newsSeverityStyle(ev.severity);
                        return (
                          <Badge
                            key={ev.id}
                            variant="outline"
                            className={`gap-1 text-[10px] ${st.cls} ${ev.affectsSymbol ? "" : "opacity-50"}`}
                            title={`${ev.title} — ${ev.currency}`}
                            data-testid={`scanner-news-event-${ev.id}`}
                          >
                            <span className="font-semibold">{st.label}</span>
                            <span className="font-mono">{ev.currency}</span>
                            <span>{ev.title}</span>
                            <span className="text-muted-foreground">{formatCountdown((Date.parse(ev.eventTimeIso) - Date.now()) / 1000)}</span>
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {layerToggles.trade_health && (
                <div
                  className={
                    tradeHealthQuery.isError
                      ? "text-[10px] text-warning/80"
                      : "text-[10px] text-txt-muted"
                  }
                  data-testid="scanner-smart-reserved"
                >
                  {tradeHealthQuery.isError
                    ? "Trade-health is momentarily unavailable — the chart and your data are unaffected."
                    : tradeHealthQuery.isLoading && !tradeHealthQuery.data
                      ? "Checking trade health for this symbol…"
                      : tradeHealthOverlays.length > 0
                        ? `${tradeHealthOverlays.length} live trade-health overlay${tradeHealthOverlays.length > 1 ? "s" : ""} on this symbol.`
                        : "No open positions on this symbol — trade-health overlays appear once you have a live or demo trade here."}
                </div>
              )}

              {smartLayersQuery.isError && (
                <div className="text-[11px] text-warning/80" data-testid="scanner-smart-error">
                  Smart layers are momentarily unavailable — the chart and your data are unaffected.
                </div>
              )}
            </div>

            {/* Phase 7 — Ruby's compact, read-only chart explanation. */}
            <RubyChartRead
              symbol={symbol}
              timeframe={timeframe}
              draft={draft}
              canonicalAction={canonicalChartActionFinal}
              canonicalDirection={canonicalChartDirection}
              canonicalReadId={truth?.consolidated.readId}
            />

            {/* Chart Brain v2 Task 6 — your marked levels / zones / price alerts.
                Right-click (or long-press) the chart to add. Read-only artifacts;
                dismissing soft-deletes (status → dismissed), never hard-delete. */}
            {annotations.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background/40 p-2" data-testid="scanner-chart-annotations">
                <span className="text-[10px] uppercase tracking-wide text-txt-muted">Your marks:</span>
                {annotations.map((a) => {
                  const label =
                    a.kind === "SUPPORT" ? "S" :
                    a.kind === "RESISTANCE" ? "R" :
                    a.kind === "PRICE_ALERT" ? `Alert ${a.direction === "above" ? "↑" : a.direction === "below" ? "↓" : ""}`.trim() :
                    "Zone";
                  return (
                    <Badge key={a.id} variant="outline" className="gap-1 border-border font-mono text-[10px] text-txt-secondary" data-testid={`scanner-chart-annotation-${a.id}`}>
                      {label} {fmt(a.price)}
                      <button
                        type="button"
                        className="ml-0.5 text-txt-muted hover:text-danger disabled:opacity-40"
                        disabled={dismissAnnotation.isPending}
                        onClick={() => dismissAnnotation.mutate({ id: a.id })}
                        title="Dismiss"
                        data-testid={`scanner-chart-annotation-dismiss-${a.id}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            )}

            {/* Phase 5/6 — manage the user's own open positions + pending orders
                directly from the chart. Every action is backend-gated. */}
            {(symbolPositions.length > 0 || symbolPending.length > 0) && (
              <div className="space-y-1.5 rounded-md border border-border bg-background/40 p-2" data-testid="scanner-chart-manage">
                {symbolPositions.map((p, i) => (
                  <div key={`pos-${p.brokerTicket ?? i}`} className="flex flex-wrap items-center gap-2 text-[11px]" data-testid={`scanner-chart-pos-${p.brokerTicket ?? i}`}>
                    <Badge variant="outline" className={p.accountMode === "LIVE" ? "border-danger/25 text-danger" : "border-primary/25 text-primary"}>
                      {p.accountMode}
                    </Badge>
                    <span className={p.side === "BUY" ? "font-semibold text-success" : "font-semibold text-danger"}>{p.side}</span>
                    <span className="font-mono text-muted-foreground">{p.lotSize ?? "—"} @ {p.entryPrice != null ? fmt(p.entryPrice) : "—"}</span>
                    {p.floatingPnl != null && (
                      <span className={`font-mono ${p.floatingPnl >= 0 ? "text-success" : "text-danger"}`}>{p.floatingPnl >= 0 ? "+" : ""}{p.floatingPnl.toFixed(2)}</span>
                    )}
                    {canTrade && p.brokerTicket && (
                      <div className="ml-auto flex items-center gap-1">
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy === `close:${p.brokerTicket}:1`} onClick={() => void closePosition(p, 1)} data-testid={`scanner-chart-close-${p.brokerTicket}`}>
                          Close
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy === `close:${p.brokerTicket}:0.5`} onClick={() => void closePosition(p, 0.5)} data-testid={`scanner-chart-close-half-${p.brokerTicket}`}>
                          50%
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy === `be:${p.brokerTicket}` || p.entryPrice == null} onClick={() => void breakEven(p)} data-testid={`scanner-chart-be-${p.brokerTicket}`}>
                          Break-even
                        </Button>
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy === `rev:${p.brokerTicket}`} onClick={() => void reversePosition(p)} data-testid={`scanner-chart-reverse-${p.brokerTicket}`}>
                          Reverse
                        </Button>
                        {p.accountMode === "LIVE" && (isLiveDisplay ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 border-warning/25 px-2 text-[10px] text-warning"
                            disabled={busy === `modify:${p.brokerTicket}`}
                            onClick={() => startPosModify(p)}
                            data-testid={`scanner-chart-modify-${p.brokerTicket}`}
                          >
                            Adjust SL/TP
                          </Button>
                        ) : (
                          <span className="text-[10px] text-txt-muted" data-testid={`scanner-chart-modify-locked-${p.brokerTicket}`}>
                            SL/TP edit needs live feed
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {symbolPending.map((o) => (
                  <div key={`pen-${o.id}`} className="flex flex-wrap items-center gap-2 text-[11px]" data-testid={`scanner-chart-pending-${o.id}`}>
                    <Badge variant="outline" className="border-warning/25 text-warning">PENDING</Badge>
                    <span className="font-semibold text-foreground">{o.side} {o.orderType ?? ""}</span>
                    <span className="font-mono text-muted-foreground">{o.lotSize} @ {(o.entryPrice ?? o.stopTriggerPrice ?? o.stopLimitPrice) != null ? fmt((o.entryPrice ?? o.stopTriggerPrice ?? o.stopLimitPrice)!) : "—"}</span>
                    {canTrade && (
                      <div className="ml-auto">
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={busy === `cancel:${o.id}`} onClick={() => void cancelPending(o.id)} data-testid={`scanner-chart-cancel-${o.id}`}>
                          <X className="mr-0.5 h-3 w-3" /> Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ScannerChartPanel;
