import {proposeChartSupportResistance} from "@/lib/chart-engine/chartSupportResistance";
import { reportRenderEvidence, RENDER_EVIDENCE_FIRST_MEASURE_MS, RENDER_EVIDENCE_REFRESH_MS, type RenderVerdict } from "@/lib/chart-engine/renderEvidenceReporter";
import { RenderVerdictChip } from "./RenderVerdictChip";
import {profileCandleEvidence} from "@/lib/chart-engine/chartVolumeProfile";
import { chartAssistantPaneContext } from "@/lib/chart-engine/chartAssistantPaneContext";
import { chartUtcClockQualified, formatSourceChartTime, SOURCE_CLOCK_NOTE } from "@/lib/chart-engine/chartClockEvidence";
import { proposeChartFibonacci } from "@/lib/chart-engine/chartAutoFibonacci";
import { captureSmartChartBars } from "@/lib/chart-engine/smartChartCapture";
import { formatStudyNumber } from "@/lib/chart-engine/chartStudies";
import { chartVolumeEvidence, observedTickVolume, observedTradeVolume, chartDisplayStudies, candleVolumeLabel } from "@/lib/chart-engine/chartVolume";
import { executeStudyRequest, registerChartStudyAssistant } from "@/lib/chart-engine/chartStudyAssistant";
import { registerChartResearchAssistant, answerChartResearchFollowup, type ChartResearchExplanation } from "@/lib/chart-research/chartResearchAssistant";
import { CandleCloseCountdown } from "./CandleCloseCountdown";
import { ChartLayersMenu } from "./ChartLayersMenu";
import { StructuralForecastPanel } from "./StructuralForecastPanel";
import type { GhostPath, Scenario } from "@workspace/domain/structural";
import {
  allLayers,
  overlayLayer,
  SCENARIO_LAYERS,
  structureMarkerLayer,
  visibleOverlays,
  type ChartLayerId,
  type ChartLayerVisibility,
} from "@/lib/chart-engine/layers";
import type { ChartGhostPath } from "@/lib/chart-engine/types";
import type { ScannerChartSurface } from "@/lib/chart-engine/scannerChartSurface";
import { chartTickSource, matchesChartTickContext } from "@/lib/chartTickStreamContext";
import { CHART_INTERVALS, CHART_QUICK_INTERVALS, isChartInterval, restoreChartInterval, chartIntervalLimitation, chartIntervalSeconds, chartBarCloseSeconds } from "@/lib/chart-engine/chartIntervals";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, useContext, type ReactNode, type HTMLAttributes, Fragment } from "react";
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
  ShieldAlert,
  RotateCcw,
  RefreshCw,
  AlertCircle,
  LineChart,
  Clock,
  Maximize2,
  Minimize2,
  ArrowRightToLine,
} from "lucide-react";
import { ChartWorkbenchTools, chartExportFeedLabel } from "./ChartWorkbenchTools";
import { ChartTemplatesPanel } from "./ChartTemplatesPanel";
import { SmartChartReader } from "./SmartChartReader";
import { AssistantDockSlot, useAssistantChartPane } from "@/components/help/AssistantDock";
import { PREFERENCES_KEY, readChartStorage, validatePreferences, writeChartStorage } from "@/lib/chart-engine/chartWorkspace";
import { effectiveDisplayZone, resolveTimeZone, zoneShortLabel, type ChartTimeZone } from "@/lib/chart-engine/chartTimeZone";
import { formatInstrumentPrice, resolveDisplayPricePrecision } from "@/lib/instrumentPriceFormat";
import { publishChartPricePrecision } from "@/components/charts/chartPricePrecisionStore";
import { CHART_TIME_AXIS_LABEL, CHART_TIME_AXIS_TITLE, type ServerClockSample } from "@/components/scanner/scannerChartFormat";
import { publishScannerTip } from "@/lib/scannerLiveTipStore";
import { bareSymbol } from "@/lib/use-chart-symbol";
import { useChartDeepHistory } from "@/lib/useChartDeepHistory";
import { ChartHistoryBadge } from "@/components/charts/ChartHistoryBadge";
import { ChartHistoryControls } from "@/components/charts/ChartHistoryControls";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";
import { frozenQuoteChip } from "@/components/charts/marketFrozenFormat";
import { scheduledWeekendClosureFor, nextWeekendClosureBoundaryMs } from "@/lib/scannerTruth";
import { useTickStreamWatchdog } from "@/components/charts/useTickStreamWatchdog";
import { capConfidence, feedConfidence } from "@/lib/feed-confidence";
import { resolveDisplayStatus, isLivePriceDisplay } from "@/lib/chart-display-status";
import { useScannerTruth } from "@/hooks/useScannerTruth";
import { normalizeChartTimeframe } from "@/lib/chartCandlesQuery";
import { resolveFeedBadgeVerdict } from "@/lib/eleanorReadPanelState";
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

const ChartResearchWorkbench = lazy(() => import("@/components/testing-lab/ChartResearchWorkbench"));

// ARXNativeChart — Level 2 native chart shell.
//
// Renders clean candlesticks from the Level 1 normalized contract
// (GET /api/chart/candles via the generated useGetChartCandles hook). This is a
// shared ARX Smart Chart, used by the Scanner and the standalone chart pages.
//
// HONESTY / SAFETY:
//  - Candles come ONLY from the normalized /api/chart/candles contract, which is
//    itself built over the existing market-data router. We NEVER fabricate bars.
//    When the contract returns an honest empty/unavailable state we show a clear
//    "no candles" message — never
//    a blank or fake chart.
//  - This is a view-only chart: it has no order-placement surface. Trade actions
//    live elsewhere (the gated instant-trade router).
//  - Level 3 feed confidence: the header renders a FeedConfidenceBadge driven by
//    the contract's embedded feedStatus (source/live/stale/latency/last update/
//    missing-candle count/AI-usable/warning). When the feed is stale or poor a
//    prominent banner explains the feed limitation, and when aiUsable=false
//    the chart is visibly marked "not AI-confirmed" so Level 5 overlays respect it.
//
// Phase 2 additions:
//  - Smart visible range: default shows last 150 candles (mobile: 80) so the
//    chart opens to recent price action, not a compressed full-history view.
//  - Reset Scale button: always-available control to restore the default range.
//  - Feed strip: compact status bar naming the server's grade of the current
//    candle response (the same capped label as the header chip), with a
//    separate "Refreshing…" marker that never hides a stale/invalid verdict.
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

const TIMEFRAMES = CHART_QUICK_INTERVALS.map(id => ({id,label:id}));
const MORE_TIMEFRAMES = CHART_INTERVALS.filter(id => !(CHART_QUICK_INTERVALS as readonly string[]).includes(id));

const TF_KEY = "arx.nativeChart.timeframe";
const DEFAULT_TF: ArxTimeframe = "M15";
const EMPTY_OVERLAYS: ChartOverlay[] = [];
/** Candle poll cadence; the header chip's truth cap polls at the same rate. */
const CANDLE_POLL_MS = 8000;

// Comparison engine init is staged out of the frame that mounts the card.
// The card, its controls and its sized canvas container commit synchronously;
// only the ARX Canvas engine (init + its own first paint, the dominant
// cost of adding comparison views) waits until after the mounting frame has
// painted. A single rAF queued during the commit would still run inside that
// frame, before its paint, so each job waits for an animation frame and then a
// macrotask. Jobs share one queue and run one per frame, so adding several
// comparisons never stacks their engine paints into a single frame. A hidden
// document gets no animation frames, so a hidden tab (at scheduling time, or
// becoming hidden while the frame is pending) falls back to the task alone.
type DeferredEngineInit = { run: () => void; cancelled: boolean };
const deferredEngineInits: DeferredEngineInit[] = [];
let deferredEngineInitPending = false;

function pumpDeferredEngineInits(): void {
  while (deferredEngineInits[0]?.cancelled) deferredEngineInits.shift();
  if (deferredEngineInitPending || deferredEngineInits.length === 0) return;
  deferredEngineInitPending = true;
  const runNext = () => {
    deferredEngineInitPending = false;
    let job = deferredEngineInits.shift();
    while (job?.cancelled) job = deferredEngineInits.shift();
    try { job?.run(); } finally { pumpDeferredEngineInits(); }
  };
  const hasDocument = typeof document !== "undefined";
  let afterPaintQueued = false;
  const onVisibilityChange = () => { if (document.hidden) afterPaint(); };
  // Whichever comes first, the frame or the tab being hidden, queues the task
  // once; the other then no-ops.
  function afterPaint() {
    if (afterPaintQueued) return;
    afterPaintQueued = true;
    if (hasDocument) document.removeEventListener("visibilitychange", onVisibilityChange);
    setTimeout(runNext, 0);
  }
  if (typeof requestAnimationFrame !== "function" || (hasDocument && document.hidden)) {
    afterPaint();
    return;
  }
  if (hasDocument) document.addEventListener("visibilitychange", onVisibilityChange);
  requestAnimationFrame(() => afterPaint());
}

function scheduleDeferredEngineInit(run: () => void): () => void {
  const job: DeferredEngineInit = { run, cancelled: false };
  deferredEngineInits.push(job);
  pumpDeferredEngineInits();
  return () => {
    job.cancelled = true;
    const index = deferredEngineInits.indexOf(job);
    if (index >= 0) deferredEngineInits.splice(index, 1);
  };
}

function loadTimeframe(): ArxTimeframe {
  if (typeof window === "undefined") return DEFAULT_TF;
  let v: string | null = null;
  try { v = localStorage.getItem(TF_KEY); } catch { /* private storage unavailable */ }
  return restoreChartInterval(v, DEFAULT_TF);
}

// Feed strip — the one-line status bar under the header. It states the server's
// own grade of THIS candle response (quality / stale / live flags), capped by
// the same shared scanner-truth verdict as the header chip so the two never
// disagree. It measures nothing else: there is no broker-mirror comparison
// behind it, so it never claims the chart is "mirrored" or "syncing".
type FeedStripTone = "clean" | "caution" | "danger" | "unknown";

const FEED_STRIP_STYLE: Record<FeedStripTone, { dot: string; text: string }> = {
  clean: { dot: "bg-emerald-400", text: "text-emerald-300" },
  caution: { dot: "bg-amber-400", text: "text-amber-300" },
  danger: { dot: "bg-red-400", text: "text-red-300" },
  unknown: { dot: "bg-zinc-400", text: "text-zinc-300" },
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
  /** Compact command-workspace mode keeps the full plot in view and discloses secondary tools. */
  compactWorkspace?: boolean;
  /** Show the minimal honest quality chip (default true). Level 3 owns the rich badge. */
  showFeedStatus?: boolean;
  /** Scanner supplies its existing shared query, including original candle
   * provenance/finality. Supplying this disables the standalone candle fetch. */
  externalFeed?: {
    data: ChartCandlesResponse | undefined;
    isLoading: boolean;
    isFetching: boolean;
    isError: boolean;
    refetch: () => unknown;
    livePriceAllowed: boolean;
    /** When the last successful response arrived (epoch ms; 0/absent = unknown). */
    dataUpdatedAt?: number;
  };
  onScannerSurfaceChange?: (surface: ScannerChartSurface | null) => void;
  /**
   * Scanner only: the shared live-tip key (lib/scannerLiveTipStore). When set,
   * the forming-bar tip this chart applies to its axis is published there (at
   * the instrument precision, only while the live-price affordance holds) so
   * the Scanner header and badge show the SAME observation. Withdrawn on a
   * frozen or barless frame, a poll that replaces the tip, a context switch,
   * a non-live display and unmount. Display only.
   */
  liveTipKey?: string | null;
  /** Scanner only: the stream's market-frozen verdict, reported to the host. */
  onMarketFrozenChange?: (frozen: { lastBrokerTimeMs: number | null } | null) => void;
  canvasEvents?: Pick<HTMLAttributes<HTMLDivElement>, "onContextMenu" | "onPointerDown" | "onPointerUp" | "onPointerMove">;
  canvasOverlay?: ReactNode;
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
   * AI-usability verdict (true only on a clean feed whose shared scanner truth
   * is confirmed — the same verdict the header chip shows) whenever any of them
   * change. Lets a parent source AI overlays (scanner/Eleanor) against the exact
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
}

