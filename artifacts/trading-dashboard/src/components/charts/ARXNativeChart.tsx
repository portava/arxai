import { chartTickSource, matchesChartTickContext } from "@/lib/chartTickStreamContext";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, useContext } from "react";
import { ChartReplayContext } from "@/components/chart-replay/ChartReplayContext";
import { ChartLinkContext } from "./ChartLinkContext";
import { hasMatchingOverlayEvidence, useDerivedOverlayContext } from "../scanner/useDerivedOverlayContext";
import {
  useGetChartCandles,
  getGetChartCandlesQueryKey,
  useGetMeChartIntelligence,
  getGetMeChartIntelligenceQueryKey,
  GetChartCandlesTimeframe,
  type ChartCandlesResponse,
  type ChartIntelligenceResponse,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CandlestickChart,
  Loader2,
  AlertTriangle,
  BarChart3,
  ShieldAlert,
  RotateCcw,
  Lock,
  Unlock,
  RefreshCw,
  GitMerge,
  AlertCircle,
  LineChart,
  Clock,
  Maximize2,
  Minimize2,
  ArrowRightToLine,
} from "lucide-react";
import { ChartWorkbenchTools } from "./ChartWorkbenchTools";
import { SmartChartReader } from "./SmartChartReader";
import { PREFERENCES_KEY, readChartStorage, validatePreferences, writeChartStorage } from "@/lib/chart-engine/chartWorkspace";
import { candleDisplayPrecision } from "@/lib/chart-engine/candleReconciliation";
import { CHART_TIME_AXIS_LABEL, CHART_TIME_AXIS_TITLE } from "@/components/scanner/scannerChartFormat";
import { bareSymbol } from "@/lib/use-chart-symbol";
import { useChartDeepHistory } from "@/lib/useChartDeepHistory";
import { ChartHistoryBadge } from "@/components/charts/ChartHistoryBadge";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";
import { formatMarketClosedLabel } from "@/components/charts/marketFrozenFormat";
import { useTickStreamWatchdog } from "@/components/charts/useTickStreamWatchdog";
import { feedConfidence } from "@/lib/feed-confidence";
import { resolveDisplayStatus, isLivePriceDisplay } from "@/lib/chart-display-status";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { normalizeChartTimeframe } from "@/lib/chartCandlesQuery";
import { resolveFeedBadgeVerdict } from "@/lib/rubyReadPanelState";
import {
  type ChartOverlay,
  overlayMetaNumber,
  overlayMetaString,
} from "@/lib/chart-overlays";
import {
  createChartEngineAdapter,
  type ChartEngineAdapter,
  type ChartEngineCandle,
  type ChartStructureLine,
  type ChartStructureMarker,
} from "@/lib/chart-engine";

// ARXNativeChart — Level 2 native chart shell.
//
// Renders clean candlesticks from the Level 1 normalized contract
// (GET /api/chart/candles via the generated useGetChartCandles hook). This is a
// reusable, self-contained chart placed BESIDE the TradingView embed so the
// native pipeline can be proven before becoming the default.
//
// HONESTY / SAFETY:
//  - Candles come ONLY from the normalized /api/chart/candles contract, which is
//    itself built over the existing market-data router. We NEVER fabricate bars.
//    When the contract returns an honest empty/unavailable state we show a clear
//    "no native candles" message (with an optional TradingView fallback) — never
//    a blank or fake chart.
//  - This is a view-only chart: it has no order-placement surface. Trade actions
//    live elsewhere (the gated instant-trade router).
//  - Level 3 feed confidence: the header renders a FeedConfidenceBadge driven by
//    the contract's embedded feedStatus (source/live/stale/latency/last update/
//    missing-candle count/AI-usable/warning). When the feed is stale or poor a
//    prominent banner offers the TradingView fallback, and when aiUsable=false
//    the chart is visibly marked "not AI-confirmed" so Level 5 overlays respect it.
//
// Phase 2 additions:
//  - Smart visible range: default shows last 150 candles (mobile: 80) so the
//    chart opens to recent price action, not a compressed full-history view.
//  - Reset Scale button: always-available control to restore the default range.
//  - Chart Mirror Layer: compact status bar (Mirrored/Syncing/Stale/Conflict/
//    Refreshing) with a Mirror Lock toggle. When locked the chart's symbol and
//    timeframe stay in sync with the rest of the UI; when unlocked an
//    "Inspection mode" badge shows clearly.
//  - Chart Safe Mode: when the quality is "invalid" (integrity check failed),
//    an overlay shows a clean user message and pauses AI confidence. Overlays
//    (open positions) remain visible because execution state is independent.
//  - Chart-mode gate: if candles are present but OHLC spread is flat across
//    >80% of bars, a "Line mode — OHLC candles are flat" banner is shown so
//    the user is never misled about what they are looking at.
//  - Overlay anchoring: context-owned observations reset before paint on
//    instrument, timeframe or source changes while the canvas stays mounted.
//  - Performance: timeframe selection is immediate; crosshair updates are
//    throttled to 60fps; AI/intelligence panel stays off the chart render loop.

const BASE = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
const u = (p: string) => `${BASE}${p}`;

export type ArxTimeframe = (typeof GetChartCandlesTimeframe)[keyof typeof GetChartCandlesTimeframe];

const TIMEFRAMES: { id: ArxTimeframe; label: string }[] = [
  { id: "M1", label: "M1" },
  { id: "M5", label: "M5" },
  { id: "M15", label: "M15" },
  { id: "M30", label: "M30" },
  { id: "H1", label: "H1" },
  { id: "H4", label: "H4" },
  { id: "D1", label: "D1" },
];

const TF_KEY = "arx.nativeChart.timeframe";
const DEFAULT_TF: ArxTimeframe = "M15";
const EMPTY_OVERLAYS: ChartOverlay[] = [];


function loadTimeframe(): ArxTimeframe {
  if (typeof window === "undefined") return DEFAULT_TF;
  let v: string | null = null;
  try { v = localStorage.getItem(TF_KEY); } catch { /* private storage unavailable */ }
  return (TIMEFRAMES.some((t) => t.id === v) ? (v as ArxTimeframe) : DEFAULT_TF);
}

// Mirror status — derived from feed quality + fetch state.
type MirrorStatus = "Mirrored" | "Syncing" | "Stale" | "Conflict" | "Refreshing";

function getMirrorStatus(
  quality: string | null | undefined,
  stale: boolean | undefined,
  isFetching: boolean,
): MirrorStatus {
  if (isFetching) return "Refreshing";
  if (!quality) return "Syncing";
  if (quality === "clean") return stale ? "Stale" : "Mirrored";
  if (quality === "delayed" || quality === "partial") return "Mirrored";
  if (quality === "stale") return "Stale";
  if (quality === "invalid") return "Conflict";
  return "Syncing"; // empty / unavailable
}

const MIRROR_STYLE: Record<MirrorStatus, { dot: string; text: string; label: string }> = {
  Mirrored: {
    dot: "bg-emerald-400",
    text: "text-emerald-300",
    label: "Mirrored",
  },
  Refreshing: {
    dot: "bg-sky-400 animate-pulse",
    text: "text-sky-300",
    label: "Refreshing",
  },
  Syncing: {
    dot: "bg-amber-400 animate-pulse",
    text: "text-amber-300",
    label: "Syncing",
  },
  Stale: {
    dot: "bg-amber-400",
    text: "text-amber-300",
    label: "Stale",
  },
  Conflict: {
    dot: "bg-red-400",
    text: "text-red-300",
    label: "Conflict",
  },
};