/** The first canvas and later viewport changes use the same sizing policy. */
function viewportChartHeight(height:number,mobileHeight:number|undefined,expanded:boolean,compactWorkspace:boolean):number {
  if(typeof window === "undefined")return height;
  if(expanded)return Math.max(240,window.innerHeight-240);
  if(window.innerWidth<768)return mobileHeight??Math.max(320,Math.min(height,380));
  // Reserve the time axis as well as at least ~360px of usable price plot.
  if(compactWorkspace && window.innerWidth >= 1024)return Math.min(Math.max(height,390), Math.floor(window.innerHeight * .65));
  return height;
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
  compactWorkspace = false,
  showFeedStatus = true,
  externalFeed,
  onScannerSurfaceChange,
  liveTipKey = null,
  onMarketFrozenChange,
  canvasEvents,
  canvasOverlay,
  limit = 300,
  overlays: suppliedOverlays = EMPTY_OVERLAYS,
  onChartContextChange,
  onIntelligenceChange,
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
  const [layers, setLayers] = useState<ChartLayerVisibility>(() => allLayers(true));
  const [scenarioGhostPaths, setScenarioGhostPaths] = useState<ChartGhostPath[]>([]);
  const [renderVerdict, setRenderVerdict] = useState<RenderVerdict | null>(null);
  const scaleMode = preferences.scale;

  useEffect(()=>{setPreferencesSaved(writeChartStorage(preferencesKey,preferences));},[preferences,preferencesKey]);
  const legendRef = useRef<HTMLOutputElement | null>(null);
  const studyInspectorRef = useRef<HTMLOutputElement | null>(null);
  const dataWindowRef = useRef<HTMLDetailsElement | null>(null);
  const inspectedCandleRef = useRef<ChartEngineCandle | null>(null);
  // The display zone the legend formats in. Assigned only by the zone layout
  // effect below, immediately before it relabels the engine and the legend.
  const timeZoneRef = useRef<ChartTimeZone>("UTC");
  const utcClockRef = useRef(false);
  const pricePrecisionRef = useRef<number | null>(null);
  const updateLegend = useCallback((candle: ChartEngineCandle | null) => {
    const bar = candle;
    inspectedCandleRef.current = bar;
    if (!legendRef.current) return;
    // Same instrument precision as the axis and header (pricePrecisionRef).
    const p = pricePrecisionRef.current;
    const px = (value: number) => formatInstrumentPrice(value, p);
    // Canonical OHLC always comes first. In Heikin Ashi style the averaged
    // display bar is appended, labelled HA; it is re-queried here so every
    // caller shows the same text.
    const ha = bar ? adapterRef.current?.getDisplayCandle?.(bar.time) ?? null : null;
    legendRef.current.textContent = bar
      ? `${formatSourceChartTime(bar.time, utcClockRef.current, timeZoneRef.current)}  ·  O ${px(bar.open)}  H ${px(bar.high)}  L ${px(bar.low)}  C ${px(bar.close)}  ·  Range H−L ${px(bar.high - bar.low)}  ·  ${candleVolumeLabel(bar.volumeEvidence)}${ha ? `  ·  HA (averaged, not tradable) O ${px(ha.open)}  H ${px(ha.high)}  L ${px(ha.low)}  C ${px(ha.close)}` : ""}`
      : "Move the crosshair over a candle to inspect it";
    if (studyInspectorRef.current && dataWindowRef.current?.open) {
      const rows = bar ? adapterRef.current?.getStudyValues?.(bar.time) ?? [] : [];
      const fragment = document.createDocumentFragment();
      for (const row of rows) {
        const line = document.createElement("div");
        line.className = "flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-zinc-800 py-1.5";
        const label = document.createElement("span");
        label.textContent = row.displayLabel ?? row.label;
        label.style.color = row.color;
        const values = document.createElement("span");
        values.textContent = row.values.map(item => `${item.name}: ${item.value == null ? (row.reason ? `— (${row.reason})` : item.name === "Ticks" || item.name === "Ticks (hidden)" ? "— (no qualified tick count)" : "— (warm-up / unavailable)") : formatStudyNumber(item.value,item.name)}`).join(" · ");
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
      // Portalled dialogs consume Escape/Tab before the chart-level trap.
      if (event.defaultPrevented) return;
      if (event.key === "Escape") setExpanded(false);
      if (event.key === "Tab") {
        const items = [...(cardRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), summary, a[href], [tabindex="0"]') ?? [])].filter(item=>item.getClientRects().length > 0 && getComputedStyle(item).visibility !== "hidden");
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
  const supportedTimeframe = isChartInterval(timeframe);
  // Per-view display zone; daily bars keep UTC labels. Display only.

  const [researchOpen,setResearchOpen] = useState(false);
  const [researchRequest,setResearchRequest] = useState<{id:number;text:string;context:string}|null>(null);
  const researchSequence = useRef(0);
  const researchExplanation = useRef<{context:string;evidence:ChartResearchExplanation}|null>(null);
  const [researchLayer,setResearchLayer] = useState<{context:string;rows:ChartOverlay[]}|null>(null);

  // Bumped each time the chart/series is (re)built so overlay effects redraw
  // onto the fresh series instead of a stale handle.
  const [engineGeneration, setEngineGeneration] = useState(0);
  const builtEngineGeneration = useRef(0);
  const requestPrimaryEngine = useRef<(() => void) | null>(null);
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
  const standaloneQuery = useGetChartCandles(
    { symbol: resolvedSymbol, timeframe, limit },
    {
      query: {
        queryKey: getGetChartCandlesQueryKey({ symbol: resolvedSymbol, timeframe, limit }),
        enabled: externalFeed == null && resolvedSymbol.length > 0 && supportedTimeframe,
        refetchInterval: CANDLE_POLL_MS,
        staleTime: 4000,
      },
    },
  );

  const query = externalFeed ?? standaloneQuery;

  const replay = useContext(ChartReplayContext);
  const [replayError,setReplayError] = useState<string | null>(null);
  const response: ChartCandlesResponse | undefined = query.data;
  const data = useMemo(() => supportedTimeframe && response?.symbol === resolvedSymbol && response.timeframe === timeframe
    && response.candles.every(candle => candle.symbol === resolvedSymbol
      && candle.timeframe === timeframe && candle.source === response.feedStatus?.source)
    ? response : undefined, [response, resolvedSymbol, timeframe, supportedTimeframe]);
  const candles = data?.candles ?? [];
  const nativeFormingSnapshot = candles.filter(c => c.isForming).at(-1) as
    (typeof candles[number] & { observedAt?: string; formingOrigin?: string }) | undefined;
  const nativeSnapshotObservedAt = nativeFormingSnapshot?.formingOrigin === "native_mt5_snapshot"
    && typeof nativeFormingSnapshot.observedAt === "string" && Number.isFinite(Date.parse(nativeFormingSnapshot.observedAt))
    ? new Date(nativeFormingSnapshot.observedAt).toISOString() : null;
  const hasCandles = candles.length > 0;
  // The latest refetch failed while React Query keeps the previous response on
  // screen. Those bars are a frozen cache, so every live / AI / clean claim
  // derived from them is withdrawn until a refresh succeeds again.
  const refreshFailed = query.isError && hasCandles;

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
  // Stored history (no live feed answered) carries no market evidence, so an
  // evidence-bound pager would refuse every page. Those bars are display-only
  // already; older stored pages are paged the same way, never as evidence.
  const storedHistoryFeed = data?.feedStatus?.notLiveReason === "stored_history";
  const deepHistory = useChartDeepHistory(resolvedSymbol, timeframe, hasCandles,
    data?.feedStatus?.source ?? null, evidenceIdentity, !storedHistoryFeed);
  const utcClockQualified = deepHistory.olderCandles.length === 0 && chartUtcClockQualified(candles);
  const displayZone = utcClockQualified ? effectiveDisplayZone(preferences.timeZone, timeframe) : "UTC";
  // The zone the axis and legend actually print in, stated beside the
  // timeframe chips. UTC uses the shared chart label; a chosen display zone is
  // named; bars whose UTC mapping is unverified say they are on the source clock.
  const timeAxisLabel = !utcClockQualified
    ? "Times: source clock (UTC unverified)"
    : resolveTimeZone(displayZone) === "UTC"
      ? CHART_TIME_AXIS_LABEL
      : `Times: ${zoneShortLabel(displayZone)}`;
  const timeAxisTitle = !utcClockQualified
    ? SOURCE_CLOCK_NOTE
    : resolveTimeZone(displayZone) === "UTC"
      ? CHART_TIME_AXIS_TITLE
      : `Chart time axis and candle times are shown in ${zoneShortLabel(displayZone)}. Candle data stays stamped in UTC.`;

  // ── Live-price affordance honesty (shared rule, Task #351) ──────────────────
  // The candlestick last-value label and the dashed "Last" price line are
  // live-price affordances. They must obey the SAME "never look more live than
  // the feed" rule the Scanner and position mini-charts use, so the verdict is
  // resolved through the shared chart-display-status module — not this chart's
  // own feed-confidence badge system (which stays as the header). The header
  // chip's text derives from the same feedStatus; the chip is additionally
  // capped (downgrade only) by the shared scanner truth further below. A
  // supplied Scanner feed can only withdraw the affordance, and a failed
  // refresh (frozen cached bars) always does.
  const isLivePriceAffordance = !refreshFailed && externalFeed?.livePriceAllowed !== false && isLivePriceDisplay(
    resolveDisplayStatus(data?.feedStatus ?? null, hasCandles),
  );
  // NOTE (Theme C3.3): this verdict is NOT mirrored into a ref for the SSE tick
  // handler any more. It describes the CLOSED-candle feed and is sticky, so
  // using it to gate live frames froze charts whose ticks were flowing fine.
  // Each frame carries its own server-computed `frozen` marker instead. This
  // value still drives the last-price affordance through setFeedState below.
  // The ref below gates ONLY the tip published to the Scanner header (a header
  // never shows a tick as current on a non-live display); frames still reach
  // the axis on their own `frozen` marker.
  const isLivePriceAffordanceRef = useRef(isLivePriceAffordance);
  isLivePriceAffordanceRef.current = isLivePriceAffordance;

  // Market-frozen / closed-market indicator (display/telemetry only). Driven by
  // the tick-stream `feed_status` event, whose verdict is derived from the
  // latest tick's BROKER-time staleness (calendar-independent), so a still-
  // forming bar reads as closed-market rather than a broken feed. null = not
  // frozen (or no tick seen yet → assert nothing).
  const [formingCloseMs, setFormingCloseMs] = useState<number | null>(null);
  // Server clock + bar interval from the latest accepted forming-bar frame, so
  // the candle-close countdown is measured against the SERVER clock (a client
  // clock running fast/slow can neither shrink, inflate nor hide it).
  const serverClockRef = useRef<(ServerClockSample & { intervalMs: number | null }) | null>(null);
  const [marketFrozen, setMarketFrozen] = useState<{ lastBrokerTimeMs: number | null } | null>(
    null,
  );
  // Scanner host bindings (both optional; no effect on any other surface).
  const liveTipKeyRef = useRef(liveTipKey);
  liveTipKeyRef.current = liveTipKey;
  const withdrawLiveTip = useCallback(() => {
    if (liveTipKeyRef.current) publishScannerTip(liveTipKeyRef.current, null);
  }, []);
  useEffect(() => {
    if (!liveTipKey) return;
    return () => publishScannerTip(liveTipKey, null);
  }, [liveTipKey]);
  useEffect(() => {
    if (!isLivePriceAffordance) withdrawLiveTip();
  }, [isLivePriceAffordance, liveTipKey, withdrawLiveTip]);
  useEffect(() => {
    onMarketFrozenChange?.(marketFrozen);
  }, [marketFrozen, onMarketFrozenChange]);
  useEffect(() => () => onMarketFrozenChange?.(null), [onMarketFrozenChange]);

  // ── Tick-stream watchdog (Theme C3.4) ───────────────────────────────────
  // A dropped SSE stream used to be invisible: `es.onerror` was a no-op, and a
  // connection that dies without an error event (proxy timeout, sleeping tab,
  // network change) produces NO error at all — it simply stops delivering, so
  // the chart sat frozen indefinitely while still presenting as live. The hook
  // owns silence detection and the reconnect signal; see its own file for the
  // detection rationale and timings.
  // Only a candle source that HAS a tick stream (MT5 broker / Deriv) is watched:
  // third-party sources, stored history and an empty feed never open one, so
  // they can never be "reconnecting".
  const chartContext = JSON.stringify([resolvedSymbol, timeframe, data?.feedStatus?.source ?? null, evidenceIdentity]);
  useEffect(() => {
    setScenarioGhostPaths([]);
  }, [chartContext]);
  const tickSource = chartTickSource(data?.feedStatus?.source);
  const streamEnabled = data?.feedStatus?.notLiveReason !== "stored_history" &&
    resolvedSymbol.length > 0 && tickSource !== null && typeof EventSource === "function";
  const streamWatchdog = useTickStreamWatchdog({enabled: streamEnabled, streamKey: chartContext});

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
        enabled: externalFeed == null && resolvedSymbol.length > 0 && supportedTimeframe && onIntelligenceChange != null,
        refetchInterval: 8000,
        staleTime: 4000,
      },
    },
  );
  const intelligenceResponse = intelligenceQuery.data?.state;
  const intelligenceState = externalFeed == null && supportedTimeframe && intelligenceResponse?.symbol === resolvedSymbol && intelligenceResponse.timeframe === timeframe
    ? intelligenceResponse : undefined;

  useEffect(() => {
    if (intelligenceState) onIntelligenceChange?.(intelligenceState);
  }, [intelligenceState, onIntelligenceChange]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // The chart RENDERER lives behind the swappable chart-engine adapter (Task
  // #373). This component owns React state, data, feed-status and UI; the
  // imperative engine is driven only through the adapter.
  const adapterRef = useRef<ChartEngineAdapter | null>(null);
  const releaseScannerSurface = useRef<(() => void) | null>(null);
  const overlays = useMemo(() => [...suppliedOverlays,...(researchOpen&&researchLayer?.context===chartContext?researchLayer.rows:[])].filter(overlay =>
    overlay.symbol === resolvedSymbol && (!overlay.timeframe || overlay.timeframe === timeframe)),
  [suppliedOverlays,researchLayer,researchOpen,chartContext,resolvedSymbol,timeframe]);
  const chartVisibleOverlays = useMemo(
    () => visibleOverlays(overlays, layers),
    [overlays, layers],
  );
  const acceptScenarioPaths = useCallback((paths: GhostPath[]) => {
    const colors: Record<Scenario, string> = {
      UP_FIRST: "#36d6b0",
      DOWN_FIRST: "#fa668d",
      NEITHER: "#a88cff",
    };
    setScenarioGhostPaths(paths
      .filter((path) => path.label === "ILLUSTRATIVE_TRAINING_PATH" && !path.unavailableReason)
      .map((path) => ({
        id: path.scenario,
        color: colors[path.scenario],
        candles: path.candles.map((bar) => ({
          time: Math.floor(bar.openTime / 1000),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        })),
      })));
  }, []);
  const visibleScenarioPaths = useMemo(
    () => scenarioGhostPaths.filter((path) => {
      const layer = SCENARIO_LAYERS[path.id as keyof typeof SCENARIO_LAYERS];
      return layer ? layers[layer] : false;
    }),
    [scenarioGhostPaths, layers],
  );
  const layerAvailability = useMemo(() => {
    const counts: Partial<Record<ChartLayerId, number>> = {
      drawings: adapterRef.current?.getDrawingCount?.() ?? 0,
    };
    for (const overlay of overlays) {
      const layer = overlayLayer(overlay);
      counts[layer] = (counts[layer] ?? 0) + 1;
    }
    const structural = intelligenceState?.trendlineOverlay;
    if (structural?.visible) {
      for (const line of structural.lines) {
        const layer = line.id.endsWith(":rail") ? "channels" : "trendlines";
        counts[layer] = (counts[layer] ?? 0) + 1;
      }
      for (const marker of structural.markers) {
        const layer = structureMarkerLayer(marker.kind);
        counts[layer] = (counts[layer] ?? 0) + 1;
      }
    }
    for (const path of scenarioGhostPaths) {
      const layer = SCENARIO_LAYERS[path.id as keyof typeof SCENARIO_LAYERS];
      if (layer) counts[layer] = (counts[layer] ?? 0) + path.candles.length;
    }
    return counts;
  }, [overlays, intelligenceState?.trendlineOverlay, scenarioGhostPaths]);
  const acceptResearchOverlays = useCallback((rows:ChartOverlay[])=>setResearchLayer(rows.length?{context:chartContext,rows}:null),[chartContext]);
  const acceptResearchExplanation = useCallback((evidence:ChartResearchExplanation|null)=>{if(evidence)researchExplanation.current={context:chartContext,evidence};else if(researchExplanation.current?.context===chartContext)researchExplanation.current=null;},[chartContext]);
  const researchVisibleBars = useCallback(()=>activeChartContext.current?.key===chartContext&&activeChartContext.current.adapter===adapterRef.current?adapterRef.current?.getVisibleCandles?.()??[]:[],[chartContext]);
  const getSupportResistanceProposal = useCallback(()=>{
    const now=Date.now(),bound=captureSmartChartBars(data,{symbol:resolvedSymbol,timeframe},deepHistory.analysisCandles,deepHistory.analysisEvidence,now);
    if(bound.status!=="ready")return {status:"unavailable" as const,proposal:null,reason:bound.reason??"Original source evidence unavailable."};
    return proposeChartSupportResistance({...bound.context,bars:bound.bars,asOfMs:now},researchVisibleBars());
  },[data,resolvedSymbol,timeframe,deepHistory.analysisCandles,deepHistory.analysisEvidence,researchVisibleBars]);
  const getFibonacciProposal = useCallback(()=>{
    const now=Date.now(),bound=captureSmartChartBars(data,{symbol:resolvedSymbol,timeframe},deepHistory.analysisCandles,deepHistory.analysisEvidence,now);
    if(bound.status!=="ready")return {status:"unavailable" as const,proposal:null,reason:bound.reason??"Original source evidence unavailable."};
    return proposeChartFibonacci({...bound.context,bars:bound.bars,asOfMs:now},researchVisibleBars());
  },[data,resolvedSymbol,timeframe,deepHistory.analysisCandles,deepHistory.analysisEvidence,researchVisibleBars]);
  const assistantPaneKey=useMemo(()=>chartAssistantPaneContext(data,resolvedSymbol,timeframe,engineGeneration),[data,resolvedSymbol,timeframe,engineGeneration]);
  const assistantPane=useAssistantChartPane({contextKey:assistantPaneKey,symbol:resolvedSymbol,timeframe,source:data?.feedStatus?.source??"Unknown source",analysisOnly:workspaceId!=="primary",ready:hasCandles&&!query.isError&&!!adapterRef.current});
  useLayoutEffect(()=>{
    if(!assistantPane.active)return;
    return registerChartResearchAssistant(text=>{
      if(!assistantPane.isCurrent()||!hasCandles||activeChartContext.current?.key!==chartContext||activeChartContext.current.adapter!==adapterRef.current)return "The selected chart source or renderer is no longer ready. Select the current chart again. No historical test was prepared or run.";
      setResearchOpen(true);
      const followup=answerChartResearchFollowup(text,researchExplanation.current?.context===chartContext?researchExplanation.current.evidence:null);
      if(followup!==null)return followup;
      setResearchRequest({id:++researchSequence.current,text,context:chartContext});
      return "Opened Test an idea on the current chart. Your request will be checked against the supported rules and available closed history. Review the editable rules and assumptions there before running; no calculation or order has been sent.";
    });
  },[assistantPane.active,assistantPane.isCurrent,hasCandles,chartContext]);
  // A context change already renders the new source. Rebind consumers in that
  // commit; only a newly created engine needs an additional ref-to-prop render.
  const chartEpoch = `${engineGeneration}:${chartContext}`;
  // The first candle response binds an initially empty workbench; it is not a
  // replacement of a previously displayed source. Keep its DOM, focus and
  // settings input instead of mounting the toolbar twice. Once any candles
  // have been bound, every source-context change retains the old reset rule.
  // A market change always remounts. Only committed renders update this record,
  // so an abandoned concurrent render cannot advance the ownership generation.
  const workbenchMarket = JSON.stringify([resolvedSymbol, timeframe]);
  const committedWorkbench = useRef({ market: workbenchMarket, context: chartContext, bound: hasCandles, generation: 0 });
  const priorWorkbench = committedWorkbench.current;
  const sameWorkbenchMarket = priorWorkbench.market === workbenchMarket;
  const workbenchGeneration = sameWorkbenchMarket
    ? priorWorkbench.generation + (priorWorkbench.bound && priorWorkbench.context !== chartContext ? 1 : 0)
    : 0;
  const workbenchBound = hasCandles || (sameWorkbenchMarket && priorWorkbench.bound);
  useLayoutEffect(() => {
    committedWorkbench.current = { market: workbenchMarket, context: chartContext, bound: workbenchBound, generation: workbenchGeneration };
  }, [workbenchMarket, chartContext, workbenchBound, workbenchGeneration]);
  // `adapter: null` binds a comparison view's context before its deferred
  // engine exists, so stream frames for that context (feed_status, liveness)
  // keep their effect; the primary always binds with its engine.
  const activeChartContext = useRef<{ key: string; adapter: ChartEngineAdapter | null } | null>(null);
  // The newest forming tip a deferred comparison received before its engine
  // was built; applied once the engine has its context and candles.
  const pendingTipRef = useRef<{ key: string; bar: ChartEngineCandle } | null>(null);
  // Newest bar time (Unix seconds) currently on screen. The poll keeps this in
  // sync with the authoritative closed window; the SSE tick handler reads it to
  // reject an out-of-order forming tip (one behind the newest bar).
  const newestBarSecRef = useRef<number | null>(null);

  // Phase 2 — responsive chart height. On narrow viewports the default 520px
  // height leaves too little room when panels stack below the canvas. We
  // honour `mobileHeight` when provided; otherwise use 320–380px on mobile so
  // the chart is always readable without crushing the rest of the page.
  const [effectiveHeight, setEffectiveHeight] = useState(()=>viewportChartHeight(height,mobileHeight,expanded,compactWorkspace));
  const [mobileLayout, setMobileLayout] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false);
  const [advancedToolsMounted, setAdvancedToolsMounted] = useState(false);
  // Which part the small details window shows, and where it was dragged to.
  const [detailsSection, setDetailsSection] = useState<"all" | "tools" | "forecast" | "read">("all");
  const [detailsOffset, setDetailsOffset] = useState({ x: 0, y: 0 });
  const detailsDrag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const compactDesktopWorkspace = compactWorkspace && !mobileLayout;
  useEffect(() => {
    const update = () => {
      const isMobile = window.innerWidth < 768;
      setMobileLayout(isMobile);
      setEffectiveHeight(viewportChartHeight(height,mobileHeight,expanded,compactWorkspace));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [height, mobileHeight, expanded, compactWorkspace]);

  // Retain the expensive canvas. Context-owned observations are cleared in the
  // layout phase below, before a new market label can paint over old geometry.
  //
  // The primary builds in this layout phase once its initial request settles. Comparison views
  // build theirs through the shared post-paint queue above; until then every
  // engine consumer no-ops on the null adapter, and `engineGeneration` re-runs
  // the context/link/stream effects so the late engine receives exactly the
  // sequence a synchronously built one does (including its engine-generation binding).
  const defersEngine = workspaceId !== "primary";
  // A pending initial response needs its loading/controls shell, not an empty
  // canvas engine. Settled empty/error responses retain their existing engine
  // behavior; an engine already created survives subsequent loading cycles.
  const canStartPrimaryEngine = !query.isLoading || hasCandles;
  const engineInputsRef = useRef({ effectiveHeight, resolvedSymbol, timeframe, updateLegend, displayZone, utcClockQualified, canStartPrimaryEngine });
  useLayoutEffect(() => { engineInputsRef.current = { effectiveHeight, resolvedSymbol, timeframe, updateLegend, displayZone, utcClockQualified, canStartPrimaryEngine }; });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let adapter: ChartEngineAdapter | null = null;
    // The engine whose setup is still running (destroyed if that setup throws).
    let building: ChartEngineAdapter | null = null;
    const build = () => {
      const inputs = engineInputsRef.current;
      if (adapter || building || (!defersEngine && !inputs.canStartPrimaryEngine)) return;
      const engine = createChartEngineAdapter();
      building = engine;
      engine.init({ container: el, height: inputs.effectiveHeight });
      engine.setSymbol?.(inputs.resolvedSymbol);
      engine.setTimeframe?.(inputs.timeframe);
      engine.setCrosshairHandler?.(inputs.updateLegend);
      engine.setViewLinkStatusHandler?.(message => {if (linkStatusRef.current) linkStatusRef.current.textContent = message;});
      // A deferred comparison never paints UTC ticks before its zone arrives.
      engine.setDisplayTimeZone?.(inputs.displayZone);
      engine.setUtcClockQualified?.(inputs.utcClockQualified);
      inputs.updateLegend(null);
      building = null;
      adapter = engine;
      adapterRef.current = engine;
      setEngineGeneration(++builtEngineGeneration.current);
    };
    let cancelDeferred: (() => void) | undefined;
    if (!defersEngine) { requestPrimaryEngine.current = build; build(); }
    else cancelDeferred = scheduleDeferredEngineInit(() => {
      try {
        build();
      } catch (error) {
        // A deferred build runs outside React, where a setup failure would
        // escape every error boundary. Release the partly built engine and
        // rethrow the error from the next render, so the boundary sees it as it
        // sees a failed synchronous (primary) build. The queue moves on.
        const partial = building;
        building = null;
        try { partial?.destroy(); } catch { /* the setup error is the one surfaced */ }
        setEngineGeneration(() => { throw error; });
        return;
      }
    });

    return () => {
      cancelDeferred?.();
      if (requestPrimaryEngine.current === build) requestPrimaryEngine.current = null;
      // External overlays must release their series before the engine removes
      // its canvas. React runs this layout cleanup before the later surface
      // effect cleanup; a late removePriceLine otherwise schedules a dead paint.
      releaseScannerSurface.current?.();
      adapter?.destroy();
      adapterRef.current = null;
      activeChartContext.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewLinks, workspaceId]);
  useLayoutEffect(() => {
    if (canStartPrimaryEngine) requestPrimaryEngine.current?.();
  }, [canStartPrimaryEngine, viewLinks, workspaceId]);

  useLayoutEffect(() => {
    const adapter = adapterRef.current;
    const previous = activeChartContext.current;
    if (!adapter) {
      // A waiting chart: bind its context now, with no engine, and clear
      // the previous context's observations exactly as a context change does.
      if (previous?.key === chartContext && previous.adapter === null) return;
      activeChartContext.current = { key: chartContext, adapter: null };
      pendingTipRef.current = null;
      newestBarSecRef.current = null;
      inspectedCandleRef.current = null;
      updateLegend(null);
      setMarketFrozen(null);
      setFormingCloseMs(null);
      setBubbles([]);
      return;
    }
    if (previous?.key === chartContext && previous.adapter === adapter) return;
    // The deferred engine arriving for the context it was bound to is not a
    // context change: the stream state collected for that context is kept.
    const engineArrived = previous?.key === chartContext && previous.adapter === null;
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
    if (!engineArrived) newestBarSecRef.current = null;
    inspectedCandleRef.current = null;
    updateLegend(null);
    if (!engineArrived) {
      setMarketFrozen(null);
      setFormingCloseMs(null);
      setBubbles([]);
    }
    // chartEpoch includes the source identity, so this commit rebinds consumers.
  }, [chartContext, resolvedSymbol, timeframe, viewLinks, workspaceId, updateLegend, engineGeneration, defersEngine]);
  // Register once after the new engine generation reaches props. This also
  // covers a primary that starts after its pending response, without replaying
  // a linked peer range both in the creation commit and its ref-to-prop render.
  useLayoutEffect(() => {
    if (engineGeneration !== builtEngineGeneration.current) return;
    const adapter = adapterRef.current;
    return adapter ? viewLinks?.register(workspaceId, adapter) : undefined;
  }, [viewLinks, workspaceId, chartContext, engineGeneration]);
  useLayoutEffect(() => { adapterRef.current?.setCrosshairHandler?.(updateLegend); }, [updateLegend, chartEpoch]);
  // One effect owns the zone: the ref is assigned first, then the engine and
  // the open legend are relabelled in the same commit (no separate ref effect).
  useLayoutEffect(() => {
    timeZoneRef.current = displayZone;
    utcClockRef.current = utcClockQualified;
    adapterRef.current?.setDisplayTimeZone?.(displayZone);
    adapterRef.current?.setUtcClockQualified?.(utcClockQualified);
    updateLegend(inspectedCandleRef.current);
  }, [displayZone, utcClockQualified, chartEpoch, updateLegend]);

  useEffect(() => { adapterRef.current?.resize(undefined, effectiveHeight); }, [effectiveHeight, chartEpoch]);
  useEffect(() => {
    if (!compactDesktopWorkspace || expanded) return;
    const container = containerRef.current;
    if (!container) return;
    const plot = container.parentElement;
    const main = container.closest<HTMLElement>("#main-content");
    const accountStrip = container.closest(".arx-workspace-body")?.querySelector<HTMLElement>(".arx-account-strip");
    let active = true;
    let lastApplied: number | undefined;
    const syncHeight = () => {
      const view = container.ownerDocument.defaultView;
      if (!active || !container.isConnected || !view || view.innerWidth < 1024) return;
      const deskHeight = (main?.clientHeight || view.innerHeight) - (accountStrip?.getBoundingClientRect().height || 0) - 8;
      const ceiling = Math.max(1, Math.floor(Math.min(view.innerHeight * .65, deskHeight)));
      const target = Math.min(Math.max(390, Math.floor(view.innerHeight * .60)), ceiling);
      // Fixed viewport-derived sizing breaks the flex/engine intrinsic-height
      // feedback loop. Never use an unbounded observed height as engine input.
      plot?.style.setProperty("--arx-compact-plot-height", `${target}px`);
      plot?.style.setProperty("--arx-compact-plot-max", `${ceiling}px`);
      const next = Math.min(container.clientHeight, target);
      if (next > 0 && next !== lastApplied) {
        adapterRef.current?.resize(undefined, next);
        lastApplied = next;
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncHeight);
    for (const target of [container, main, accountStrip]) if (target) observer?.observe(target);
    window.addEventListener("resize", syncHeight);
    syncHeight();
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", syncHeight);
      plot?.style.removeProperty("--arx-compact-plot-height");
      plot?.style.removeProperty("--arx-compact-plot-max");
    };
  }, [compactDesktopWorkspace, expanded, chartEpoch]);
  useEffect(() => { adapterRef.current?.setScaleMode?.(scaleMode); }, [scaleMode, chartEpoch]);
  useEffect(() => { adapterRef.current?.setPriceOnlyScale?.(preferences.priceOnlyScale === true); }, [preferences.priceOnlyScale, chartEpoch]);
  useEffect(() => { adapterRef.current?.setPriceScaleInverted?.(preferences.inverted === true); }, [preferences.inverted, chartEpoch]);

  useLayoutEffect(() => { adapterRef.current?.setChartStyle?.(preferences.style); }, [preferences.style, chartEpoch]);

  // Only explicit selected-pane ownership binds the existing local registry.
  // Retained callbacks recheck ownership and the actual renderer context.
  useLayoutEffect(() => {
    if (!assistantPane.active) return;
    let currentStudies = preferences.studies;
    return registerChartStudyAssistant(request => executeStudyRequest(request, {
      adapter: assistantPane.isCurrent() && hasCandles && activeChartContext.current?.key === chartContext && activeChartContext.current.adapter === adapterRef.current ? adapterRef.current : null,
      studies: currentStudies, symbol: resolvedSymbol, timeframe, utcClockQualified,
      feedLabel: `${data?.feedStatus?.source ?? "Unknown source"} · ${isLivePriceAffordance ? "Live at capture" : "Not live-confirmed"}`,
      save: studies => {
        currentStudies = studies;
        setPreferences(previous => ({ ...previous, studies }));
        updateLegend(inspectedCandleRef.current);
      },
    }));
  }, [assistantPane.active,assistantPane.isCurrent, preferences.studies, hasCandles, chartEpoch, chartContext, resolvedSymbol, timeframe, data?.feedStatus?.source, isLivePriceAffordance, updateLegend, utcClockQualified]);

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
          volumeEvidence: chartVolumeEvidence(c.volumeEvidence,c.source),
          profileEvidence: profileCandleEvidence(c),
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

  // Only producer-verified older pages join the analysis/chart series. Legacy
  // pages remain on a separate muted Canvas series, so the visible archive is
  // never reported as current-feed render or research evidence.
  const mergedEngineCandles = useMemo<ChartEngineCandle[]>(() => {
    if (deepHistory.analysisCandles.length === 0) return engineCandles;
    const byTime = new Map<number, ChartEngineCandle>();
    for (const c of deepHistory.analysisCandles) {
      const time = Math.floor(c.time / 1000);
      if (
        Number.isFinite(time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      ) {
        byTime.set(time, { time, open: c.open, high: c.high, low: c.low, close: c.close, volumeEvidence: c.volumeEvidence });
      }
    }
    for (const c of engineCandles) byTime.set(c.time, c); // live window wins
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }, [deepHistory.analysisCandles, engineCandles]);

  const archiveEngineCandles = useMemo<ChartEngineCandle[]>(() => {
    const mainTimes = new Set(mergedEngineCandles.map(c => c.time));
    const byTime = new Map<number, ChartEngineCandle>();
    for (const candle of deepHistory.archiveCandles) {
      const time = Math.floor(candle.time / 1000);
      if (!Number.isFinite(time) || mainTimes.has(time)
        || ![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
      byTime.set(time, { time, open: candle.open, high: candle.high, low: candle.low, close: candle.close,
        volumeEvidence: deepHistory.nativeHistory ? candle.volumeEvidence : undefined });
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }, [deepHistory.archiveCandles, deepHistory.nativeHistory, mergedEngineCandles]);

  const displayEngineCandles = useMemo(() => {
    const byTime = new Map<number, ChartEngineCandle>();
    for (const candle of mergedEngineCandles) byTime.set(candle.time, candle);
    for (const candle of archiveEngineCandles) if (!byTime.has(candle.time)) byTime.set(candle.time, candle);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }, [archiveEngineCandles, mergedEngineCandles]);

  const hasQualifiedTickVolume = useMemo(() => displayEngineCandles.some(candle => observedTickVolume(candle.volumeEvidence) != null), [displayEngineCandles]);
  const hasQualifiedTradeVolume = useMemo(() => mergedEngineCandles.some(candle => observedTradeVolume(candle.volumeEvidence) != null), [mergedEngineCandles]);
  const displayStudies = useMemo(() => chartDisplayStudies(preferences.studies, preferences.volumePane !== false, hasQualifiedTickVolume, hasQualifiedTradeVolume), [preferences.studies, preferences.volumePane, hasQualifiedTickVolume, hasQualifiedTradeVolume]);
  const tradeVolumeSelected = displayStudies.some(study => ["trade_volume","vwap"].includes(study.kind) && study.lineStyles?.[0]?.visible !== false);
  const tickVolumeSelected = displayStudies.some(study => study.kind === "tick_volume" && study.lineStyles?.[0]?.visible !== false);
  useEffect(() => {
    adapterRef.current?.setStudies?.(displayStudies);
    updateLegend(inspectedCandleRef.current);
  }, [displayStudies, chartEpoch, updateLegend]);

  // Oldest bar currently on screen as an ISO string — the cursor seed the
  // reach-start handler pages behind. Held in a ref so the (stable) handler
  // registered on the engine always reads the latest value without re-binding.
  const oldestIsoRef = useRef<string | null>(null);
  useEffect(() => {
    const oldest = displayEngineCandles[0];
    oldestIsoRef.current = oldest
      ? new Date(oldest.time * 1000).toISOString()
      : null;
  }, [displayEngineCandles]);

  // ONE display precision for this instrument (lib/instrumentPriceFormat): the
  // server-declared precision widened by the digits the loaded quotes carry —
  // the same rule the Scanner chart, header and trade modal use. The axis
  // (adapter.setDisplayPricePrecision), the header badge, the crosshair legend
  // and the side panels (chartPricePrecisionStore) all print with it.
  const serverPricePrecision = data?.truthResult?.pricePrecision ?? null;
  const pricePrecision = useMemo(
    () => resolveDisplayPricePrecision(
      serverPricePrecision,
      mergedEngineCandles.flatMap((c) => [c.open, c.high, c.low, c.close]),
    ),
    [serverPricePrecision, mergedEngineCandles],
  );
  pricePrecisionRef.current = pricePrecision;
  const precisionOwner = useRef({}).current;
  useEffect(
    () => publishChartPricePrecision(resolvedSymbol, pricePrecision, precisionOwner),
    [resolvedSymbol, pricePrecision, precisionOwner],
  );

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
    adapter.setDisplayPricePrecision?.(pricePrecision);
    adapter.setCandles(mergedEngineCandles);
    adapter.setArchiveCandles?.(archiveEngineCandles, { sourceVerified: deepHistory.nativeHistory != null });
    // setCandles just replaced any tick-stream tip on the axis with the poll's
    // newest close, so a published Scanner tip no longer matches the axis.
    withdrawLiveTip();
    // Keep the newest-bar watermark in sync with the authoritative closed
    // window. When the poll reconciles a new closed bar it advances here, so the
    // SSE tip for the next interval is accepted and a stale tip is rejected; the
    // closed bar cleanly supersedes any prior synthesized tip with no orphan dup.
    const newest = mergedEngineCandles[mergedEngineCandles.length - 1];
    if (newest) newestBarSecRef.current = newest.time;
  }, [mergedEngineCandles, archiveEngineCandles, deepHistory.nativeHistory, isLivePriceAffordance, chartEpoch, historySource, chartContext, pricePrecision]);
  // Measure what the engine drew against these source bars after it paints, and
  // keep that evidence fresh while the chart is open (renderEvidenceReporter.ts).
  // Nothing is scheduled until an engine holds bars (the deferred init owns the
  // first frame), and one timeout chain at a time re-measures while it is open.
  // Runtime self-check: every redraw (new bars, a context reset, a style or
  // precision change) re-measures and re-posts, and the refresh keeps it fresh
  // (drawing edits are picked up on that refresh). The chip shows the server's
  // verdict on the latest post.
  useEffect(() => {
    if (!adapterRef.current || mergedEngineCandles.length === 0) return;
    const target = { symbol: resolvedSymbol, timeframe, source: historySource };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let live = true;
    const onVerdict = (v: RenderVerdict) => { if (live) setRenderVerdict(v); };
    const measure = () => {
      reportRenderEvidence(adapterRef.current, target, Date.now(), onVerdict);
      timer = setTimeout(measure, RENDER_EVIDENCE_REFRESH_MS);
    };
    // Let the engine lay out the new series before reading coordinates back.
    timer = setTimeout(measure, RENDER_EVIDENCE_FIRST_MEASURE_MS);
    return () => { live = false; if (timer != null) clearTimeout(timer); };
  }, [mergedEngineCandles, historySource, resolvedSymbol, timeframe, chartEpoch, pricePrecision, preferences.style]);
  // A verdict belongs to one chart; drop it when the chart changes.
  useEffect(() => { setRenderVerdict(null); }, [resolvedSymbol, timeframe, historySource]);
  useLayoutEffect(() => {
    if (!onScannerSurfaceChange) return;
    const surface = hasCandles ? adapterRef.current?.getScannerOverlaySurface?.() : null;
    onScannerSurfaceChange(surface ? { ...surface, symbol: resolvedSymbol, timeframe, context: chartContext, style: preferences.style } : null);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (releaseScannerSurface.current === release) releaseScannerSurface.current = null;
      onScannerSurfaceChange(null);
    };
    releaseScannerSurface.current = release;
    return release;
  }, [onScannerSurfaceChange, hasCandles, resolvedSymbol, timeframe, chartContext, preferences.style, chartEpoch]);

  // A forming tip that reached a deferred comparison before its engine existed
  // is applied once that engine holds the context's candles, with the same
  // out-of-order guard as a live frame. Never set for the primary.
  useLayoutEffect(() => {
    const pending = pendingTipRef.current;
    const adapter = adapterRef.current;
    const bound = activeChartContext.current;
    if (!pending || !adapter || !bound?.adapter) return;
    pendingTipRef.current = null;
    if (pending.key !== chartContext || bound.key !== chartContext || bound.adapter !== adapter || !adapter.updateActiveCandle) return;
    if (newestBarSecRef.current != null && pending.bar.time < newestBarSecRef.current) return;
    adapter.updateActiveCandle(pending.bar);
    newestBarSecRef.current = pending.bar.time;
  }, [chartEpoch, chartContext]);

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
    setFormingCloseMs(null);
    serverClockRef.current = null;
    // A published tip never outlives its stream key.
    withdrawLiveTip();
    if (!streamEnabled || !tickSource) return;
    const url = u(
      `/api/chart/tick-stream?symbol=${encodeURIComponent(resolvedSymbol)}&timeframe=${encodeURIComponent(timeframe)}&source=${encodeURIComponent(tickSource)}`,
    );
    let es: EventSource | null = null;
    let disposed = false;
    // A comparison view's engine is built after its first paint, so its stream
    // may open first; it adopts the first engine built for this context. The
    // primary may also wait for initial candles; ownership uses the same binding.
    let ownedAdapter = adapterRef.current;
    const owner = () => (ownedAdapter ??= adapterRef.current);
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      // An eligible constructor can fail transiently. Preserve bounded recovery
      // instead of permanently disabling this source; polling remains available.
      streamWatchdog.noteError();
      return;
    }
    streamWatchdog.noteStreamOpened();
    // A context bound without an engine (a deferred comparison) belongs to
    // this stream; its frames count, and its forming tip waits for the engine.
    const accepts = () => {
      const bound = activeChartContext.current;
      return !disposed && bound?.key === chartContext && (bound.adapter === null || bound.adapter === owner());
    };
    es.onmessage = (ev) => {
      if (!accepts()) return;
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
        /** Server wall clock when the frame was sent (epoch ms). */
        ts?: number;
        marketFrozen?: boolean;
        lastBrokerTimeMs?: number | null;
        bar?: { openTimeMs?: number; closeTimeMs?: number; open?: number; high?: number; low?: number; close?: number };
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
        if (msg.marketFrozen === true) {
          setFormingCloseMs(null);
          serverClockRef.current = null;
          withdrawLiveTip();
        }
        setMarketFrozen(
          msg.marketFrozen === true ? { lastBrokerTimeMs: msg.lastBrokerTimeMs ?? null } : null,
        );
        return;
      }
      const engineBound = activeChartContext.current?.adapter != null;
      const adapter = adapterRef.current;
      if (engineBound && !adapter?.updateActiveCandle) return;
      // Gate on THIS frame's own freshness marker (server-computed from the real
      // tick age), exactly like the Scanner — not on the sticky closed-feed grade.
      if (msg.type !== "forming_bar") return;
      if (msg.frozen || !msg.bar) {
        setFormingCloseMs(null);
        serverClockRef.current = null;
        withdrawLiveTip();
        return;
      }
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
      if (!engineBound) {
        // No engine yet: keep the newest tip for it, in time order.
        const pending = pendingTipRef.current;
        if (pending?.key === chartContext && tipSec < pending.bar.time) return;
        pendingTipRef.current = { key: chartContext, bar: { time: tipSec, open: b.open, high: b.high, low: b.low, close: b.close } };
        return;
      }
      if (!adapter?.updateActiveCandle) return;
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
      // Publish the axis' current tip for the Scanner header (rounded to the
      // display precision so an unchanged label never re-renders a reader).
      if (liveTipKeyRef.current) {
        publishScannerTip(
          liveTipKeyRef.current,
          isLivePriceAffordanceRef.current ? Number(formatInstrumentPrice(b.close, pricePrecisionRef.current)) : null,
        );
      }
      const expectedClose = chartBarCloseSeconds(b.openTimeMs / 1000, timeframe);
      const seconds = expectedClose == null ? null : expectedClose - b.openTimeMs / 1000;
      const closeMs = b.closeTimeMs;
      const validClose = seconds && typeof closeMs === "number" && Number.isFinite(closeMs)
        && closeMs - b.openTimeMs === seconds * 1000 ? closeMs : null;
      // Re-captured per frame so the server-clock offset stays fresh; a frame
      // without a finite ts (older server) leaves no sample and the countdown
      // falls back to the client clock.
      serverClockRef.current = validClose != null && typeof msg.ts === "number" && Number.isFinite(msg.ts)
        ? { serverTs: msg.ts, receivedPerf: performance.now(), intervalMs: seconds ? seconds * 1000 : null }
        : null;
      setFormingCloseMs(validClose);
    };
    es.onerror = () => {
      if (!accepts()) return;
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
  }, [resolvedSymbol, timeframe, streamWatchdog.epoch, tickSource, chartContext, streamEnabled]);

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
    adapter.setDrawingsVisible?.(layers.drawings);
  }, [layers.drawings, chartEpoch]);

  useEffect(() => {
    adapterRef.current?.setGhostPaths?.(visibleScenarioPaths);
  }, [visibleScenarioPaths, chartEpoch]);

  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter) return;
    // Markers anchor to the most recent bar so they stay visible for open positions.
    const lastCandle = candles[candles.length - 1];
    const lastTime =
      lastCandle && Number.isFinite(new Date(lastCandle.openTime).getTime())
        ? Math.floor(new Date(lastCandle.openTime).getTime() / 1000)
        : null;
    adapter.setOverlays(chartVisibleOverlays, lastTime);
  }, [chartVisibleOverlays, candles, chartEpoch]);

  // ── Level 4 — track P/L bubble coordinates. Overlays whose metadata carries a
  //    finite `pnl` get a floating bubble anchored to their price; we recompute
  //    the Y coordinate on a light loop so it follows zoom / scroll / resize.
  useEffect(() => {
    const pnlOverlays = chartVisibleOverlays.filter(
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
  }, [chartVisibleOverlays, chartEpoch]);

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
  // symbol/timeframe is downgraded or still unresolved — mirroring EleanorChartRead.
  // Normalize first: `timeframe` is contract-style ("M15") but useScannerTruth's
  // toApiTimeframe only understands chart ids, so a raw label would resolve the
  // wrong (M5) feed.
  //
  // The truth hook runs its own request to the same /api/chart/candles endpoint
  // (a different cache key from the generated hook above), so it is NOT the same
  // response object as the chip text. It is asked for the SAME candle window and
  // poll cadence as this chart so the chip and its cap describe the same bars at
  // nearly the same moment. The cap can only downgrade the chip.
  const { truth: badgeTruth } = useScannerTruth(
    supportedTimeframe ? resolvedSymbol : "",
    normalizeChartTimeframe(timeframe),
    { limit, refetchInterval: CANDLE_POLL_MS },
  );
  // A failed refresh of THIS chart's candles caps the chip too: the response it
  // describes is no longer current.
  const badgeAiUsableResolved = refreshFailed
    ? false
    : resolveFeedBadgeVerdict(badgeTruth?.analysis.level ?? null);
  // ONE AI-usability verdict for everything this panel shows or reports: the
  // chip, the "Not AI-confirmed" badge, the structure lines and the context the
  // page uses to draw scanner/Eleanor AI overlays. The raw feed flag can only be
  // narrowed by the shared truth (downgraded or still resolving => not usable),
  // so the canvas can never draw AI-derived levels next to a "No AI" chip.
  const aiUsable = conf.aiUsable && badgeAiUsableResolved === true;

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
  //    verdict (`aiUsable`: raw feed flag capped by the shared truth) and the shared live-price affordance, so a
  //    non-live / unconfirmed feed can never show structure. When any gate is
  //    false we CLEAR the structural channel (also covers symbol/timeframe switch
  //    via chartEpoch, so structure from instrument A never bleeds onto B).
  useEffect(() => {
    const adapter = adapterRef.current;
    if (!adapter?.setStructureLines) return;

    const overlay = intelligenceState?.trendlineOverlay;
    const mayDraw =
      overlay != null && overlay.visible && aiUsable && isLivePriceAffordance
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

    const lines: ChartStructureLine[] = overlay.lines
      .filter((line) => layers[line.id.endsWith(":rail") ? "channels" : "trendlines"])
      .map((ln) => ({
      id: ln.id,
      start: { time: ln.start.time, price: ln.start.price },
      end: { time: ln.end.time, price: ln.end.price },
      color: lineColor(ln.bias),
      // Channel rails (id suffixed ":rail") draw dashed so they read as the
      // parallel boundary, not a second primary trendline.
      dashed: ln.id.endsWith(":rail"),
      width: ln.dominant ? 2 : 1,
    }));

    const markers: ChartStructureMarker[] = overlay.markers
      .filter((marker) => layers[structureMarkerLayer(marker.kind)])
      .map((m) => ({
      time: m.time,
      // Anchor side by bias (support breaks below, resistance above); the dot
      // sits on the bar — never at an arbitrary price (engine rule).
      position: m.bias === "bullish" ? "belowBar" : "aboveBar",
      color: markerColor(m.kind),
      label: m.label,
    }));

    adapter.setStructureLines(lines, markers);
    // displayStatus is captured via `isLivePriceAffordance` (derived from it) +
    // `aiUsable`; chartEpoch re-runs this after a context reset so structure
    // is applied only to the matching instrument, timeframe and provider.
  }, [intelligenceState, aiUsable, isLivePriceAffordance, chartEpoch, historySource, overlayRequiresEvidence, evidence, intelligenceQuery.data, layers]);

  // Feed strip — the header chip's capped verdict, plus the specific reason for
  // a stale / invalid / unavailable grade. A background refetch is shown as its
  // own marker and never replaces the verdict.
  const stripConf = capConfidence(conf, badgeAiUsableResolved);
  const stripLabel = refreshFailed
    ? "Refresh failed"
    : feedStatus
    ? stripConf.statusLabel
    : query.isLoading
      ? "Loading"
      : query.isError
        ? "Request failed"
        : "Unknown";
  const stripTone: FeedStripTone = refreshFailed ? "caution" : feedStatus ? stripConf.severity : "unknown";
  const stripStyle = FEED_STRIP_STYLE[stripTone];
  const stripIntegrityFailed = feedStatus?.quality === "invalid";
  const stripStale = !stripIntegrityFailed && (feedStatus?.quality === "stale" || feedStatus?.stale === true);
  // The stale chip names only the cause the evidence supports. Inside the
  // instrument's scheduled weekend close with no bar since the close it is a
  // closed market (the server's own feed warning says so), not a feed fault; a
  // market with session closes may be closed (daily break, holiday) or its feed
  // delayed; only a 24/7 market's stale grade is plainly a stale feed.
  const stripNowMs = Date.now();
  const stripAssetClass = feedStatus?.assetClass ?? null;
  const stripClosure = stripStale ? scheduledWeekendClosureFor(stripAssetClass, stripNowMs) : null;
  const stripNewestOpenMs = hasCandles ? Date.parse(candles[candles.length - 1]!.openTime) : Number.NaN;
  // Cause wording (closed / may be closed) is only for a "stale" grade, as the
  // server's own wording is: a stale flag on a partial feed (missing or
  // duplicate bars plus a trailing gap) has a measured sequence fault, and the
  // server never calls it closed or fault-free — it says only that the newest
  // bars are not current.
  const stripStaleGraded = feedStatus?.quality === "stale";
  const stripStaleText = !stripStale
    ? null
    : !stripStaleGraded
      ? "Newest bars are not current"
    : stripClosure != null && Number.isFinite(stripNewestOpenMs) && stripNewestOpenMs < stripClosure.closedAtMs
      ? "Market closed for the weekend — no new bars, not a feed fault"
      : nextWeekendClosureBoundaryMs(stripAssetClass, stripNowMs) != null
        ? "No new bars — the market may be closed or the feed delayed"
        : "Feed is stale";
  const stripUnavailable = feedStatus?.quality === "unavailable" || feedStatus?.quality === "empty";
  // No feed answered, so the server served the newest bars it had stored
  // (closed market, disconnected bridge). Name that and the last bar's age so
  // the bars are never read as live.
  const storedHistoryText = hasCandles && feedStatus?.notLiveReason === "stored_history"
    ? storedHistoryChipText(candles[candles.length - 1]!.openTime, stripNowMs)
    : null;
  const stripRefreshing = query.isFetching && !query.isLoading;

  // Phase 2 — Chart Safe Mode: active when candles exist but the integrity
  // check failed (quality="invalid"). We still show the candles (they are
  // real, just flagged) but show a clear warning so no AI/analysis relies
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
    const key = `${resolvedSymbol}|${timeframe}|${aiUsable ? 1 : 0}`;
    if (lastCtxRef.current === key) return;
    lastCtxRef.current = key;
    onChartContextChange({
      symbol: resolvedSymbol,
      timeframe,
      aiUsable,
    });
  }, [resolvedSymbol, timeframe, aiUsable, onChartContextChange]);

  // Only surface the prominent banner once real candles are on screen — the
  // empty/error overlays already own the no-data story.
  // The banner renders the SAME capped verdict as the header chip and the feed
  // strip (stripConf), so the canvas can never stay silent while the chip,
  // the scanner badge and the AI read for this market say "Unconfirmed".
  const showPoorBanner =
    showFeedStatus && hasCandles && !isSafeMode && (refreshFailed || stripConf.severity !== "clean");
  // The banner states the SAME verdict as the strip and chip: the capped one,
  // or a failed refresh. It never shows the raw (uncapped) feed label.
  const bannerConf = refreshFailed
    ? { severity: "caution" as const, statusLabel: "Refresh failed",
        message: "The latest candle refresh failed; the bars shown are the last successful response and are not updating." }
    : stripConf;
  const showNotAiConfirmed = showFeedStatus && hasCandles && !aiUsable && !isSafeMode;


  // The stream's marketFrozen flag means "the broker keeps repeating one
  // quote"; only the instrument's scheduled weekend close (the same window the
  // server's feed status uses) makes that a closed market.
  const scheduledClosure = marketFrozen != null
    && scheduledWeekendClosureFor(data?.feedStatus?.assetClass ?? null, Date.now()) != null;
  const frozenChip = marketFrozen ? frozenQuoteChip(marketFrozen.lastBrokerTimeMs, scheduledClosure) : null;
  // The header price reads as current only on a live-confirmed feed whose
  // broker quote is still moving (downgrade-only).
  const headerPriceLive = isLivePriceAffordance && marketFrozen == null;

  const isInitialLoading = query.isLoading && !hasCandles;
  const isError = query.isError && !hasCandles;
  // The contract returns 200 with an honest empty list when no feed is available.
  const isEmpty = !isInitialLoading && !isError && !hasCandles;

  // On a phone, show the price plot before secondary controls. The DOM order
  // follows the visual order, including keyboard focus; source/quality notices
  // remain above the plot. Keyed controls and the plot survive breakpoint moves.
  const fullscreenToggle = (
    <Button size="sm" variant="outline" className={mobileLayout ? "ml-auto h-7 px-2 text-xs" : "h-8 text-xs"} aria-pressed={expanded} aria-label={expanded ? "Exit fullscreen" : "Fullscreen"} onClick={() => setExpanded((v) => !v)}>
          {expanded ? <Minimize2 className="mr-1 h-3.5 w-3.5" /> : <Maximize2 className="mr-1 h-3.5 w-3.5" />}
          <span className={mobileLayout ? "sr-only" : undefined}>{expanded ? "Exit fullscreen" : "Fullscreen"}</span>
        </Button>);
  const timeframeControls = (<div className={`flex items-center gap-1 ${compactDesktopWorkspace ? "w-full flex-nowrap overflow-x-auto py-0.5" : "flex-wrap"}`} data-testid="arx-native-tf-controls">
            {hasCandles && (
              <span className={`mr-1 text-[10px] text-zinc-500 ${compactDesktopWorkspace ? "shrink-0 whitespace-nowrap" : ""}`} data-testid="arx-native-timezone" title={timeAxisTitle}>
                {timeAxisLabel}
              </span>
            )}
            {replay && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" title="Replay the current source-identified response window; separately paginated older history is not included" disabled={!hasCandles || query.isFetching || query.isError} onClick={()=>{setReplayError(null);void replay.open(data,preferences,{symbol:resolvedSymbol,timeframe}).then(setReplayError);}}>Replay loaded bars</Button>}
            {TIMEFRAMES.map((tf) => (
              <Button
                key={tf.id}
                size="sm"
                variant={timeframe === tf.id ? "default" : "outline"}
                className={`h-7 px-2 text-xs ${compactDesktopWorkspace ? "shrink-0 whitespace-nowrap" : ""}`}
                onClick={() => setTimeframe(tf.id)}
                aria-pressed={timeframe === tf.id}
                aria-label={`${tf.label} timeframe`}
                data-testid={`arx-native-tf-${tf.id}`}
              >
                {tf.label}
              </Button>
            ))}
            <select className={`h-7 max-w-[10rem] rounded border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-100 ${compactDesktopWorkspace ? "shrink-0" : ""}`} aria-label="More chart intervals" title="All native broker intervals, including calendar weeks and months"
              value={(MORE_TIMEFRAMES as readonly string[]).includes(timeframe) ? timeframe : ""}
              onChange={event => {if (isChartInterval(event.target.value)) setTimeframe(event.target.value);}}>
              <option value="" disabled>More intervals</option>
              {MORE_TIMEFRAMES.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
            {(hasCandles || compactDesktopWorkspace) && (
              <Button
                size="sm"
                variant="ghost"
                className={`h-7 text-zinc-500 hover:text-zinc-300 ${compactDesktopWorkspace ? "w-7 shrink-0 p-0" : "px-2 text-[11px]"}`}
                disabled={!hasCandles}
                onClick={resetScale}
                aria-label="Reset chart scale"
                title="Reset scale — restore default visible range"
                data-testid="arx-native-reset-scale"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
            {compactDesktopWorkspace && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                aria-label="Open the projected path forecast"
                title="Forecast next hour — projected scenario paths drawn ahead of the latest candle"
                aria-controls="arx-structural-forecast"
                data-testid="arx-native-forecast-open"
                onClick={() => {
                  // The forecast panel lived only inside the collapsed Advanced
                  // section, so the dashboard chart showed no way to reach it.
                  setAdvancedToolsMounted(true);
                  setDetailsSection("forecast");
                  setAdvancedToolsOpen(true);
                  const reveal = () => document.getElementById("arx-structural-forecast")?.scrollIntoView?.({ block: "nearest" });
                  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(reveal);
                  else reveal();
                }}
              >
                Forecast
              </Button>
            )}
            {compactDesktopWorkspace && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                aria-label="Advanced chart details"
                aria-expanded={advancedToolsOpen}
                aria-controls="arx-advanced-chart-content"
                data-testid="arx-native-advanced-toggle"
                onClick={() => {
                  const next = !advancedToolsOpen;
                  setDetailsSection("all");
                  setAdvancedToolsOpen(next);
                  if (next) setAdvancedToolsMounted(true);
                }}
              >
                Advanced
              </Button>
            )}
          </div>);
  const layersMenu = (
    <ChartLayersMenu
      value={layers}
      onChange={setLayers}
      availability={layerAvailability}
    />
  );
  const compactTimer = !hasCandles
    ? <Badge variant="outline" className="gap-1 text-[10px] text-zinc-400" data-testid="arx-native-candle-timer">Timer waiting for candles</Badge>
    : marketFrozen
      ? <Badge variant="outline" className="gap-1 text-[10px] text-amber-300" data-testid="arx-native-candle-timer"><Clock className="h-2.5 w-2.5" />Timer paused — feed frozen</Badge>
      : !isLivePriceAffordance
        ? <Badge variant="outline" className="gap-1 text-[10px] text-zinc-400" data-testid="arx-native-candle-timer"><Clock className="h-2.5 w-2.5" />Timer unavailable — feed not live-confirmed</Badge>
        : formingCloseMs != null
          ? <CandleCloseCountdown closeTimeMs={formingCloseMs} timeframe={normalizeChartTimeframe(timeframe)} clockRef={serverClockRef} requireServerClock />
          : <Badge variant="outline" className="gap-1 text-[10px] text-zinc-400" data-testid="arx-native-candle-timer"><Clock className="h-2.5 w-2.5" />Timer waiting for a verified candle-close timestamp</Badge>;
  const historyControls = (
    <ChartHistoryControls
      loadedCount={displayEngineCandles.length}
      oldestTimeMs={displayEngineCandles[0] ? displayEngineCandles[0]!.time * 1000 : null}
      clockLabel={utcClockQualified ? "UTC" : "source clock · UTC unverified"}
      archiveCount={archiveEngineCandles.length}
      archiveLabel={historySource === "mt5_broker" ? "Archived MT5 bars" : "Archived bars"}
      nativeHistory={deepHistory.nativeHistory}
      loading={deepHistory.loading}
      hasMore={deepHistory.hasMore}
      canLoad={hasCandles}
      onLoadOlder={() => deepHistory.loadOlder(oldestIsoRef.current)}
      onFitHistory={() => adapterRef.current?.fitHistory?.()}
    />
  );
  // Tools, forecast and the chart read open as one popup over the chart; a
  // launcher reveals its own section inside that popup.
  const openDetails = (sectionId: string) => {
    setAdvancedToolsMounted(true);
    setDetailsSection(sectionId === "arx-structural-forecast" ? "forecast" : sectionId === "arx-smart-chart-read" ? "read" : "tools");
    setAdvancedToolsOpen(true);
    const reveal = () => {
      document.getElementById(sectionId)?.scrollIntoView?.({ block: "nearest" });
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(reveal);
    else reveal();
  };
  const openDrawingTools = () => openDetails("arx-chart-workbench-tools");
  const closeDetails = () => setAdvancedToolsOpen(false);
  // Desktop: details float over the chart. Phones keep them inline below it.
  const detailsAsPopup = !mobileLayout;
  // A small terminal-style window: narrow, anchored to the chart's lower right
  // corner, showing one section, and movable by its title bar.
  const detailsPopupClass = "absolute bottom-2 right-2 z-30 max-h-[60%] w-[min(26rem,calc(100%-1rem))] overflow-auto rounded-md border border-zinc-600 bg-zinc-950 shadow-2xl shadow-black/70";
  const detailsPopupStyle = detailsAsPopup && advancedToolsOpen ? { transform: `translate(${detailsOffset.x}px, ${detailsOffset.y}px)` } : undefined;
  const detailsTitle = detailsSection === "tools" ? "Tools" : detailsSection === "forecast" ? "Forecast" : detailsSection === "read" ? "Chart read" : "Tools and analysis";
  const detailsPopupHeader = <div className="sticky top-0 z-10 flex cursor-move touch-none select-none items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-1 text-xs" data-testid="arx-native-details-titlebar"
    title="Drag to move this window"
    onPointerDown={event => {
      if ((event.target as HTMLElement).closest("button")) return;
      detailsDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: detailsOffset.x, y: detailsOffset.y };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }}
    onPointerMove={event => {
      const drag = detailsDrag.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      // Keep the title bar reachable inside the chart card.
      const card = cardRef.current?.getBoundingClientRect(), box = (event.currentTarget.closest("#arx-advanced-chart-content") ?? event.currentTarget).getBoundingClientRect();
      let x = drag.x + event.clientX - drag.startX, y = drag.y + event.clientY - drag.startY;
      if (card) {
        const baseLeft = box.left - detailsOffset.x, baseTop = box.top - detailsOffset.y;
        x = Math.min(card.right - 48 - baseLeft, Math.max(card.left - baseLeft - box.width + 96, x));
        y = Math.min(card.bottom - 32 - baseTop, Math.max(card.top - baseTop, y));
      }
      setDetailsOffset({ x, y });
    }}
    onPointerUp={event => { if (detailsDrag.current?.pointerId === event.pointerId) detailsDrag.current = null; }}
    onPointerCancel={() => { detailsDrag.current = null; }}>
    <strong className="truncate text-zinc-200">{detailsTitle} · {resolvedSymbol} · {timeframe}</strong>
    <Button size="sm" variant="ghost" className="h-6 w-6 shrink-0 p-0 text-sm leading-none" onClick={closeDetails} aria-label="Close chart tools and analysis" data-testid="arx-native-details-close">×</Button>
  </div>;
  // Sections stay mounted; the window shows the one that was asked for.
  const sectionClass = (name: "tools" | "forecast" | "read") => !detailsAsPopup || detailsSection === "all" || detailsSection === name ? "contents" : "hidden";
  const clockStatus = utcClockQualified ? "Clock: UTC" : "Source clock · UTC unverified";
  const volumeToggle = <Button size="sm" variant="outline" className="h-7 px-2 text-xs" aria-pressed={preferences.volumePane !== false} onClick={() => setPreferences(previous => ({ ...previous, volumePane: previous.volumePane === false }))} data-testid="chart-volume-toggle">Volume {preferences.volumePane === false ? "off" : "on"}</Button>;
  const compactQuickTools = compactDesktopWorkspace ? (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-2 py-1.5"
      role="toolbar"
      aria-label="Smart Chart quick tools"
      data-testid="arx-native-compact-tools"
    >
      {historyControls}
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        aria-label="Open drawing tools"
        aria-controls="arx-chart-workbench-tools"
        onClick={openDrawingTools}
        data-testid="arx-native-drawing-tools"
      >
        Drawing tools
      </Button>
      {layersMenu}
      {volumeToggle}
      <div className="ml-auto flex min-w-0 items-center" aria-label="Candle close timer">
        {compactTimer}
      </div>
    </div>
  ) : null;
  const chartControls = <Fragment key="chart-controls">
    <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-2">
            <button type="button" className="min-h-11 rounded border border-zinc-700 px-2 text-xs text-cyan-300 disabled:opacity-50" aria-pressed={assistantPane.active} disabled={!hasCandles||query.isError||!adapterRef.current} onClick={()=>assistantPane.activate()} data-testid="chart-assistant-activate">{assistantPane.active?"Assistant selected":"Use chart with assistant"}</button>
            <span className="text-[11px] text-zinc-400" data-testid="chart-assistant-pane-context">{assistantPane.active?"Selected for local chart tools: ":"Select to use local chart tools: "}{resolvedSymbol} · {timeframe} · {data?.feedStatus?.source??"Unknown source"}{workspaceId!=="primary"?" · analysis only; primary trading unchanged":" · primary chart"}</span>
    </div>
    {mobileLayout && <div className="px-3 py-2">{timeframeControls}</div>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2" role="toolbar" aria-label="Chart view controls">
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!hasCandles} onClick={() => adapterRef.current?.goToLatest?.()} title="Return to latest candles (End)">
            <ArrowRightToLine className="mr-1 h-3.5 w-3.5" /> Latest
          </Button>
          {historyControls}
          {/* Browser settings survive feed rebinding; actual chart selection still closes the library. */}
          <ChartTemplatesPanel key={JSON.stringify([resolvedSymbol,timeframe])} preferences={preferences} onPreferences={setPreferences}/>
          {!compactDesktopWorkspace && layersMenu}
          {!compactDesktopWorkspace && volumeToggle}
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!hasCandles} aria-expanded={researchOpen} onClick={()=>{setResearchRequest(null);setResearchOpen(open=>!open);}}>Test an idea</Button>

        </div>
      </div>

      <div id="arx-chart-workbench-tools" data-testid="arx-chart-workbench-tools">
        <ChartWorkbenchTools studyEvidenceRevision={mergedEngineCandles} assistantActive={assistantPane.active} assistantIsCurrent={assistantPane.isCurrent} utcClockQualified={utcClockQualified} getSupportResistanceProposal={getSupportResistanceProposal} getFibonacciProposal={getFibonacciProposal} key={`${workbenchMarket}:${workbenchGeneration}`} chartTarget={containerRef} showTemplates={false} adapter={adapterRef.current} epoch={chartEpoch} symbol={resolvedSymbol} timeframe={timeframe} preferences={preferences} onPreferences={setPreferences} hasCandles={hasCandles} feedLabel={chartExportFeedLabel({ source: data?.feedStatus?.source, liveConfirmed: isLivePriceAffordance, warning: data?.feedStatus?.warning, newestBarOpenTime: hasCandles ? candles[candles.length - 1]!.openTime : null, streamReconnecting: streamWatchdog.stalled, marketClosed: scheduledClosure, quoteFrozen: marketFrozen != null && !scheduledClosure })} />
      </div>
      {!preferencesSaved && <p className="px-3 py-2 text-xs text-amber-300" role="alert">Browser storage is unavailable. Chart preferences will reset when this view closes.</p>}

      {hasCandles && <div className="px-3 pt-1"><RenderVerdictChip verdict={renderVerdict} /></div>}
      <output ref={linkStatusRef} aria-label="Linked chart history status" className="block px-3 text-xs text-amber-300 empty:hidden" />
  </Fragment>;

  const chartDetailsContent = <>
    <div className={sectionClass("tools")} data-testid="arx-details-section-tools">
    {chartControls}
    {researchOpen&&<Suspense fallback={<p role="status" className="p-3 text-xs">Opening historical research tools…</p>}><ChartResearchWorkbench key={chartContext} data={data} symbol={resolvedSymbol} timeframe={timeframe} canonicalBars={mergedEngineCandles} getVisibleBars={researchVisibleBars} request={researchRequest?.context===chartContext?researchRequest:null} onOverlays={acceptResearchOverlays} onExplanation={acceptResearchExplanation} onClose={()=>setResearchOpen(false)}/></Suspense>}
    </div>
    <div className={sectionClass("forecast")} data-testid="arx-details-section-forecast">
    <div id="arx-structural-forecast" data-testid="arx-structural-forecast"><StructuralForecastPanel key={`structural:${chartContext}`} symbol={resolvedSymbol} onPaths={acceptScenarioPaths} /></div>
    </div>
    <div className={sectionClass("read")} data-testid="arx-details-section-read">
      <div id="arx-smart-chart-read" data-testid="arx-smart-chart-read"><SmartChartReader key={`${resolvedSymbol}:${timeframe}:${evidenceIdentity??"unidentified"}`} adapter={adapterRef.current} epoch={chartEpoch} symbol={resolvedSymbol} timeframe={timeframe} data={data} older={deepHistory.analysisCandles} historyEvidence={deepHistory.analysisEvidence} liveConfirmed={isLivePriceAffordance} readFailed={query.isError} view={preferences} /></div>
    <details ref={dataWindowRef} className="border-t border-zinc-800 px-3 py-2 text-xs" onToggle={() => updateLegend(inspectedCandleRef.current)}>
      <summary className="cursor-pointer text-zinc-400">Data window · study values at the crosshair</summary>
      <output ref={studyInspectorRef} aria-label="Study values at selected candle" className="mt-2 block font-mono text-[11px] text-zinc-300">Add a study to inspect its values.</output>
    </details>
    </div>
  </>;

  return (
    <Card ref={cardRef} role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label={expanded ? `${resolvedSymbol} fullscreen chart` : undefined} data-testid="arx-native-chart" className={expanded ? "fixed inset-0 z-50 overflow-auto rounded-none border-zinc-800 bg-zinc-950" : "relative overflow-hidden border-zinc-800 bg-zinc-950/40"}>
      <CardHeader className={compactDesktopWorkspace ? "arx-native-chart-header-compact px-2 py-1 md:px-3" : "py-3 px-3 md:px-4"}>
        <CardTitle className={compactDesktopWorkspace ? "arx-native-chart-title-compact flex flex-col items-stretch gap-1 text-sm" : "flex flex-wrap items-center justify-between gap-2 text-sm"}>
          <div className={`flex flex-wrap items-center ${compactDesktopWorkspace ? "min-w-0 gap-1" : "gap-2"}`}>
            <CandlestickChart className="h-4 w-4 text-primary" />
            <Badge variant="outline" className="text-[10px]">ARX SMART CHART</Badge>
            {workspaceId === "primary" ? <AssistantDockSlot assistantEnabled={assistantPane.active}/> : assistantPane.active ? <AssistantDockSlot assistantOnly/> : null}
            {fullscreenToggle}
            {compactWorkspace && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0"
                aria-label="Reload chart candles"
                title="Reload chart candles"
                data-testid="arx-native-reload"
                disabled={externalFeed?.isFetching ?? query.isFetching}
                onClick={() => { if (externalFeed) void externalFeed.refetch(); else void query.refetch(); }}
              >
                {(externalFeed?.isFetching ?? query.isFetching)
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true"/>
                  : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true"/>}
              </Button>
            )}
            <span data-testid="arx-native-symbol" className="text-base font-semibold text-zinc-100">
              {resolvedSymbol}
            </span>
            {mode && (
              <Badge variant="outline" className="text-[10px] uppercase text-muted-foreground" data-testid="arx-native-mode">
                {mode}
              </Badge>
            )}
            {lastClose != null && (
              // The canvas removes its live-price line/label when the feed is not
              // live-confirmed; the header must say the same thing in words.
              <Badge
                variant="outline"
                className={`font-mono text-xs ${headerPriceLive ? "" : "text-zinc-400"}`}
                data-testid="arx-native-last"
                title={headerPriceLive
                  ? undefined
                  : marketFrozen
                    ? "Close of the newest bar received. The broker keeps sending the same quote, so this is not a moving price."
                    : "Close of the newest bar received. The feed is not live-confirmed, so this may not be the current price."}
              >
                {headerPriceLive ? "" : "Last known "}
                {formatInstrumentPrice(lastClose, pricePrecision)}
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
              />
            )}
            {refreshFailed && (
              <Badge
                variant="outline"
                className="flex items-center gap-1 border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-200"
                data-testid="arx-native-refresh-failed"
                title="The latest candle request failed. The bars shown are the last successful response and are not updating."
              >
                <AlertTriangle className="h-3 w-3" /> Refresh failed
                {(query.dataUpdatedAt ?? 0) > 0
                  ? ` — showing data from ${new Date(query.dataUpdatedAt!).toISOString().slice(11, 19)} UTC`
                  : " — showing the last response"}
              </Badge>
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
            {frozenChip && (
              <Badge
                variant="outline"
                className="flex items-center gap-1 border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-200"
                data-testid="arx-native-market-closed"
                data-scheduled-closure={scheduledClosure ? "true" : "false"}
                title={frozenChip.title}
              >
                <Clock className="h-3 w-3" /> {frozenChip.label}
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
            {!compactDesktopWorkspace && formingCloseMs != null && isLivePriceAffordance && !marketFrozen && (
              <CandleCloseCountdown closeTimeMs={formingCloseMs} timeframe={normalizeChartTimeframe(timeframe)} clockRef={serverClockRef} />
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
                loadError={deepHistory.loadError}
              />
            )}
            {archiveEngineCandles.length > 0 && (
              <Badge
                variant="outline"
                className="border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-200"
                data-testid="chart-history-archive-header"
                title={deepHistory.nativeHistory ? "The archived account and source identity are verified. Native broker timestamps are retained; historical UTC mapping remains unverified." : "The older segment is kept separate from the current chart series. Its original account-era identity is unverified and it is excluded from verified analysis."}
              >
                {deepHistory.nativeHistory ? "Archived · source verified · broker clock" : "Archived · identity unverified · display only"}
              </Badge>
            )}
          </div>
          {!mobileLayout && timeframeControls}
        </CardTitle>
      </CardHeader>

      {compactQuickTools}
      {replayError && <p className={compactDesktopWorkspace ? "px-2 pb-1 text-xs text-amber-300" : "px-3 pb-2 text-xs text-amber-300"} role="status">{replayError}</p>}
      {tradeVolumeSelected && hasCandles && <p className={compactDesktopWorkspace ? "px-2 pb-1 text-xs text-amber-300" : "px-3 pb-2 text-xs text-amber-300"} role="status">{hasQualifiedTradeVolume ? "Trade volume and VWAP use qualified provider-reported trade units on original closed bars, not tick counts or proven shares. Only loaded observations are covered; missing, zero or partial volume stays blank and holds later cumulative VWAP. Saved anchors stay bound to their original series." : "Trade volume / VWAP unavailable: no qualified positive traded quantities for these loaded candles. Tick counts and missing or zero volume are not substituted."}</p>}
      {tickVolumeSelected && hasCandles && !hasQualifiedTickVolume && <p className={compactDesktopWorkspace ? "px-2 pb-1 text-xs text-amber-300" : "px-3 pb-2 text-xs text-amber-300"} role="status">Tick volume unavailable for these loaded candles: no qualified per-bar tick counts were supplied. Tick volume is not traded size; missing counts stay blank.</p>}
      {!supportedTimeframe && <p className={compactDesktopWorkspace ? "px-2 pb-1 text-xs text-amber-300" : "px-3 pb-2 text-xs text-amber-300"} role="status">{chartIntervalLimitation(timeframe) ?? "This chart interval is unsupported."}</p>}

      {/* This is a presentation of the existing owners, not another verdict.
          Every active restriction stays outside the disclosure. Full original
          explanations and the feed strip remain mounted in normal flow, separate from the canvas/position coordinate origin. */}
      <section aria-label="Chart evidence" className="border-b border-zinc-800/60">
        {nativeSnapshotObservedAt && <p className="px-3 pt-1 text-xs text-zinc-400" data-testid="native-forming-snapshot-time" title={nativeSnapshotObservedAt}>
          Current candle snapshot observed {nativeSnapshotObservedAt.slice(11, 19)} UTC; quote updates separately.
        </p>}
        {(isSafeMode || stripIntegrityFailed || (!utcClockQualified && hasCandles) ||
          (hasCandles && !ohlcAvailable && !isSafeMode) || showPoorBanner || showNotAiConfirmed) && (
          <div className="flex flex-wrap gap-x-2 gap-y-1 px-3 pt-1 text-xs leading-4" data-testid="chart-evidence-restrictions">
            {(isSafeMode || stripIntegrityFailed) && <span className="font-semibold text-red-200">Data validation failed — AI analysis paused</span>}
            {!utcClockQualified && hasCandles && <span className="text-amber-300">Source clock: UTC mapping unverified</span>}
            {hasCandles && !ohlcAvailable && !isSafeMode && <span className="text-amber-200">Line mode — OHLC candles are flat</span>}
            {showPoorBanner && <span className={conf.severity === "danger" ? "text-red-200" : "text-amber-200"}>{conf.statusLabel} feed</span>}
            {showNotAiConfirmed && <span className="text-amber-200">Not AI-confirmed</span>}
          </div>
        )}
        <details data-testid="chart-evidence-details">
          <summary className={`cursor-pointer px-3 ${compactDesktopWorkspace ? "py-1" : "py-1.5"} text-xs leading-4 text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary`}>
            <span>Chart evidence details</span><span className="ml-2 text-zinc-400">{stripLabel} · {timeframe}</span>
          </summary>
      {/* Feed strip — the server's grade of the candle response on screen
          (capped exactly like the header chip) and the specific reason when it
          is stale, invalid or unavailable. Informational only; it never gates
          candles or trades. There is no broker-mirror comparison behind it, so
          it never claims the chart is "mirrored", and it has no lock control. */}
      <div
        className="flex flex-wrap items-center gap-2 border-b border-zinc-800/60 bg-zinc-950/20 px-3 py-1.5 text-[10px]"
        data-testid="arx-mirror-layer"
        title="Feed grade the server reported for the candles on screen, capped by the shared scanner truth."
      >
        <span
          className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${stripStyle.dot}`}
        />
        <span className={`font-medium ${stripStyle.text}`} data-testid="arx-mirror-status">
          {stripLabel}
        </span>
        <span className="text-zinc-500">
          {resolvedSymbol} · {timeframe}
        </span>
        {stripIntegrityFailed && (
          <span className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[9px] text-red-300" data-testid="arx-mirror-conflict">
            Data integrity failed — analysis paused
          </span>
        )}
        {storedHistoryText && (
          <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[9px] text-sky-200" data-testid="arx-stored-history">
            {storedHistoryText}
          </span>
        )}
        {stripStaleText && (
          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-300" data-testid="arx-mirror-stale">
            {stripStaleText}
          </span>
        )}
        {stripUnavailable && (
          <span className="rounded border border-zinc-700 bg-zinc-800/40 px-1.5 py-0.5 text-[9px] text-zinc-400" data-testid="arx-mirror-unavailable">
            {feedStatus?.quality === "empty"
              ? "The provider returned no candles"
              : "No provider could serve this symbol"}
          </span>
        )}
        {stripRefreshing && (
          <span className="ml-auto inline-flex items-center gap-1 text-sky-300" data-testid="arx-mirror-refreshing">
            <RefreshCw className="h-2.5 w-2.5 animate-spin" /> Refreshing…
          </span>
        )}
      </div>

      {!utcClockQualified && hasCandles && <p className="px-3 text-[11px] text-amber-300" data-testid="chart-clock-authority">{SOURCE_CLOCK_NOTE}</p>}

      {/* Persistent notices stay in normal flow so they cannot obscure candles,
          user notes or projected position controls. The relative canvas/overlay
          container below retains one unchanged coordinate origin. */}
      {/* Phase 2 — Chart Safe Mode notice.
          When quality="invalid" (integrity check failed) we show a clear
          user-safe message above the chart. Candles are still drawn below
          because they are real data (just flagged). Open position overlays
          remain visible. AI reads are paused (conf.aiUsable will be false).
          This is NOT an error state — it is a "read with extreme caution"
          state. We never invent a safe state or pretend the data is clean. */}
      {isSafeMode && (
        <div
          className="flex flex-wrap items-start gap-3 bg-red-950/80 px-3 py-3 text-xs backdrop-blur-sm"
          data-testid="arx-native-safe-mode"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-red-100">Chart Safe Mode — data validation failed</div>
            <div className="mt-0.5 text-[11px] text-red-300/90">
              {warning || "Candle integrity checks failed. This chart is not confirmed for AI analysis or live decisions."}
            </div>
          </div>
        </div>
      )}

      {/* Phase 2 — OHLC mode indicator.
          When candles are present but the spread check fails (flat bars), the
          candlestick label is misleading. We add a labeled banner so the user
          knows what they are looking at. This is NOT an error — the feed is
          returning data, it just lacks meaningful OHLC spread. */}
      {hasCandles && !ohlcAvailable && !isSafeMode && (
        <div
          className="flex items-center gap-2 bg-amber-950/70 px-3 py-2 text-xs backdrop-blur-sm"
          data-testid="arx-native-line-mode"
        >
          <LineChart className="h-3.5 w-3.5 shrink-0 text-amber-300" />
          <span className="text-amber-200">
            Line mode — OHLC candles are flat on this feed. Price action shown, no spread.
          </span>
        </div>
      )}

      {/* Prominent feed banner — only when candles are drawn but the feed is
          degraded/stale (and NOT in safe mode, which has its own notice). */}
      {showPoorBanner && (
        <div
          data-testid="arx-native-feed-banner"
          data-severity={bannerConf.severity}
          className={`flex flex-wrap items-center gap-2 px-3 py-2 text-xs backdrop-blur-sm ${
            bannerConf.severity === "danger"
              ? "bg-red-950/70 text-red-100"
              : bannerConf.severity === "caution"
                ? "bg-amber-950/60 text-amber-100"
                : "bg-zinc-900/70 text-zinc-100"
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="font-semibold">{bannerConf.statusLabel} feed</span>
          <span className="min-w-0 flex-1 break-words text-xs opacity-90">
            {bannerConf.message}
          </span>
          {query.isFetching && !query.isLoading && (
            <RefreshCw className="h-3 w-3 animate-spin opacity-60" />
          )}
        </div>
      )}

        </details>
      </section>

      <CardContent key="plot" className={compactWorkspace ? "arx-native-plot relative p-0" : "relative p-0"}>
        {/* The chart canvas is always mounted so the v5 series handle is stable;
            overlays cover it for loading / empty / error. */}
        <div
          {...canvasEvents}
          ref={containerRef}
          tabIndex={0}
          role="region"
          aria-label={`${resolvedSymbol} ${timeframe} price chart. Drag or arrow keys to pan; scroll, plus or minus to zoom. Home fits history; End returns to latest candles. Delete or Backspace removes the selected unlocked drawing; Control or Command Z undoes a drawing edit; add Shift to redo.`}
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

        {hasCandles && canvasOverlay}

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
            </div>
          </div>
        )}

        {isEmpty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/95 p-4 text-center" data-testid="arx-native-empty">
            <CandlestickChart className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-semibold">
              {feedStatus?.quality === "unavailable"
                ? "No live feed available"
                : "No native candles available"}
            </p>
            {/* The server's own explanation wins; the fallback names exactly
                what was asked for and that no provider answered. */}
            <p className="max-w-md text-xs text-muted-foreground">
              {feedStatus?.quality === "unavailable"
                ? feedStatus.warning?.trim() || warning?.trim() ||
                  `No data provider could serve ${resolvedSymbol} on ${timeframe} right now. Try a different symbol, or try again when the feed is available.`
                : warning ||
                  `No native candles available for ${resolvedSymbol} on ${timeframe} right now.`}
            </p>
          </div>
        )}
      </CardContent>
      <output ref={legendRef} aria-label="Candle time, OHLC prices, high–low range and volume" className="block min-h-8 whitespace-normal break-words border-t border-zinc-800 pl-3 pr-20 py-2 font-mono text-[11px] leading-5 text-zinc-300" data-testid="chart-candle-inspector">
        Move the crosshair over a candle to inspect its prices, range and volume
      </output>
      {/* Detailed tools stay mounted after the plot on every viewport. Source
          and safety notices above it remain visible before any candle. */}
      {detailsAsPopup && <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 px-3 py-1.5 text-xs" role="toolbar" aria-label="Chart tools and analysis" data-testid="arx-native-detail-launchers">
        <span className={`rounded border px-2 py-1 text-[11px] ${utcClockQualified ? "border-zinc-700 text-zinc-300" : "border-amber-700/60 text-amber-200"}`} data-testid="chart-clock-status"
          title={utcClockQualified ? "Candle times are qualified UTC." : "Candle times are the broker source clock. A UTC mapping has not been verified, so no time-zone conversion is offered."}>{clockStatus}</span>
        {!compactDesktopWorkspace && <>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" aria-haspopup="dialog" aria-controls="arx-advanced-chart-content" onClick={() => openDetails("arx-chart-workbench-tools")} data-testid="arx-native-open-tools">Tools</Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" aria-haspopup="dialog" aria-controls="arx-advanced-chart-content" onClick={() => openDetails("arx-structural-forecast")} data-testid="arx-native-open-forecast">Forecast</Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" aria-haspopup="dialog" aria-controls="arx-advanced-chart-content" onClick={() => openDetails("arx-smart-chart-read")} data-testid="arx-native-open-read">Chart read</Button>
        </>}
      </div>}
      {/* Detailed tools stay mounted. On desktop they open as a popup over the
          chart instead of extending the page below it. */}
      {compactWorkspace ? (
        <div
          id="arx-advanced-chart-content"
          className={compactDesktopWorkspace ? (advancedToolsOpen ? detailsPopupClass : "") : "border-t border-zinc-800"}
          style={compactDesktopWorkspace ? detailsPopupStyle : undefined}
          data-testid="arx-native-advanced-details"
          hidden={compactDesktopWorkspace && !advancedToolsOpen}
          onKeyDown={compactDesktopWorkspace ? event => { if (event.key === "Escape") { event.stopPropagation(); closeDetails(); } } : undefined}
        >
          {compactDesktopWorkspace && advancedToolsMounted && detailsPopupHeader}
          {(!compactDesktopWorkspace || advancedToolsMounted) && <div className="space-y-2">{chartDetailsContent}</div>}
        </div>
      ) : (
        // One wrapper at every width: switching between the desktop popup and
        // the inline phone layout must not remount tools or lose their state.
        <div
          id="arx-advanced-chart-content"
          role={detailsAsPopup ? "dialog" : undefined}
          aria-label={detailsAsPopup ? "Chart tools and analysis" : undefined}
          className={!detailsAsPopup ? "" : advancedToolsOpen ? detailsPopupClass : "hidden"}
          style={detailsPopupStyle}
          data-testid="arx-native-details-popup"
          onKeyDown={event => { if (detailsAsPopup && event.key === "Escape") { event.stopPropagation(); closeDetails(); } }}
        >
          <div className={detailsAsPopup ? "contents" : "hidden"}>{detailsPopupHeader}</div>
          {chartDetailsContent}
        </div>
      )}
    </Card>
  );
}

/** Strip chip for bars served from stored history: last bar and its age. */
export function storedHistoryChipText(newestOpenIso: string, nowMs: number): string {
  const opened = Date.parse(newestOpenIso);
  if (!Number.isFinite(opened)) return "Stored history, not live";
  const mins = Math.max(0, Math.floor((nowMs - opened) / 60_000));
  const age = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.floor(mins / 60)} h` : `${Math.floor(mins / 1440)} days`;
  return `Stored history up to the last bar (${age} ago), not live`;
}

export default ARXNativeChart;