// OHLC diversity check: a bar is "flat" when high==low (or effectively so).
// If >80% of bars are flat the feed has no real OHLC — show a labeled
// indicator so the user isn't misled by a candlestick chart with invisible wicks.
function checkOhlcDiversity(candles: { open: number; high: number; low: number; close: number }[]): boolean {
  if (candles.length < 3) return true; // not enough data to decide — optimistic
  const sample = candles.slice(-50); // check the last 50 bars only
  let flatCount = 0;
  for (const c of sample) {
    const spread = c.high - c.low;
    const mid = (c.high + c.low) / 2;
    if (mid === 0) continue;
    if (spread / mid < 0.000_01) flatCount++;
  }
  return flatCount / sample.length < 0.8; // true → have real OHLC
}

export interface ARXNativeChartProps {
  /** Distinguishes browser preferences for primary and comparison views. */
  workspaceId?: "primary" | "comparison" | "comparison-2" | "comparison-3";
  /** ARX-canonical or display symbol (e.g. "EURUSD", "FX:EURUSD", "V75"). */
  symbol: string;
  /** Controlled timeframe. When omitted the chart manages its own (persisted). */
  timeframe?: ArxTimeframe;
  /** Notified whenever the user changes the timeframe via the controls. */
  onTimeframeChange?: (tf: ArxTimeframe) => void;
  /** Notified with the resolved (bare, upper-cased) symbol the chart is showing. */
  onSymbolChange?: (symbol: string) => void;
  /** Visual hint only — never gates anything (e.g. "live" | "demo" | "paper"). */
  mode?: string;
  /** Chart pixel height (default 520). */
  height?: number;
  /** Chart pixel height on mobile (<768px). Defaults to height if unset. */
  mobileHeight?: number;
  /** Show the minimal honest quality chip (default true). Level 3 owns the rich badge. */
  showFeedStatus?: boolean;
  /** Render a "Use TradingView" button in the empty/error state. */
  showFallbackToggle?: boolean;
  /** Called when the user asks to fall back to the TradingView reference chart. */
  onRequestFallback?: () => void;
  /** Max candles to request (default 300; contract caps at 5000). */
  limit?: number;
  /**
   * Level 4 — read-only trade overlays drawn on top of the candles (open
   * positions, plan lines, markers, P/L bubbles). PURE VISUALISATION: the chart
   * never executes a trade. Empty/omitted renders a clean chart with no lines.
   */
  overlays?: ChartOverlay[];
  /**
   * Level 5 — reports the chart's resolved symbol, current timeframe, and the
   * Level 3 `aiUsable` verdict (true only on a clean feed) whenever any of them
   * change. Lets a parent source AI overlays (scanner/Ruby) against the exact
   * instrument the chart is showing and suppress them on an unconfirmed feed —
   * WITHOUT duplicating the candle fetch. Pure read-out: never gates candles
   * or trade execution.
   */
  onChartContextChange?: (ctx: {
    symbol: string;
    timeframe: ArxTimeframe;
    aiUsable: boolean;
  }) => void;
  /**
   * Chart Brain v2 (Task 1) — reports the latest centralized Chart Intelligence
   * State (truth state + fast candle stats/flags + EXPLICIT engine placeholders +
   * speed state) whenever it refreshes. This is a SEPARATE, NON-BLOCKING fetch:
   * candles paint from their own query regardless of this one, and a failure here
   * never breaks the chart or the page. Later Chart Brain tasks consume it; the
   * chart never executes from it.
   */
  onIntelligenceChange?: (state: ChartIntelligenceResponse["state"]) => void;
  /**
   * Phase 2 — Mirror lock initial state. When true (default) the chart's
   * displayed symbol and timeframe are locked to the shared chart-symbol bus.
   * When false the chart enters inspection mode and can diverge.
   */
  mirrorLockDefault?: boolean;
}

export function ARXNativeChart({
  workspaceId = "primary",
  symbol,
  timeframe: controlledTf,
  onTimeframeChange,
  onSymbolChange,
  mode,
  height = 520,
  mobileHeight,
  showFeedStatus = true,
  showFallbackToggle = false,
  onRequestFallback,
  limit = 300,
  overlays: suppliedOverlays = EMPTY_OVERLAYS,
  onChartContextChange,
  onIntelligenceChange,
  mirrorLockDefault = true,
}: ARXNativeChartProps) {
  // Normalize the incoming symbol to the bare, upper-cased form the contract
  // expects ("FX:EURUSD" -> "EURUSD"); the endpoint classifies from there.
  const resolvedSymbol = useMemo(
    () => bareSymbol(symbol || "EURUSD").toUpperCase(),
    [symbol],
  );

  const cardRef = useRef<HTMLDivElement | null>(null);
  const viewLinks = useContext(ChartLinkContext);
  const linkStatusRef = useRef<HTMLOutputElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const preferencesKey = workspaceId === "primary" ? PREFERENCES_KEY : `${PREFERENCES_KEY}:${workspaceId}`;
  const [preferences, setPreferences] = useState(() => validatePreferences(readChartStorage(preferencesKey) ?? readChartStorage(PREFERENCES_KEY)));
  const [preferencesSaved, setPreferencesSaved] = useState(true);
  const scaleMode = preferences.scale;

  useEffect(()=>{setPreferencesSaved(writeChartStorage(preferencesKey,preferences));},[preferences,preferencesKey]);
  const legendRef = useRef<HTMLOutputElement | null>(null);
  const studyInspectorRef = useRef<HTMLOutputElement | null>(null);
  const dataWindowRef = useRef<HTMLDetailsElement | null>(null);
  const inspectedCandleRef = useRef<ChartEngineCandle | null>(null);
  const updateLegend = useCallback((candle: ChartEngineCandle | null) => {
    const bar = candle;
    inspectedCandleRef.current = bar;
    if (!legendRef.current) return;
    const digits = bar ? candleDisplayPrecision([bar], symbol) : 5;
    legendRef.current.textContent = bar
      ? `${new Date(bar.time * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC  ·  O ${bar.open.toFixed(digits)}  H ${bar.high.toFixed(digits)}  L ${bar.low.toFixed(digits)}  C ${bar.close.toFixed(digits)}`
      : "Move the crosshair over a candle to inspect it";
    if (studyInspectorRef.current && dataWindowRef.current?.open) {
      const rows = bar ? adapterRef.current?.getStudyValues?.(bar.time) ?? [] : [];
      const fragment = document.createDocumentFragment();
      for (const row of rows) {
        const line = document.createElement("div");
        line.className = "flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-zinc-800 py-1.5";
        const label = document.createElement("span");
        label.textContent = row.label;
        label.style.color = row.color;
        const values = document.createElement("span");
        values.textContent = row.values.map(item => `${item.name}: ${item.value == null ? "— (warm-up / unavailable)" : Number(item.value.toPrecision(8))}`).join(" · ");
        line.append(label, values);
        fragment.append(line);
      }
      if (!rows.length) fragment.append(document.createTextNode("Add a study to inspect its values."));
      studyInspectorRef.current.replaceChildren(fragment);
    }
  }, [symbol]);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      if (event.key === "Tab") {
        const items = cardRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, a[href], [tabindex="0"]');
        const first = items?.[0];
        const last = items?.[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", escape); previousFocus?.focus(); };
  }, [expanded]);

  const [internalTf, setInternalTf] = useState<ArxTimeframe>(() => loadTimeframe());
  const timeframe = controlledTf ?? internalTf;
  const overlays = useMemo(() => suppliedOverlays.filter(overlay =>
    overlay.symbol === resolvedSymbol && (!overlay.timeframe || overlay.timeframe === timeframe)),
  [suppliedOverlays, resolvedSymbol, timeframe]);

  // Phase 2 — Mirror Lock. When on, the chart advertises its symbol/timeframe
  // as "mirrored" with the rest of the UI. When off, an inspection-mode
  // indicator shows. This is visual state only; the symbol/timeframe come from
  // the parent regardless — this flag only changes how the Mirror Layer reads.
  const [mirrorLocked, setMirrorLocked] = useState(mirrorLockDefault);

  // Bumped each time the chart/series is (re)built so overlay effects redraw
  // onto the fresh series instead of a stale handle.
  const [chartEpoch, setChartEpoch] = useState(0);
  // P/L bubbles tracked in DOM coordinates (recomputed as the price scale moves).
  const [bubbles, setBubbles] = useState<
    { id: string; y: number; pnl: number; side: string | null; mode: string | null }[]
  >([]);

  useEffect(() => {
    onSymbolChange?.(resolvedSymbol);
  }, [resolvedSymbol, onSymbolChange]);

  const setTimeframe = useCallback(
    (tf: ArxTimeframe) => {
      // The adapter is retained across contexts and clears old observations
      // before paint. Selection no longer needs a timer that delays feedback.
      // Query cancellation and source/context checks own stale response safety.
      if (controlledTf == null) {
        setInternalTf(tf);
        try { localStorage.setItem(TF_KEY, tf); } catch { /* optional preference */ }
      }
      onTimeframeChange?.(tf);
    },
    [controlledTf, onTimeframeChange],
  );

  // Level 1 contract via the generated hook. Polls on an interval; the global
  // QueryClient already pauses polling while the tab is hidden.
  const query = useGetChartCandles(
    { symbol: resolvedSymbol, timeframe, limit },
    {
      query: {
        queryKey: getGetChartCandlesQueryKey({ symbol: resolvedSymbol, timeframe, limit }),
        enabled: resolvedSymbol.length > 0,
        refetchInterval: 8000,
        staleTime: 4000,
      },
    },
  );

  const replay = useContext(ChartReplayContext);
  const [replayError,setReplayError] = useState<string | null>(null);
  const response: ChartCandlesResponse | undefined = query.data;
  const data = useMemo(() => response?.symbol === resolvedSymbol && response.timeframe === timeframe
    && response.candles.every(candle => candle.symbol === resolvedSymbol
      && candle.timeframe === timeframe && candle.source === response.feedStatus?.source)
    ? response : undefined, [response, resolvedSymbol, timeframe]);
  const candles = data?.candles ?? [];
  const hasCandles = candles.length > 0;

  // ── Deep history scroll-back (Task #438) ────────────────────────────────────
  // Accumulates OLDER bars from GET /api/chart/history as the user pans left.
  // View-only: loading history never touches an execution path, and the hook
  // never fabricates a bar — a provider ceiling stops paging and is reported
  // honestly via the history badge.
  const evidence = data?.marketEvidence;
  const evidenceIdentity = evidence?.symbol === resolvedSymbol && evidence.timeframe === timeframe
    && evidence.source === data?.feedStatus?.source ? evidence.sourceIdentity : null;
  const overlayRequiresEvidence = useDerivedOverlayContext(JSON.stringify([resolvedSymbol, timeframe]),
    hasCandles ? JSON.stringify([data?.feedStatus?.source ?? null, evidenceIdentity]) : null);
  const deepHistory = useChartDeepHistory(resolvedSymbol, timeframe, hasCandles,
    data?.feedStatus?.source ?? null, evidenceIdentity, true);

  // ── Live-price affordance honesty (shared rule, Task #351) ──────────────────
  // The candlestick last-value label and the dashed "Last" price line are
  // live-price affordances. They must obey the SAME "never look more live than
  // the feed" rule the Scanner and position mini-charts use, so the verdict is
  // resolved through the shared chart-display-status module — not this chart's
  // own feed-confidence badge system (which stays as the header). The header
  // here derives from the same feedStatus, so chart and header can never
  // disagree and no separate header cap is needed.
  const isLivePriceAffordance = isLivePriceDisplay(
    resolveDisplayStatus(data?.feedStatus ?? null, hasCandles),
  );
  // NOTE (Theme C3.3): this verdict is NOT mirrored into a ref for the SSE tick
  // handler any more. It describes the CLOSED-candle feed and is sticky, so
  // using it to gate live frames froze charts whose ticks were flowing fine.
  // Each frame carries its own server-computed `frozen` marker instead. This
  // value still drives the last-price affordance through setFeedState below.

  // Market-frozen / closed-market indicator (display/telemetry only). Driven by
  // the tick-stream `feed_status` event, whose verdict is derived from the
  // latest tick's BROKER-time staleness (calendar-independent), so a still-
  // forming bar reads as closed-market rather than a broken feed. null = not
  // frozen (or no tick seen yet → assert nothing).
  const [marketFrozen, setMarketFrozen] = useState<{ lastBrokerTimeMs: number | null } | null>(
    null,
  );

  // ── Tick-stream watchdog (Theme C3.4) ───────────────────────────────────
  // A dropped SSE stream used to be invisible: `es.onerror` was a no-op, and a
  // connection that dies without an error event (proxy timeout, sleeping tab,
  // network change) produces NO error at all — it simply stops delivering, so
  // the chart sat frozen indefinitely while still presenting as live. The hook
  // owns silence detection and the reconnect signal; see its own file for the
  // detection rationale and timings.
  // Only a candle source that HAS a tick stream (MT5 broker / Deriv) is watched:
  // third-party sources and an empty feed never open one, so they can never be
  // "reconnecting".
  const tickSource = chartTickSource(data?.feedStatus?.source);
  const streamWatchdog = useTickStreamWatchdog({
    active: resolvedSymbol.length > 0 && tickSource != null,
  });

  // Chart Brain v2 (Task 1) — centralized Chart Intelligence State. This is a
  // SEPARATE, non-blocking fetch from the candle query above: candles render
  // from `query` regardless of this one, and any error here is contained to
  // `intelligenceQuery.error` (it never throws into render). Only the parent's
  // optional callback observes it; the chart itself never gates on it.
  const intelligenceQuery = useGetMeChartIntelligence(
    { symbol: resolvedSymbol, timeframe, limit },
    {
      query: {
        queryKey: getGetMeChartIntelligenceQueryKey({ symbol: resolvedSymbol, timeframe, limit }),
        enabled: resolvedSymbol.length > 0 && onIntelligenceChange != null,
        refetchInterval: 8000,
        staleTime: 4000,
      },
    },
  );
  const intelligenceResponse = intelligenceQuery.data?.state;
  const intelligenceState = intelligenceResponse?.symbol === resolvedSymbol && intelligenceResponse.timeframe === timeframe
    ? intelligenceResponse : undefined;

  useEffect(() => {
    if (intelligenceState) onIntelligenceChange?.(intelligenceState);
  }, [intelligenceState, onIntelligenceChange]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // The chart RENDERER lives behind the swappable chart-engine adapter (Task
  // #373). This component owns React state, data, feed-status and UI; the
  // imperative engine (lightweight-charts v5) is driven only through the adapter.
  const adapterRef = useRef<ChartEngineAdapter | null>(null);
  const chartContext = JSON.stringify([resolvedSymbol, timeframe, data?.feedStatus?.source ?? null, evidenceIdentity]);
  const activeChartContext = useRef<{ key: string; adapter: ChartEngineAdapter } | null>(null);
  // Newest bar time (Unix seconds) currently on screen. The poll keeps this in
  // sync with the authoritative closed window; the SSE tick handler reads it to
  // reject an out-of-order forming tip (one behind the newest bar).
  const newestBarSecRef = useRef<number | null>(null);

  // Phase 2 — responsive chart height. On narrow viewports the default 520px
  // height leaves too little room when panels stack below the canvas. We
  // honour `mobileHeight` when provided; otherwise cap at 320px on mobile so
  // the chart is always readable without crushing the rest of the page.
  const [effectiveHeight, setEffectiveHeight] = useState(height);
  useEffect(() => {
    const update = () => {
      const isMobile = window.innerWidth < 768;
      if (expanded) {
        setEffectiveHeight(Math.max(240, window.innerHeight - 240));
      } else if (isMobile && mobileHeight != null) {
        setEffectiveHeight(mobileHeight);
      } else if (isMobile) {
        setEffectiveHeight(Math.max(320, Math.min(height, 380)));
      } else {
        setEffectiveHeight(height);
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [height, mobileHeight, expanded]);

  // Retain the expensive canvas. Context-owned observations are cleared in the
  // layout phase below, before a new market label can paint over old geometry.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const adapter = createChartEngineAdapter();
    adapter.init({ container: el, height: effectiveHeight });
    adapter.setSymbol?.(resolvedSymbol);
    adapter.setTimeframe?.(timeframe);
    adapter.setCrosshairHandler?.(updateLegend);
    adapter.setViewLinkStatusHandler?.(message => {if (linkStatusRef.current) linkStatusRef.current.textContent = message;});
    updateLegend(null);
    adapterRef.current = adapter;

    return () => {
      adapter.destroy();
      adapterRef.current = null;
      activeChartContext.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewLinks, workspaceId]);

  useLayoutEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    if (activeChartContext.current?.key === chartContext && activeChartContext.current.adapter === adapter) return;
    activeChartContext.current = { key: chartContext, adapter };
    if (adapter.resetDataContext) adapter.resetDataContext();
    else {
      adapter.setFeedState({ livePriceAffordance: false, source: null });
      adapter.setOverlays([], null);
      adapter.setStructureLines?.([], []);
      adapter.setSmartAnnotation?.(null);
      adapter.setDrawings?.([]);
      adapter.setCandles([]);
    }
    adapter.setSymbol?.(resolvedSymbol);
    adapter.setTimeframe?.(timeframe);
    newestBarSecRef.current = null;
    inspectedCandleRef.current = null;
    updateLegend(null);
    setMarketFrozen(null);
    setBubbles([]);
    // Rebind channel ownership even when identity changes within one provider.
    setChartEpoch(epoch => epoch + 1);
  }, [chartContext, resolvedSymbol, timeframe, viewLinks, workspaceId, updateLegend]);
  useLayoutEffect(() => {
    const adapter = adapterRef.current;
    return adapter ? viewLinks?.register(workspaceId, adapter) : undefined;
  }, [viewLinks, workspaceId, chartContext]);
  useLayoutEffect(() => { adapterRef.current?.setCrosshairHandler?.(updateLegend); }, [updateLegend, chartEpoch]);

  useEffect(() => { adapterRef.current?.resize(undefined, effectiveHeight); }, [effectiveHeight, chartEpoch]);
  useEffect(() => { adapterRef.current?.setScaleMode?.(scaleMode); }, [scaleMode, chartEpoch]);
  useEffect(() => { adapterRef.current?.setPriceScaleInverted?.(preferences.inverted === true); }, [preferences.inverted, chartEpoch]);

  useEffect(() => { adapterRef.current?.setChartStyle?.(preferences.style); }, [preferences.style, chartEpoch]);
  useEffect(() => {
    adapterRef.current?.setStudies?.(preferences.studies);
    updateLegend(inspectedCandleRef.current);
  }, [preferences.studies, chartEpoch, updateLegend]);

  // Phase 2 — reset scale: restore the default visible range (last N candles).
  const resetScale = useCallback(() => {
    adapterRef.current?.resetScale();
  }, []);

  // Normalize the contract candles into the engine-agnostic shape (Unix seconds
  // + finite OHLC) the chart-engine adapter consumes.
  const engineCandles = useMemo<ChartEngineCandle[]>(
    () =>
      candles
        .map((c) => ({
          time: Math.floor(new Date(c.openTime).getTime() / 1000),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
        .filter(
          (c) =>
            Number.isFinite(c.time) &&
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close),
        ),
    [candles],
  );

  // Merge accumulated deep-history (older) bars IN FRONT of the live window. The
  // history hook yields Candle.time in epoch-MS; the engine consumes epoch-SEC,
  // so we down-convert and dedupe by second. The live window always wins on a
  // time collision (it carries the freshest forming bar). Nothing is fabricated.
  const mergedEngineCandles = useMemo<ChartEngineCandle[]>(() => {
    if (deepHistory.olderCandles.length === 0) return engineCandles;
    const byTime = new Map<number, ChartEngineCandle>();
    for (const c of deepHistory.olderCandles) {
      const time = Math.floor(c.time / 1000);
      if (
        Number.isFinite(time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      ) {
        byTime.set(time, { time, open: c.open, high: c.high, low: c.low, close: c.close });
      }
    }
    for (const c of engineCandles) byTime.set(c.time, c); // live window wins
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }, [deepHistory.olderCandles, engineCandles]);

  // Oldest bar currently on screen as an ISO string — the cursor seed the
  // reach-start handler pages behind. Held in a ref so the (stable) handler
  // registered on the engine always reads the latest value without re-binding.
  const oldestIsoRef = useRef<string | null>(null);
  useEffect(() => {
    const oldest = mergedEngineCandles[0];
    oldestIsoRef.current = oldest
      ? new Date(oldest.time * 1000).toISOString()
      : null;
  }, [mergedEngineCandles]);

  const historySource = data?.feedStatus?.source ?? null;

  // ── Push data into the existing series on every poll WITHOUT recreating the
  //    chart. The adapter reconciles the current visible range, so the forming last
  //    bar updates and new bars append while the user's zoom/pan is preserved.
  //    Phase 2: on first data load we set a smart visible range (last N candles)
  //    instead of fitContent() over the whole history. This prevents the y-axis
  //    from covering a huge distant-outlier price range, and ensures recent price
  //    action fills the canvas rather than being compressed into a horizontal line.
  useLayoutEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    // The live-price affordance (last-value label + dashed "Last" line) is
    // suppressed unless the feed is genuinely LIVE (Task #351, shared honesty
    // rule). chartEpoch re-runs this after a context reset so the retained engine
    // is populated immediately rather than waiting for the next poll.
    adapter.setFeedState({ livePriceAffordance: isLivePriceAffordance, source: historySource });
    adapter.setCandles(mergedEngineCandles);
    // Keep the newest-bar watermark in sync with the authoritative closed
    // window. When the poll reconciles a new closed bar it advances here, so the
    // SSE tip for the next interval is accepted and a stale tip is rejected; the
    // closed bar cleanly supersedes any prior synthesized tip with no orphan dup.
    const newest = mergedEngineCandles[mergedEngineCandles.length - 1];
    if (newest) newestBarSecRef.current = newest.time;
  }, [mergedEngineCandles, isLivePriceAffordance, chartEpoch, historySource, chartContext]);

  // ── Real-time forming-tip (Task #501). Subscribe to the SAME server SSE
  //    tick-stream the Scanner chart uses (Task #496) for the current
  //    (symbol, timeframe) and apply each forming bar through the chart-engine
  //    adapter's updateActiveCandle() — NOT setCandles — so the most-recent
  //    candle ticks in real time without repainting the chart (zoom/scroll
  //    preserved). The 8s poll above is the reconciliation backstop: it carries
  //    the authoritative closed bar that replaces the synthesized tip.
  //
  //    HONESTY (matches the Scanner gates exactly): apply a tip ONLY when the
  //    stream reports THAT FRAME is not frozen and the tip time is >= the newest
  //    bar. A silent/stale/out-of-order stream can never keep a fake bar
  //    ticking. The payload is pure OHLC display telemetry — no execution path
  //    is touched.
  //
  //    Theme C3.3: the extra `isLivePriceAffordance` gate that used to sit here
  //    was removed. It is a verdict about the CLOSED-candle feed and it is
  //    sticky — a feed graded stale/delayed once suppressed every subsequent
  //    tick, so a chart whose ticks were flowing normally sat visibly frozen.
  //    Each frame already carries its own `frozen` flag, computed server-side
  //    from the REAL age of the tick behind it, which is both stricter (it goes
  //    true the moment ticks actually stop) and more current than the sticky
  //    grade. The Scanner has always gated this way; the two now agree. The
  //    live-price affordance still governs the last-price label and dashed
  //    "Last" line via setFeedState — that is unchanged.
  useEffect(() => {
    // Clear the closed-market badge whenever the stream key changes — the prior
    // symbol/timeframe's verdict is no longer relevant, and a new stream with no
    // tick yet emits no feed_status, so a stale badge would otherwise linger.
    setMarketFrozen(null);
    if (resolvedSymbol.length === 0 || !tickSource) return;
    const url = u(
      `/api/chart/tick-stream?symbol=${encodeURIComponent(resolvedSymbol)}&timeframe=${encodeURIComponent(timeframe)}&source=${encodeURIComponent(tickSource)}`,
    );
    let es: EventSource | null = null;
    let disposed = false;
    const ownedAdapter = adapterRef.current;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      return; // EventSource unavailable — the 8s poll still keeps the tip fresh.
    }
    streamWatchdog.noteStreamOpened();
    es.onmessage = (ev) => {
      if (disposed || activeChartContext.current?.key !== chartContext || activeChartContext.current.adapter !== ownedAdapter) return;
      // Any frame — tip, feed_status, or heartbeat — proves the stream is alive.
      // Recorded before parsing so even an unrecognised frame counts as liveness.
      streamWatchdog.noteFrame();
      let msg: {
        type?: string;
        source?: string;
        symbol?: string;
        timeframe?: string;
        frozen?: boolean;
        tickWallMs?: number;
        marketFrozen?: boolean;
        lastBrokerTimeMs?: number | null;
        bar?: { openTimeMs?: number; open?: number; high?: number; low?: number; close?: number };
      };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }
      if (!matchesChartTickContext(msg, tickSource, resolvedSymbol, timeframe)) return;
      // Market-frozen / closed-market indicator. Handled BEFORE the tip-apply
      // guards below because it must surface even when no live tip is applied
      // (a frozen broker quote is exactly the case where we apply NO tip).
      if (msg.type === "feed_status") {
        setMarketFrozen(
          msg.marketFrozen === true ? { lastBrokerTimeMs: msg.lastBrokerTimeMs ?? null } : null,
        );
        return;
      }
      const adapter = adapterRef.current;
      if (!adapter?.updateActiveCandle) return;
      // Gate on THIS frame's own freshness marker (server-computed from the real
      // tick age), exactly like the Scanner — not on the sticky closed-feed grade.
      if (msg.type !== "forming_bar" || msg.frozen || !msg.bar) return;
      // Task #496 latency addendum: measure ingest→browser latency in dev from
      // the ingest-accept wall clock the server stamped on the tip.
      if (typeof msg.tickWallMs === "number" && import.meta.env.DEV) {
        const latencyMs = Date.now() - msg.tickWallMs;
        if (latencyMs >= 0) {
          // eslint-disable-next-line no-console
          console.debug(`[forming-tip] ingest→browser latency ≈ ${latencyMs}ms`);
        }
      }
      const b = msg.bar;
      if (
        typeof b.openTimeMs !== "number" ||
        typeof b.open !== "number" ||
        typeof b.high !== "number" ||
        typeof b.low !== "number" ||
        typeof b.close !== "number"
      )
        return;
      const tipSec = Math.floor(b.openTimeMs / 1000);
      // Never feed an out-of-order time (the adapter also guards defensively).
      if (newestBarSecRef.current != null && tipSec < newestBarSecRef.current) return;
      adapter.updateActiveCandle({
        time: tipSec,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      });
      newestBarSecRef.current = tipSec;
    };
    es.onerror = () => {
      if (disposed || activeChartContext.current?.key !== chartContext || activeChartContext.current.adapter !== ownedAdapter) return;
      // The browser retries an EventSource on its own, but only for errors it
      // actually surfaces — and it never recovers a connection that stays "open"
      // while silently delivering nothing. Record the state so the UI is honest;
      // the watchdog owns the reconnect for both cases.
      streamWatchdog.noteError();
    };

    return () => {
      disposed = true;
      es?.close();
    };
    // The watchdog's callbacks are stable; `epoch` is the reconnect signal and
    // this effect's cleanup closes the dead stream before the replacement opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedSymbol, timeframe, streamWatchdog.epoch, tickSource, chartContext]);

  // ── Deep-history scroll-back wiring. Register a stable handler with the engine
  //    that fires when the user pans near the oldest loaded bar; it asks the
  //    history hook for the next older page (seeded from the oldest on-screen
  //    bar). Re-registered on chartEpoch so a rebuilt engine keeps scroll-back.
  //    View-only — this loads market data, never a trade.
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter?.setReachStartHandler) return;
    adapter.setReachStartHandler(() => {
      deepHistory.loadOlder(oldestIsoRef.current);
    });
    return () => {
      adapter.setReachStartHandler?.(null);
    };
    // deepHistory.loadOlder is stable per (symbol, apiTf, hasMore); oldest comes
    // from a ref so the handler need not re-bind on every new bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepHistory.loadOlder, chartEpoch]);

  // ── Level 4 — draw the read-only trade overlays through the engine WITHOUT
  //    rebuilding it. The adapter clears + redraws lines/zones/markers and is
  //    crash-safe per line so a bad overlay can never blank the chart.
  //
  //    The chartEpoch dependency ensures overlays are redrawn onto the fresh
  //    engine after a symbol/timeframe switch, so levels from instrument A can
  //    never persist onto instrument B.
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    // Markers anchor to the most recent bar so they stay visible for open positions.
    const lastCandle = candles[candles.length - 1];
    const lastTime =
      lastCandle && Number.isFinite(new Date(lastCandle.openTime).getTime())
        ? Math.floor(new Date(lastCandle.openTime).getTime() / 1000)
        : null;
    adapter.setOverlays(overlays, lastTime);
  }, [overlays, candles, chartEpoch]);

  // ── Level 4 — track P/L bubble coordinates. Overlays whose metadata carries a
  //    finite `pnl` get a floating bubble anchored to their price; we recompute
  //    the Y coordinate on a light loop so it follows zoom / scroll / resize.
  useEffect(() => {
    const pnlOverlays = overlays.filter(
      (o) => o.price != null && overlayMetaNumber(o, "pnl") !== null,
    );
    if (pnlOverlays.length === 0) {
      setBubbles([]);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    const tick = () => {
      const adapter = adapterRef.current;
      if (adapter) {
        const next: typeof bubbles = [];
        for (const o of pnlOverlays) {
          const y = adapter.priceToCoordinate(o.price as number);
          if (y != null && Number.isFinite(y)) {
            next.push({
              id: o.id,
              y,
              pnl: overlayMetaNumber(o, "pnl")!,
              side: overlayMetaString(o, "side"),
              mode: overlayMetaString(o, "mode"),
            });
          }
        }
        // Only commit when something actually moved/changed to avoid a rerender
        // on every 150ms tick while a position sits still.
        setBubbles((prev) => {
          if (
            prev.length === next.length &&
            prev.every((b, idx) => {
              const n = next[idx]!;
              return (
                b.id === n.id &&
                b.y === n.y &&
                b.pnl === n.pnl &&
                b.side === n.side &&
                b.mode === n.mode
              );
            })
          ) {
            return prev;
          }
          return next;
        });
      }
      timer = setTimeout(() => { raf = requestAnimationFrame(tick); }, 150);
    };
    tick();
    return () => {
      if (timer != null) clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [overlays, chartEpoch]);

  const positionCount = useMemo(
    () => overlays.filter((o) => o.metadata?.primary === true).length,
    [overlays],
  );

  const lastClose = hasCandles ? candles[candles.length - 1]!.close : null;
  const feedStatus = data?.feedStatus ?? null;
  const warning = data?.warning ?? null;
  const conf = feedConfidence(feedStatus);

  // Cap the Level 3 feed badge by the SHARED scanner-truth verdict (Task #521)
  // so the chip can never claim Clean/AI when the resolved truth for this exact
  // symbol/timeframe is downgraded or still unresolved — mirroring RubyChartRead.
  // Normalize first: `timeframe` is contract-style ("M15") but useScannerTruth's
  // toApiTimeframe only understands chart ids, so a raw label would resolve the
  // wrong (M5) feed. This is a read-only verdict for the badge ONLY; the Level 5
  // context report below intentionally keeps using the raw conf.aiUsable.
  const { truth: badgeTruth } = useScannerTruth(
    resolvedSymbol,
    normalizeChartTimeframe(timeframe),
  );
  const badgeAiUsableResolved = resolveFeedBadgeVerdict(
    badgeTruth?.analysis.level ?? null,
  );

  // ── Level 4 — read-only structural overlay (Task #651). Draw the detected
  //    trendlines / channel rails + break/retest/reclaim markers the backend
  //    Chart Intelligence ALREADY resolved (`intelligenceState.trendlineOverlay`).
  //    This is DISPLAY-ONLY: it adds no trade affordance, touches no execution
  //    path, and fabricates no geometry (every point is a real candle time/price
  //    decided server-side).
  //
  //    DOUBLE-GATED honesty: the backend already fails the overlay closed
  //    (`visible:false`) unless the feed was live-confirmed AND a real trendline
  //    was detected; the frontend re-gates on this chart's OWN feed-confidence
  //    verdict (`conf.aiUsable`) and the shared live-price affordance, so a
  //    non-live / unconfirmed feed can never show structure. When any gate is
  //    false we CLEAR the structural channel (also covers symbol/timeframe switch
  //    via chartEpoch, so structure from instrument A never bleeds onto B).
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter?.setStructureLines) return;

    const overlay = intelligenceState?.trendlineOverlay;
    const mayDraw =
      overlay != null && overlay.visible && conf.aiUsable && isLivePriceAffordance
      && intelligenceState?.truthState?.source === historySource
      && (!overlayRequiresEvidence || hasMatchingOverlayEvidence(evidence, intelligenceQuery.data));

    if (!mayDraw || !overlay) {
      adapter.setStructureLines([], []);
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

    const markers: ChartStructureMarker[] = overlay.markers.map((m) => ({
      time: m.time,
      // Anchor side by bias (support breaks below, resistance above); the dot
      // sits on the bar — never at an arbitrary price (engine rule).
      position: m.bias === "bullish" ? "belowBar" : "aboveBar",
      color: markerColor(m.kind),
      label: m.label,
    }));

    adapter.setStructureLines(lines, markers);
    // displayStatus is captured via `isLivePriceAffordance` (derived from it) +
    // `conf.aiUsable`; chartEpoch re-runs this after a context reset so structure
    // is applied only to the matching instrument, timeframe and provider.
  }, [intelligenceState, conf.aiUsable, isLivePriceAffordance, chartEpoch, historySource, overlayRequiresEvidence, evidence, intelligenceQuery.data]);

  // Phase 2 — mirror status derived from feed quality + fetch state.
  const mirrorStatus = getMirrorStatus(
    feedStatus?.quality,
    feedStatus?.stale,
    query.isFetching && !query.isLoading,
  );
  const mirrorStyle = MIRROR_STYLE[mirrorStatus];

  // Phase 2 — Chart Safe Mode: active when candles exist but the integrity
  // check failed (quality="invalid"). We still show the candles (they are
  // real, just flagged) but overlay a clear warning so no AI/analysis relies
  // on them. The open-positions overlays remain visible because execution state
  // is independent from feed quality.
  const isSafeMode = hasCandles && feedStatus?.quality === "invalid";

  // Phase 2 — OHLC diversity check. If >80% of sampled bars are flat (no
  // spread between high and low), the feed is not providing real OHLC candles
  // and the "candlestick chart" label is misleading.
  const ohlcAvailable = useMemo(() => checkOhlcDiversity(candles), [candles]);

  // Level 5 — report the chart's resolved symbol/timeframe + the Level 3
  // aiUsable verdict to a parent so it can source AI overlays against the exact
  // instrument on screen and suppress them on an unconfirmed feed. Guarded by a
  // dedupe ref so it only fires on a real change (mount + change). PURE
  // read-out: this never touches candles, overlays, or trade execution.
  const lastCtxRef = useRef<string>("");
  useEffect(() => {
    if (!onChartContextChange) return;
    const key = `${resolvedSymbol}|${timeframe}|${conf.aiUsable ? 1 : 0}`;
    if (lastCtxRef.current === key) return;
    lastCtxRef.current = key;
    onChartContextChange({
      symbol: resolvedSymbol,
      timeframe,
      aiUsable: conf.aiUsable,
    });
  }, [resolvedSymbol, timeframe, conf.aiUsable, onChartContextChange]);

  // Only surface the prominent banner once real candles are on screen — the
  // empty/error overlays already own the no-data story.
  const showPoorBanner =
    showFeedStatus && hasCandles && !isSafeMode && conf.severity !== "clean";
  const showNotAiConfirmed = showFeedStatus && hasCandles && !conf.aiUsable && !isSafeMode;

  const decimals = useMemo(() => {
    const sample = lastClose ?? 1;
    return sample < 10 ? 5 : sample < 1000 ? 3 : 2;
  }, [lastClose]);

  const isInitialLoading = query.isLoading && !hasCandles;
  const isError = query.isError && !hasCandles;
  // The contract returns 200 with an honest empty list when no feed is available.
  const isEmpty = !isInitialLoading && !isError && !hasCandles;

  return (
    <Card ref={cardRef} role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label={expanded ? `${resolvedSymbol} fullscreen chart` : undefined} data-testid="arx-native-chart" className={expanded ? "fixed inset-0 z-50 overflow-auto rounded-none border-zinc-800 bg-zinc-950" : "overflow-hidden border-zinc-800 bg-zinc-950/40"}>
      <CardHeader className="py-3 px-3 md:px-4">
        <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <CandlestickChart className="h-4 w-4 text-primary" />
            <Badge variant="outline" className="text-[10px]">ARX NATIVE</Badge>
            <span data-testid="arx-native-symbol" className="text-base font-semibold text-zinc-100">
              {resolvedSymbol}
            </span>
            {mode && (
              <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground" data-testid="arx-native-mode">
                {mode}
              </Badge>
            )}
            {lastClose != null && (
              <Badge variant="outline" className="font-mono text-xs" data-testid="arx-native-last">
                {lastClose.toFixed(decimals)}
              </Badge>
            )}
            {positionCount > 0 && (
              <Badge
                variant="outline"
                className="border-blue-500/40 text-[10px] text-blue-300"
                data-testid="arx-native-pos-count"
              >
                {positionCount} open
              </Badge>
            )}
            {showFeedStatus && feedStatus && (
              <FeedConfidenceBadge
                feedStatus={feedStatus}
                aiUsableResolved={badgeAiUsableResolved}
                showFallback={showFallbackToggle}
                onRequestFallback={onRequestFallback}
              />
            )}
            {showNotAiConfirmed && (
              <Badge
                variant="outline"
                className="flex items-center gap-1 border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-200"
                data-testid="arx-native-not-ai"
              >
                <ShieldAlert className="h-3 w-3" /> Not AI-confirmed
              </Badge>
            )}
            {marketFrozen && (
              <Badge
                variant="outline"
                className="flex items-center gap-1 border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-200"
                data-testid="arx-native-market-closed"
                title="The broker is replaying its last quote — the market is closed (derived from real tick broker-time staleness, not a calendar)."
              >
                <Clock className="h-3 w-3" /> {formatMarketClosedLabel(marketFrozen.lastBrokerTimeMs)}
              </Badge>
            )}
            {/* Theme C3.5 — an honestly-labelled stalled stream. A chart whose
                tick-stream has stopped delivering must SAY so; the failure mode
                being fixed is precisely a frozen chart that still looked live.
                Suppressed when the market is legitimately closed, because that
                already explains the silence and is the more specific verdict. */}
            {streamWatchdog.stalled && !marketFrozen && (
              <Badge
                variant="outline"
                className="flex items-center gap-1 border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-200"
                data-testid="arx-native-stream-reconnecting"
                title="The live tick stream stopped delivering and is being reopened. Prices shown are the last received — they are not updating right now."
              >
                <RefreshCw className="h-3 w-3 animate-spin" /> Reconnecting — prices delayed
              </Badge>
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
          </div>
          {/* Phase 2 — TF controls + Reset Scale button. */}
          <div className="flex flex-wrap items-center gap-1" data-testid="arx-native-tf-controls">
            {hasCandles && (
              <span className="mr-1 text-[10px] text-zinc-500" data-testid="arx-native-timezone" title={CHART_TIME_AXIS_TITLE}>
                {CHART_TIME_AXIS_LABEL}
              </span>
            )}
            {replay && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" title="Replay the current source-identified response window; separately paginated older history is not included" disabled={!hasCandles || query.isFetching || query.isError} onClick={()=>setReplayError(replay.open(data,preferences,{symbol:resolvedSymbol,timeframe}))}>Replay loaded bars</Button>}
            {TIMEFRAMES.map((tf) => (
              <Button
                key={tf.id}
                size="sm"
                variant={timeframe === tf.id ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setTimeframe(tf.id)}
                aria-pressed={timeframe === tf.id}
                aria-label={`${tf.label} timeframe`}
                data-testid={`arx-native-tf-${tf.id}`}
              >
                {tf.label}
              </Button>
            ))}
            {hasCandles && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px] text-zinc-500 hover:text-zinc-300"
                onClick={resetScale}
                aria-label="Reset chart scale"
                title="Reset scale — restore default visible range"
                data-testid="arx-native-reset-scale"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </CardTitle>
      </CardHeader>

      {replayError && <p className="px-3 pb-2 text-xs text-amber-300" role="status">{replayError}</p>}

      {/* Phase 2 — Chart Mirror Layer.
          Compact status bar between the header and the canvas. Shows the
          mirror state (Mirrored / Syncing / Stale / Conflict / Refreshing),
          the locked symbol and timeframe, and a Mirror Lock toggle.
          When locked: "Mirrored · SYMBOL · TF" — chart is in sync.
          When unlocked: "Inspection mode" badge — chart may diverge.
          This is purely informational; it never gates candles or trades. */}
      <div
        className="flex items-center gap-2 border-b border-zinc-800/60 bg-zinc-950/20 px-3 py-1.5 text-[10px]"
        data-testid="arx-mirror-layer"
      >
        {/* Status dot + label */}
        <span
          className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${mirrorStyle.dot}`}
        />
        <span className={`font-medium ${mirrorStyle.text}`} data-testid="arx-mirror-status">
          {mirrorStatus}
        </span>
        {/* Symbol · Timeframe */}
        <span className="text-zinc-500">
          {resolvedSymbol} · {timeframe}
        </span>
        {/* Mirror state detail */}
        {mirrorStatus === "Conflict" && (
          <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[9px] text-red-300" data-testid="arx-mirror-conflict">
            Data integrity failed — use TradingView for reference
          </span>
        )}
        {mirrorStatus === "Stale" && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-300" data-testid="arx-mirror-stale">
            Feed is stale
          </span>
        )}
        {mirrorStatus === "Syncing" && (
          <span className="rounded border border-zinc-700 bg-zinc-800/40 px-1.5 py-0.5 text-[9px] text-zinc-400" data-testid="arx-mirror-syncing">
            Waiting for data
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {!mirrorLocked && (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 text-[9px] text-amber-300"
              data-testid="arx-mirror-inspection"
            >
              <GitMerge className="mr-0.5 h-2.5 w-2.5" />
              Inspection mode
            </Badge>
          )}
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] transition-colors ${
              mirrorLocked
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                : "border-zinc-600 bg-zinc-800/40 text-zinc-400 hover:bg-zinc-700/40"
            }`}
            onClick={() => setMirrorLocked((l) => !l)}
            title={mirrorLocked ? "Mirror Lock ON — click to inspect freely" : "Mirror Lock OFF — click to re-lock"}
            data-testid="arx-mirror-lock"
          >
            {mirrorLocked ? (
              <Lock className="h-2.5 w-2.5" />
            ) : (
              <Unlock className="h-2.5 w-2.5" />
            )}
            {mirrorLocked ? "Lock ON" : "Lock OFF"}
          </button>
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2" role="toolbar" aria-label="Chart view controls">
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!hasCandles} onClick={() => adapterRef.current?.goToLatest?.()} title="Return to latest candles (End)">
            <ArrowRightToLine className="mr-1 h-3.5 w-3.5" /> Latest
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!hasCandles} onClick={() => adapterRef.current?.fitHistory?.()} title="Fit all loaded history (Home)">Fit history</Button>
          <label className="ml-1 flex items-center gap-2 text-xs text-zinc-400">Scale<select aria-label="Price scale" className="h-8 rounded border border-zinc-700 bg-zinc-900 px-2 text-zinc-100" value={scaleMode} onChange={event => setPreferences(p => ({...p, scale:event.target.value as typeof p.scale}))}>
            <option value="linear">Regular price</option><option value="log">Logarithmic</option><option value="percent">Percentage</option><option value="indexed">Indexed to 100</option>
          </select></label>
          <Button size="sm" variant="ghost" className="h-8 text-xs" aria-pressed={preferences.inverted === true} onClick={() => setPreferences(p => ({...p,inverted:!p.inverted}))}>Invert scale</Button>
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs" aria-pressed={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <Minimize2 className="mr-1 h-3.5 w-3.5" /> : <Maximize2 className="mr-1 h-3.5 w-3.5" />}
          {expanded ? "Exit fullscreen" : "Fullscreen"}
        </Button>
      </div>
      <ChartWorkbenchTools key={chartContext} adapter={adapterRef.current} epoch={chartEpoch} symbol={resolvedSymbol} timeframe={timeframe} preferences={preferences} onPreferences={setPreferences} hasCandles={hasCandles} feedLabel={`${data?.feedStatus?.source ?? "Unknown source"} · ${isLivePriceAffordance ? "Live at capture" : "Not live-confirmed"} · ${data?.feedStatus?.warning ?? "Display only"}`} />
      {!preferencesSaved && <p className="px-3 py-2 text-xs text-amber-300" role="alert">Browser storage is unavailable. Chart preferences will reset when this view closes.</p>}
      <SmartChartReader key={`${resolvedSymbol}:${timeframe}:${evidenceIdentity??"unidentified"}`} adapter={adapterRef.current} epoch={chartEpoch} symbol={resolvedSymbol} timeframe={timeframe} data={data} older={deepHistory.olderCandles} historyEvidence={deepHistory.analysisEvidence} liveConfirmed={isLivePriceAffordance} readFailed={query.isError} view={preferences} />
      <output ref={legendRef} aria-label="Candle time and OHLC prices" className="block min-h-8 overflow-x-auto whitespace-nowrap px-3 py-2 font-mono text-[11px] text-zinc-300" data-testid="chart-candle-inspector">
        Move the crosshair over a candle to inspect it
      </output>
      <output ref={linkStatusRef} aria-label="Linked chart history status" className="block px-3 text-xs text-amber-300 empty:hidden" />
      <details ref={dataWindowRef} className="border-t border-zinc-800 px-3 py-2 text-xs" onToggle={() => updateLegend(inspectedCandleRef.current)}>
        <summary className="cursor-pointer text-zinc-400">Data window · study values at the crosshair</summary>
        <output ref={studyInspectorRef} aria-label="Study values at selected candle" className="mt-2 block font-mono text-[11px] text-zinc-300">Add a study to inspect its values.</output>
      </details>
      <CardContent className="relative p-0">
        {/* The chart canvas is always mounted so the v5 series handle is stable;
            overlays cover it for loading / empty / error. */}
        <div
          ref={containerRef}
          tabIndex={0}
          role="region"
          aria-label={`${resolvedSymbol} ${timeframe} price chart. Drag or arrow keys to pan; scroll, plus or minus to zoom. Home fits history; End returns to latest candles.`}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === "End") { event.preventDefault(); adapterRef.current?.goToLatest?.(); }
            if (event.key === "Home") { event.preventDefault(); adapterRef.current?.fitHistory?.(); }
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); adapterRef.current?.panBy?.(event.key === "ArrowLeft" ? -0.25 : 0.25); }
            if (event.key === "+" || event.key === "=") { event.preventDefault(); adapterRef.current?.zoomBy?.(0.75); }
            if (event.key === "-" || event.key === "_") { event.preventDefault(); adapterRef.current?.zoomBy?.(4/3); }
          }}
          data-testid="arx-native-canvas"
          className="w-full overflow-hidden"
          style={{ height: effectiveHeight }}
        />

        {/* Level 4 — floating P/L bubbles. Pure visual layer (pointer-events
            none): anchored to each position's price via priceToCoordinate, so
            they never intercept chart interaction and disappear cleanly when no
            position is open. */}
        {hasCandles && bubbles.length > 0 && (
          <div className="pointer-events-none absolute inset-0 z-10" data-testid="arx-native-pnl-layer">
            {bubbles.map((b) => (
              <div
                key={b.id}
                data-testid="arx-native-pnl-bubble"
                className={`absolute right-16 -translate-y-1/2 rounded-md border px-2 py-0.5 font-mono text-[11px] shadow-sm backdrop-blur-sm ${
                  b.pnl >= 0
                    ? "border-emerald-500/40 bg-emerald-950/70 text-emerald-200"
                    : "border-red-500/40 bg-red-950/70 text-red-200"
                }`}
                style={{ top: b.y }}
              >
                {b.side ? `${b.side} ` : ""}
                {b.pnl >= 0 ? "+" : ""}
                {b.pnl.toFixed(2)}
                {b.mode ? ` · ${b.mode}` : ""}
              </div>
            ))}
          </div>
        )}

        {/* Phase 2 — Chart Safe Mode overlay.
            When quality="invalid" (integrity check failed) we show a clear
            user-safe message over the chart. Candles are still drawn beneath
            because they are real data (just flagged). Open position overlays
            remain visible. AI reads are paused (conf.aiUsable will be false).
            This is NOT an error state — it is a "read with extreme caution"
            state. We never invent a safe state or pretend the data is clean. */}
        {isSafeMode && (
          <div
            className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-start gap-3 bg-red-950/80 px-3 py-3 text-xs backdrop-blur-sm"
            data-testid="arx-native-safe-mode"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-red-100">Chart Safe Mode — data validation failed</div>
              <div className="mt-0.5 text-[11px] text-red-300/90">
                {warning || "Candle integrity checks failed. This chart is not confirmed for AI analysis or live decisions."}
              </div>
            </div>
            {showFallbackToggle && onRequestFallback && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 border-red-500/40 px-2 text-xs text-red-200 hover:bg-red-950/60"
                onClick={onRequestFallback}
                data-testid="arx-native-fallback-safemode"
              >
                <BarChart3 className="mr-1 h-3.5 w-3.5" /> Use TradingView
              </Button>
            )}
          </div>
        )}

        {/* Phase 2 — OHLC mode indicator.
            When candles are present but the spread check fails (flat bars), the
            candlestick label is misleading. We add a labeled banner so the user
            knows what they are looking at. This is NOT an error — the feed is
            returning data, it just lacks meaningful OHLC spread. */}
        {hasCandles && !ohlcAvailable && !isSafeMode && (
          <div
            className="absolute inset-x-0 top-0 z-20 flex items-center gap-2 bg-amber-950/70 px-3 py-2 text-xs backdrop-blur-sm"
            data-testid="arx-native-line-mode"
          >
            <LineChart className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span className="text-amber-200">
              Line mode — OHLC candles are flat on this feed. Price action shown, no spread.
            </span>
          </div>
        )}

        {/* Prominent feed banner — only when candles are drawn but the feed is
            degraded/stale (and NOT in safe mode, which has its own overlay). */}
        {showPoorBanner && (
          <div
            data-testid="arx-native-feed-banner"
            data-severity={conf.severity}
            className={`absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 px-3 py-2 text-xs backdrop-blur-sm ${
              conf.severity === "danger"
                ? "bg-red-950/70 text-red-100"
                : conf.severity === "caution"
                  ? "bg-amber-950/60 text-amber-100"
                  : "bg-zinc-900/70 text-zinc-100"
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="font-semibold">{conf.statusLabel} feed</span>
            <span className="min-w-0 flex-1 truncate text-[11px] opacity-90">
              {conf.message}
            </span>
            {query.isFetching && !query.isLoading && (
              <RefreshCw className="h-3 w-3 animate-spin opacity-60" />
            )}
            {conf.suggestFallback && showFallbackToggle && onRequestFallback && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={onRequestFallback}
                data-testid="arx-native-fallback-stale"
              >
                <BarChart3 className="mr-1 h-3.5 w-3.5" /> Use TradingView
              </Button>
            )}
          </div>
        )}

        {isInitialLoading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/60 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading native candles…
          </div>
        )}

        {isError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/95 p-4 text-center" data-testid="arx-native-error">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
            <p className="text-sm font-semibold">Native chart unavailable</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Couldn't load native candles for {resolvedSymbol}. Your data and connection are unaffected.
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void query.refetch()} data-testid="arx-native-retry">
                Retry
              </Button>
              {showFallbackToggle && onRequestFallback && (
                <Button size="sm" onClick={onRequestFallback} data-testid="arx-native-fallback-error">
                  <BarChart3 className="mr-1 h-3.5 w-3.5" /> Use TradingView
                </Button>
              )}
            </div>
          </div>
        )}

        {isEmpty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/95 p-4 text-center" data-testid="arx-native-empty">
            <CandlestickChart className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-semibold">
              {feedStatus?.quality === "unavailable"
                ? "Chart data is syncing"
                : "No native candles available"}
            </p>
            <p className="max-w-md text-xs text-muted-foreground">
              {feedStatus?.quality === "unavailable"
                ? "Waiting for a live feed to connect. Try again in a moment or use TradingView for reference."
                : warning ||
                  `No native candles available for ${resolvedSymbol} on ${timeframe} right now.`}
            </p>
            {showFallbackToggle && onRequestFallback && (
              <Button size="sm" onClick={onRequestFallback} data-testid="arx-native-fallback-empty">
                <BarChart3 className="mr-1 h-3.5 w-3.5" /> Use TradingView reference
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ARXNativeChart;
