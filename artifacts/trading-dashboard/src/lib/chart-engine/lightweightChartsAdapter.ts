import {
  createChart,
  CandlestickSeries,
  BarSeries,
  LineSeries,
  AreaSeries,
  BaselineSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  type UTCTimestamp,
  type Time,
  type TickMarkFormatter,
  type TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type SeriesMarker,
} from "lightweight-charts";
import {
  type ChartOverlay,
  overlayColor,
} from "@/lib/chart-overlays";
import { sanitizeCandlestickData, snapSecToCandle } from "@/lib/chart-engine/candleSanitize";
import type {
  ChartEngineAdapter,
  ChartEngineCandle,
  ChartEngineCapabilities,
  ChartEngineFeedState,
  ChartEngineInitOptions,
  ChartStructureLine,
  ChartStructureMarker,
} from "./types";
import { candleDisplayPrecision, incrementalCandles, historyRangeShift, unchangedCandlePrefix } from "./candleReconciliation";
import { candleIndex, ChartDrawingEditor, type DrawingInteraction } from "./chartDrawingEditor";
import { ChartAnalysisRenderer, type PriceSeries } from "./chartAnalysisRenderer";
import type { ChartStudy } from "./chartStudies";
import { closeOnlyStyle, type ChartAnchor, type ChartDrawing, type ChartStyle, type ChartScaleMode } from "./chartWorkspace";
import { heikinAshiBar, heikinAshiSuffix, hollowPoint } from "./heikinAshi";
import { applyStructureLines, clearStructureLines } from "./structureLines";
import { candleAtLinkedTime, validTimeRange, type ChartTimeRange, type ChartViewEvent } from "./chartViewLink";
import { panChartWindow, zoomChartWindow } from "./chartNavigation";
import { SmartChartAnnotationPrimitive, type SmartChartAnnotation } from "./smartChartAnnotation";
import { crosshairTimeLabel, tickMarkLabel, type ChartTickMarkType, type ChartTimeZone } from "./chartTimeZone";

// The helper's tick types mirror lightweight-charts' TickMarkType numbers.
const TICK_MARK_TYPES_MATCH: Record<TickMarkType, ChartTickMarkType> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4 } satisfies Record<ChartTickMarkType, ChartTickMarkType>;
void TICK_MARK_TYPES_MATCH;


type DisplayMode = "ohlc" | "close" | "heikinAshi" | "hollow";
const displayModeOf = (style: ChartStyle): DisplayMode => style === "heikinAshi" || style === "hollow" ? style : closeOnlyStyle(style) ? "close" : "ohlc";

const DEFAULT_VISIBLE_DESKTOP = 150;
const DEFAULT_VISIBLE_MOBILE = 80;

const CAPABILITIES: ChartEngineCapabilities = {
  id: "lightweight-charts",
  label: "ARX Native (lightweight-charts v5)",
  available: true,
  candles: true,
  priceLines: true,
  markers: true,
  zones: true,
  coordinateApi: true,
  // Drawing tools are owned by the ARX shell; execution handles stay separate.
  drawingTools: true,
  draggableOrders: false,
};

/**
 * lightweight-charts v5 implementation of the ARX chart-engine contract.
 *
 * This class is the SINGLE owner of the imperative chart engine: chart/series
 * lifecycle, candle data, the live-price affordance, read-only overlays
 * (price lines / zones / markers), the smart initial visible range, reset scale,
 * the crosshair throttle, and the ResizeObserver. It is engine-specific by
 * design; the React shell (ARXNativeChart) and the Smart Chart Shell drive it
 * only through the `ChartEngineAdapter` interface.
 *
 * SAFETY: view-only. No method places, modifies, or closes a trade. Overlays
 * are consumed as the shared read-only `ChartOverlay` model. Candles are
 * supplied pre-normalized by the caller — this class never fabricates bars.
 *
 * lightweight-charts v5 note: series are created with
 * `addSeries(CandlestickSeries, options)`. The legacy v4 `addCandlestickSeries()`
 * / `series.setMarkers()` methods were REMOVED and throw at runtime — never cast
 * a call to re-introduce them (markers go through `createSeriesMarkers`).
 */
export class LightweightChartsAdapter implements ChartEngineAdapter {
  readonly capabilities = CAPABILITIES;

  private chart: IChartApi | null = null;
  private series: PriceSeries | null = null;
  private style: ChartStyle = "candles";
  // How this.style maps a canonical candle to a series point, resolved once per
  // style switch so the tick and full-write paths make one comparison per point
  // for candles and bars.
  private displayMode: DisplayMode = "ohlc";
  // Display-only Heikin Ashi bars, index-aligned with this.candles while the
  // style is heikinAshi (empty otherwise). Never read by studies, drawings,
  // overlays or the reader; those use this.candles.
  private haBars: ChartEngineCandle[] = [];
  // Baseline style: the price currently applied as the series base value (the
  // first loaded close), or null when none has been applied.
  private baselineValue: number | null = null;
  private analysis: ChartAnalysisRenderer | null = null;
  private drawingEditor: ChartDrawingEditor | null = null;
  private drawingHandler: ((anchor: ChartAnchor) => void) | null = null;
  private drawingInteraction: DrawingInteraction | null = null;
  private navigationMode: "inspect" | "pan" = "inspect";
  private viewportListeners = new Set<() => void>();
  private viewportFrame: number | null = null;
  private smartAnnotation: SmartChartAnnotation | null = null;
  private smartAnnotationKey = "null";
  private smartAnnotationPrimitive: SmartChartAnnotationPrimitive | null = null;
  private overlaysRaw: ChartOverlay[] = [];
  private overlayTime: number | null = null;
  private lastPriceLine: IPriceLine | null = null;
  private overlayLines: IPriceLine[] = [];
  private markersApi: { detach: () => void } | null = null;
  // Read-only structural overlays (detected trendlines/channels) live on their
  // OWN line series + marker channel, separate from trade-plan price lines, so
  // clearing one never disturbs the other. Display-only.
  private structureSeries: ISeriesApi<"Line">[] = [];
  private structureMarkersApi: { detach: () => void } | null = null;
  // Raw (un-snapped) structural overlay as last handed to setStructureLines, so
  // the markers can be RE-SNAPPED onto real bars whenever setCandles slides the
  // window. A marker left anchored to a bar that rolled off the series makes
  // lightweight-charts' findBar() return null and the candlestick colorer throw
  // "Value is null" on the next repaint — uncatchable at any call site — so the
  // adapter self-heals its own anchors instead of trusting the caller to redraw.
  private structureLinesRaw: ChartStructureLine[] = [];
  private structureMarkersRaw: ChartStructureMarker[] = [];
  // Snapped marker times of the currently-applied structure draw, used to skip
  // a redraw when a candle refresh didn't actually move any anchor.
  private structureSnappedTimes: number[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private crosshairFrame: number | null = null;
  private crosshairHandler: ((candle: ChartEngineCandle | null) => void) | null = null;
  private hoveredCandle: ChartEngineCandle | null = null;
  private streamTip: ChartEngineCandle | null = null;
  private symbol = "";
  private precision = -1;
  private intervalSeconds = 900;
  private viewLinkHandler: ((event: ChartViewEvent) => void) | null = null;
  private viewLinkStatusHandler: ((message: string) => void) | null = null;
  private viewLinkFrame: number | null = null;
  private pendingLinkedCursor: number | null | undefined;
  private pendingRange = false;
  private ownsRange = false;
  private linkedRange: ChartTimeRange | null = null;
  private linkedCursor: number | null | undefined;
  private clearViewListeners: (() => void) | null = null;
  // Display-only time zone. Installed once at createChart as stable formatter
  // references (applyOptions cannot remove a formatter; only destroy resets
  // it), so a zone change is one applyOptions call with no setData.
  private displayZone: ChartTimeZone = "UTC";
  // lightweight-charts' own default localization.locale.
  private locale = typeof navigator !== "undefined" ? navigator.language : "";
  private readonly timeLabel = (time: Time): string => typeof time === "number" ? crosshairTimeLabel(time, this.displayZone, this.locale) : String(time);
  private readonly tickLabel: TickMarkFormatter = (time, type, locale) => typeof time === "number" ? tickMarkLabel(time, type as number as ChartTickMarkType, this.displayZone, locale) : null;

  private container: HTMLElement | null = null;
  private candles: ChartEngineCandle[] = [];
  // Newest bar time (Unix seconds) the series currently holds. Tracks both
  // setCandles (authoritative closed window) and updateActiveCandle (live tip)
  // so a streaming tip can never feed lightweight-charts an out-of-order time.
  private newestSeriesTime: number | null = null;
  private didFit = false;
  private feedState: ChartEngineFeedState = { livePriceAffordance: false };
  private visibleDesktop = DEFAULT_VISIBLE_DESKTOP;
  private visibleMobile = DEFAULT_VISIBLE_MOBILE;

  // Deep-history scroll-back (Task #438). The Shell registers a handler that
  // loads older bars; we fire it when the user scrolls near the oldest loaded
  // bar. View-only — loading history never touches an execution path.
  private reachStartHandler: (() => void) | null = null;
  private reachStartThresholdBars = 20;

  init(options: ChartEngineInitOptions): void {
    // Defensive: ensure a clean container even if a prior instance left nodes.
    this.destroy();

    const el = options.container;
    el.innerHTML = "";
    this.container = el;
    this.didFit = false;
    this.candles = [];
    this.haBars = [];
    this.baselineValue = null;
    this.newestSeriesTime = null;
    this.streamTip = null;
    this.precision = -1;
    this.visibleDesktop = options.visibleDesktop ?? DEFAULT_VISIBLE_DESKTOP;
    this.visibleMobile = options.visibleMobile ?? DEFAULT_VISIBLE_MOBILE;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: options.height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#a1a1aa",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(63, 63, 70, 0.25)" },
        horzLines: { color: "rgba(63, 63, 70, 0.25)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: this.timeLabel },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: this.tickLabel,
        borderColor: "rgba(63, 63, 70, 0.5)",
        // rightOffset keeps the latest candle slightly inside the canvas edge so
        // the forming bar never clips against the price axis.
        rightOffset: 8,
        // Let the user zoom/pan freely without the chart fighting them.
        lockVisibleTimeRangeOnResize: true,
      },
      rightPriceScale: {
        borderColor: "rgba(63, 63, 70, 0.5)",
        // autoScale on the right price scale fits the y-axis to only the VISIBLE
        // candles rather than the entire loaded history, eliminating the
        // "compressed flat line" symptom on H4/D1 views.
        autoScale: true,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
    });

    // lightweight-charts v5: addSeries(SeriesDefinition, options). The legacy v4
    // addCandlestickSeries() was removed and throws at runtime. Do NOT cast.
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });

    // At most one legend update per animation frame; no React render per pixel.
    chart.subscribeCrosshairMove((event) => {
      const time = event.time;
      // Read canonical OHLC even when the visible series is a close-price line.
      let lo = 0, hi = this.candles.length - 1;
      this.hoveredCandle = null;
      if (event.point && typeof time === "number") while (lo <= hi) {
        const mid = (lo + hi) >>> 1, candle = this.candles[mid]!;
        if (candle.time === time) { this.hoveredCandle = candle; break; }
        if (candle.time < time) lo = mid + 1; else hi = mid - 1;
      }
      if (event.sourceEvent) {
        this.linkedCursor = undefined;
        this.pendingLinkedCursor = this.hoveredCandle?.time ?? null;
        this.queueViewLinkUpdate();
      }
      this.queueLegendUpdate();
    });

    // Deep-history scroll-back: when the user pans so the left edge approaches the
    // OLDEST loaded bar (logical index near 0), ask the Shell to load more. The
    // handler guards its own concurrency; this only signals intent. View-only.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      this.queueViewportUpdate();
      if (this.ownsRange) { this.pendingRange = true; this.queueViewLinkUpdate(); }
      // Linking only inspects loaded history. A clipped follower must not
      // silently page its entire provider history across several views.
      if (this.linkedRange || !this.reachStartHandler || !range) return;
      if (range.from <= this.reachStartThresholdBars) {
        this.reachStartHandler();
      }
    });

    this.chart = chart;
    this.series = series;
    const takeRange = () => this.takeRangeOwnership();
    const leave = () => { this.pendingLinkedCursor = null; this.queueViewLinkUpdate(); };
    el.addEventListener("pointerdown", takeRange, true);
    el.addEventListener("wheel", takeRange, {capture:true,passive:true});
    el.addEventListener("keydown", takeRange, true);
    el.addEventListener("pointerleave", leave);
    this.clearViewListeners = () => {
      el.removeEventListener("pointerdown", takeRange, true);
      el.removeEventListener("wheel", takeRange, true);
      el.removeEventListener("keydown", takeRange, true);
      el.removeEventListener("pointerleave", leave);
    };
    let frozenOptions: { scroll: ReturnType<IChartApi["options"]>["handleScroll"]; scale: ReturnType<IChartApi["options"]>["handleScale"]; autoScale: boolean } | null = null;
    const anchorAt = (point: { x:number; y:number }, snap: boolean) => {
      const time = chart.timeScale().coordinateToTime(point.x);
      let price: number | null | undefined = this.series?.coordinateToPrice(point.y);
      if (typeof time !== "number" || price == null || !Number.isFinite(price) || price <= 0) return null;
      const candle = this.candles[candleIndex(this.candles, time)];
      if (!candle) return null;
      if (snap) price = [candle.open,candle.high,candle.low,candle.close].reduce((best,value) => {
        const y = this.series?.priceToCoordinate(value), bestY = this.series?.priceToCoordinate(best);
        return y != null && bestY != null && Math.abs(y-point.y) < Math.abs(bestY-point.y) ? value : best;
      });
      return { time, price };
    };
    this.drawingEditor = new ChartDrawingEditor(el, {
      candles: () => this.candles,
      project: (anchor, priceOnly) => {
        const y = this.series?.priceToCoordinate(anchor.price);
        const x = priceOnly ? 0 : candleIndex(this.candles, anchor.time) >= 0 ? chart.timeScale().timeToCoordinate(anchor.time as UTCTimestamp) : null;
        return x != null && y != null && Number.isFinite(y) ? {x,y} : null;
      },
      anchor: anchorAt,
      price: y => this.series?.coordinateToPrice(y) ?? null,
      size: () => ({width:chart.timeScale().width(),height:chart.panes()[0]?.getHeight() ?? 0}),
      render: drawings => this.analysis?.setDrawings(drawings, this.candles),
      select: id => this.analysis?.selectDrawing(id),
      freeze: active => {
        if (active && !frozenOptions) {
          const options = chart.options();
          frozenOptions = {scroll:options.handleScroll,scale:options.handleScale,autoScale:this.series!.priceScale().options().autoScale};
          chart.applyOptions({handleScroll:false,handleScale:false});
          this.series?.priceScale().applyOptions({autoScale:false});
        } else if (!active && frozenOptions) {
          chart.applyOptions({handleScroll:frozenOptions.scroll,handleScale:frozenOptions.scale});
          this.series?.priceScale().applyOptions({autoScale:frozenOptions.autoScale});
          frozenOptions = null;
        }
      },
    });

    this.style = "candles";
    this.displayMode = "ohlc";
    this.analysis = new ChartAnalysisRenderer(chart, series);
    this.lastPriceLine = null;
    this.overlayLines = [];
    this.markersApi = null;
    this.structureSeries = [];
    this.structureMarkersApi = null;

    const ro = new ResizeObserver(() => {
      // destroy() nulls this.container synchronously with chart.remove(), so the
      // guard short-circuits late-queued callbacks; the try/catch is belt-and-
      // braces against "Object is disposed" (applyOptions on a removed chart
      // throws via window.onerror, uncatchable by React boundaries).
      if (!this.container || this.chart !== chart) return;
      try {
        chart.applyOptions({ width: this.container.clientWidth });
      } catch { /* chart was removed mid-resize — nothing to size */ }
    });
    ro.observe(el);
    this.resizeObserver = ro;
  }

  destroy(): void {
    if (this.viewportFrame != null) cancelAnimationFrame(this.viewportFrame);
    this.viewportFrame = null;
    this.viewportListeners.clear();
    this.navigationMode = "inspect";
    this.smartAnnotation = null;
    this.smartAnnotationKey = "null";
    this.smartAnnotationPrimitive = null;
    this.drawingInteraction = null;
    if (this.container) delete this.container.dataset.chartNavigation;
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch { /* already gone */ }
      this.resizeObserver = null;
    }
    if (this.crosshairFrame != null) cancelAnimationFrame(this.crosshairFrame);
    this.crosshairFrame = null;
    if (this.viewLinkFrame != null) cancelAnimationFrame(this.viewLinkFrame);
    this.viewLinkFrame = null;
    this.viewLinkHandler = null;
    this.viewLinkStatusHandler = null;
    this.pendingLinkedCursor = undefined;
    this.pendingRange = false;
    this.ownsRange = false;
    this.linkedRange = null;
    this.linkedCursor = undefined;
    this.clearViewListeners?.(); this.clearViewListeners = null;
    this.crosshairHandler = null;
    this.hoveredCandle = null;
    this.streamTip = null;
    this.candles = [];
    this.haBars = [];
    this.baselineValue = null;
    this.reachStartHandler = null;
    this.drawingEditor?.destroy(); this.drawingEditor = null;
    this.analysis?.destroy();
    if (this.chart) {
      try { this.chart.remove(); } catch { /* already removed */ }
    }
    this.chart = null;
    this.series = null;
    this.analysis = null;
    this.drawingHandler = null;
    this.overlaysRaw = [];
    this.overlayTime = null;
    this.lastPriceLine = null;
    this.overlayLines = [];
    this.markersApi = null;
    // chart.remove() disposes every series; just drop our references.
    this.structureSeries = [];
    this.structureMarkersApi = null;
    this.structureLinesRaw = [];
    this.structureMarkersRaw = [];
    this.structureSnappedTimes = [];
    this.container = null;
  }

  resize(width?: number, height?: number): void {
    if (!this.chart) return;
    const w = width ?? this.container?.clientWidth;
    if (w != null && Number.isFinite(w)) {
      try { this.chart.applyOptions({ width: w, ...(height != null && height > 0 ? { height } : {}) }); } catch { /* ignore */ }
    }
  }

  setFeedState(state: ChartEngineFeedState): void {
    // A lagging history poll may retain a newer streamed tip only while both
    // belong to the same source. Clear it before the shell reconciles candles;
    // rejecting new mismatched SSE frames cannot remove an already accepted tip.
    if (this.feedState.source !== state.source) this.streamTip = null;
    this.feedState = state;
    // Re-apply affordance immediately if data is already on screen so a feed
    // verdict flip (live→stale) takes effect without waiting for new candles.
    if (this.series && this.candles.length > 0) this.applyLivePriceAffordance();
  }

  resetDataContext(): void {
    this.setFeedState({livePriceAffordance:false,source:null});
    this.setDrawingHandler(null);
    this.setDrawingInteraction(null);
    this.setNavigationMode("inspect");
    this.setDrawings([]);
    this.setStructureLines([],[]);
    this.setSmartAnnotation(null);
    this.setOverlays([],null);
    this.linkedRange=null;
    this.linkedCursor=undefined;
    this.pendingLinkedCursor=undefined;
    this.pendingRange=false;
    this.ownsRange=false;
    this.didFit=false;
    this.setCandles([]);
    this.chart?.applyOptions({rightPriceScale:{autoScale:true}});
    this.chart?.clearCrosshairPosition();
  }

  setCandles(candles: ChartEngineCandle[], view?: { revealLatest?: boolean }): void {
    const series = this.series;
    const chart = this.chart;
    if (!series) return;

    let sanitized = sanitizeCandlestickData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    // A closed-window poll may lag a streamed forming bar. Keep that newer tip
    // until the authoritative window reaches it; never make a candle disappear.
    if (sanitized.length && this.streamTip && this.streamTip.time > sanitized[sanitized.length - 1]!.time) {
      sanitized = [...sanitized, { ...this.streamTip, time: this.streamTip.time as UTCTimestamp }];
    } else {
      this.streamTip = null;
    }
    const previous = this.candles;
    const savedRange = chart?.timeScale().getVisibleLogicalRange();
    const followingLatest = savedRange != null && savedRange.to >= previous.length - 1;
    const shift = followingLatest ? sanitized.length - previous.length : historyRangeShift(previous, sanitized);
    const updates = incrementalCandles(previous, sanitized);
    const unchanged = unchangedCandlePrefix(previous, sanitized);
    const removed = previous.length - sanitized.length;
    // v5.2 pop removes an unchanged tail without rebuilding the entire price
    // series. Large seeks use one full write, never thousands of live updates.
    const trimTail = removed > 0 && removed <= 32 && unchanged === sanitized.length;
    const bulk = updates != null && updates.length > 32;
    this.candles = sanitized;
    this.syncDisplay(unchanged);
    this.smartAnnotationPrimitive?.setData(this.smartAnnotation, this.candles);
    this.newestSeriesTime = sanitized.at(-1)?.time ?? null;
    this.applyPricePrecision();
    const reconcile = () => {
      if (trimTail) {
        series.pop(removed);
      } else if (updates === null || bulk) {
        series.setData(this.displayPoints());
      } else {
        // incrementalCandles returns a tail slice of sanitized.
        const base = sanitized.length - updates.length;
        for (let k = 0; k < updates.length; k++) series.update(this.displayPoint(base + k));
      }
      if (!this.didFit && sanitized.length > 0) {
        this.applyDefaultVisibleRange();
        this.didFit = true;
      } else if ((updates === null || bulk) && savedRange && chart && sanitized.length) {
        chart.timeScale().setVisibleLogicalRange({ from: savedRange.from + shift, to: savedRange.to + shift });
      }
      // Replay explicitly follows its cursor. Set its final range before the
      // study render; never render the old viewport then rebuild it on a jump.
      if (view?.revealLatest && sanitized.length) this.goToLatest(false);
      if (updates === null || updates.length || view?.revealLatest) this.analysis?.refresh(this.candles, unchanged, (updates === null && !trimTail) || bulk);
      if (updates === null) this.analysis?.refreshDrawings(this.candles);
    };
    if (this.analysis) this.analysis.batchViewport(reconcile);
    else reconcile();
    this.applyBaselineValue();

    // Re-anchor any structural markers onto the NEW bar set. When the fixed-size
    // window slides forward (oldest bars roll off), a marker still pointing at a
    // dropped bar makes the candlestick colorer throw "Value is null" on the
    // next repaint — so the anchors are re-snapped in the same tick as setData,
    // before the library can paint.
    if (this.structureMarkersRaw.length > 0 || this.structureSnappedTimes.length > 0) {
      this.applyStructureFromRaw(false);
    }

    this.applyLivePriceAffordance();
    if (this.hoveredCandle) this.hoveredCandle = sanitized.find((c) => c.time === this.hoveredCandle!.time) ?? null;
    this.queueLegendUpdate();

    if (this.linkedRange) this.setLinkedTimeRange(this.linkedRange);
    if (this.linkedCursor !== undefined) this.setLinkedCrosshair(this.linkedCursor);
    this.queueViewportUpdate();
  }


  setOverlays(overlays: ChartOverlay[], latestBarTime: number | null): void {
    this.overlaysRaw = overlays; this.overlayTime = latestBarTime;
    const series = this.series;
    if (!series) return;

    // Clear prior overlay lines (the "Last" price line is owned separately).
    for (const line of this.overlayLines) {
      try { series.removePriceLine(line); } catch { /* already gone */ }
    }
    this.overlayLines = [];

    const addLine = (price: number | null | undefined, o: ChartOverlay, title: string) => {
      if (price == null || !Number.isFinite(price) || price <= 0) return;
      try {
        this.overlayLines.push(
          series.createPriceLine({
            price,
            color: overlayColor(o),
            lineWidth: o.lineWidth === 1 ? 1 : 2,
            lineStyle: o.style === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
            axisLabelVisible: true,
            title,
          }),
        );
      } catch { /* ignore a single bad line */ }
    };

    for (const o of overlays) {
      if (o.type === "line") {
        addLine(o.price, o, o.label);
      } else if (o.type === "zone") {
        addLine(o.priceMin, o, `${o.label} ▽`);
        addLine(o.priceMax, o, `${o.label} △`);
      }
    }

    // Direction markers (v5 plugin) anchored to the latest bar so they stay
    // visible for currently-open positions. Detach + recreate to avoid stacking.
    try { this.markersApi?.detach(); } catch { /* already detached */ }
    this.markersApi = null;

    const markerOverlays = overlays.filter((o) => o.type === "marker" && o.marker);
    // Snap the anchor onto a bar that is ACTUALLY in the series: the caller
    // derives latestBarTime from its own candle state, but if that bar was
    // dropped by sanitization (or the states are momentarily out of step) a
    // marker on a missing bar throws "Value is null" on the next repaint.
    const anchorSec =
      latestBarTime != null
        ? snapSecToCandle(latestBarTime, this.sanitizedBarSecsAsc())
        : null;
    if (anchorSec != null && markerOverlays.length > 0) {
      const markerData: SeriesMarker<UTCTimestamp>[] = markerOverlays.map((o) => {
        const side = o.marker!.side;
        return {
          time: anchorSec as UTCTimestamp,
          position: side === "BUY" ? "belowBar" : "aboveBar",
          color: overlayColor(o),
          shape: side === "BUY" ? "arrowUp" : "arrowDown",
          text: o.label,
        };
      });
      try {
        this.markersApi = createSeriesMarkers(series, markerData);
      } catch { /* markers are decorative — never break the chart */ }
    }
  }

  setStructureLines(
    lines: ChartStructureLine[],
    markers: ChartStructureMarker[],
  ): void {
    // Keep the raw geometry so setCandles can re-snap the markers after the
    // candle window slides (see field docs above).
    this.structureLinesRaw = lines;
    this.structureMarkersRaw = markers;
    this.applyStructureFromRaw(true);
  }

  // The ascending open-times (epoch seconds) of the bars ACTUALLY in the
  // candlestick series — sanitized identically to setCandles' setData path so a
  // marker can only ever anchor to a bar that exists.
  private sanitizedBarSecsAsc(): number[] {
    return this.candles.map((c) => c.time);
  }

  // Draw (or re-draw) the stored structural overlay with every marker snapped
  // onto a real bar in the current series. `force` redraws unconditionally (a
  // new overlay arrived); otherwise the redraw is skipped when no snapped
  // anchor actually moved, so a routine candle refresh costs nothing.
  private applyStructureFromRaw(force: boolean): void {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return;
    // A focused smart explanation owns the visual structure budget. Keep raw
    // server geometry available, but do not draw competing pattern stories.
    if (this.smartAnnotation) { this.clearStructureOverlays(); return; }

    const lines = this.structureLinesRaw;
    const rawMarkers = this.structureMarkersRaw;

    const barSecs = this.sanitizedBarSecsAsc();
    const markers: ChartStructureMarker[] =
      barSecs.length === 0
        ? []
        : rawMarkers.flatMap((m) => {
            const snapped = snapSecToCandle(m.time, barSecs);
            if (snapped == null) return [];
            return [{ ...m, time: snapped }];
          });

    const snappedTimes = markers.map((m) => m.time);
    if (
      !force &&
      snappedTimes.length === this.structureSnappedTimes.length &&
      snappedTimes.every((t, i) => t === this.structureSnappedTimes[i])
    ) {
      return; // nothing moved — keep the existing draw untouched
    }
    this.structureSnappedTimes = snappedTimes;

    // Draw through the SHARED structural-overlay routine (Task #670) so the ARX
    // native chart and the Scanner panel can never draw structure differently.
    const handles = applyStructureLines(chart, series, lines, markers, {
      series: this.structureSeries,
      markersApi: this.structureMarkersApi,
    });
    this.structureSeries = handles.series;
    this.structureMarkersApi = handles.markersApi;
  }

  private clearStructureOverlays(): void {
    clearStructureLines(this.chart, {
      series: this.structureSeries,
      markersApi: this.structureMarkersApi,
    });
    this.structureSeries = [];
    this.structureMarkersApi = null;
  }

  resetScale(): void {
    if (!this.chart || !this.series) return;
    this.takeRangeOwnership();
    if (this.candles.length === 0) {
      try { this.chart.timeScale().fitContent(); } catch { /* ignore */ }
      return;
    }
    this.chart.applyOptions({ rightPriceScale: { autoScale: true } });
    this.applyDefaultVisibleRange();
  }

  goToLatest(animated = true): void {
    this.takeRangeOwnership();
    const scale = this.chart?.timeScale();
    if (animated) scale?.scrollToRealTime();
    else scale?.scrollToPosition(scale.options().rightOffset, false);
  }
  panBy(fraction: number): boolean {
    if (!this.chart) return false;
    const range = panChartWindow(this.chart.timeScale().getVisibleLogicalRange(), fraction, this.candles.length);
    if (!range) return false;
    this.takeRangeOwnership();
    this.chart.timeScale().setVisibleLogicalRange(range);
    return true;
  }
  zoomBy(factor: number): boolean {
    if (!this.chart) return false;
    const range = zoomChartWindow(this.chart.timeScale().getVisibleLogicalRange(), factor, this.candles.length);
    if (!range) return false;
    this.takeRangeOwnership();
    this.chart.timeScale().setVisibleLogicalRange(range);
    return true;
  }
  getVisibleCandles(): ChartEngineCandle[] {
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to < range.from) return [];
    return this.candles.slice(Math.max(0, Math.ceil(range.from)), Math.max(0, Math.floor(range.to) + 1)).map(candle => ({...candle}));
  }
  subscribeViewport(listener: () => void): () => void {
    this.viewportListeners.add(listener);
    return () => { this.viewportListeners.delete(listener); };
  }
  private queueViewportUpdate(): void {
    if (this.viewportFrame != null || !this.viewportListeners.size) return;
    this.viewportFrame = requestAnimationFrame(() => {
      this.viewportFrame = null;
      for (const listener of this.viewportListeners) listener();
    });
  }
  setNavigationMode(mode: "inspect" | "pan"): void {
    if (mode === this.navigationMode) return;
    this.navigationMode = mode;
    this.drawingEditor?.configure(mode === "pan" ? null : this.drawingInteraction);
    this.applyDrawingPlacement();
    if (this.container) this.container.dataset.chartNavigation = mode;
  }
  setSmartAnnotation(annotation: SmartChartAnnotation | null): void {
    const key=JSON.stringify(annotation);
    if(key===this.smartAnnotationKey)return;
    this.smartAnnotationKey=key;
    this.smartAnnotation=annotation;
    if (this.series && !this.smartAnnotationPrimitive && annotation) {
      this.smartAnnotationPrimitive=new SmartChartAnnotationPrimitive();
      this.series.attachPrimitive(this.smartAnnotationPrimitive);
    }
    this.smartAnnotationPrimitive?.setData(annotation,this.candles);
    this.applyStructureFromRaw(true);
  }
  fitHistory(): void {
    this.takeRangeOwnership();
    this.chart?.applyOptions({ rightPriceScale: { autoScale: true } });
    this.chart?.timeScale().fitContent();
  }
  setScaleMode(mode: ChartScaleMode): void {
    const modes = {linear:PriceScaleMode.Normal,log:PriceScaleMode.Logarithmic,percent:PriceScaleMode.Percentage,indexed:PriceScaleMode.IndexedTo100};
    this.chart?.applyOptions({ rightPriceScale: { mode: modes[mode] } });
  }
  setPriceScaleInverted(invertScale: boolean): void { this.chart?.applyOptions({rightPriceScale:{invertScale}}); }
  /** Relabel axis ticks and the crosshair time. Re-applying the same formatter
   * references clears the library's tick-label cache; data, drawings, links and
   * goToTime are untouched and stay UTC seconds. */
  setDisplayTimeZone(zone: ChartTimeZone): void {
    if (zone === this.displayZone) return;
    this.displayZone = zone;
    this.chart?.applyOptions({ timeScale: { tickMarkFormatter: this.tickLabel }, localization: { timeFormatter: this.timeLabel } });
  }
  goToTime(time: number): boolean {
    if (!this.chart || !Number.isFinite(time) || !this.candles.length || time < this.candles[0]!.time || time > this.candles.at(-1)!.time) return false;
    this.takeRangeOwnership();
    let lo = 0, hi = this.candles.length - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.candles[mid]!.time < time) lo = mid + 1; else hi = mid; }
    const previous = this.chart.timeScale().getVisibleLogicalRange();
    const span = Math.max(20, previous ? previous.to - previous.from : DEFAULT_VISIBLE_DESKTOP);
    this.chart.timeScale().setVisibleLogicalRange({from:lo-span/2,to:lo+span/2});
    return true;
  }
  showRecentRange(seconds: number): {complete:boolean} | null {
    const last = this.candles.at(-1), first = this.candles[0];
    if (!this.chart || !first || !last || !Number.isFinite(seconds) || seconds <= 0) return null;
    this.takeRangeOwnership();
    const start = last.time - seconds;
    let lo = 0, hi = this.candles.length - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.candles[mid]!.time < start) lo = mid + 1; else hi = mid; }
    this.chart.timeScale().setVisibleLogicalRange({from:lo,to:this.candles.length - 1 + 3});
    return {complete:first.time <= start};
  }
  getStudyValues(time: number) { return this.analysis?.inspect(time) ?? []; }
  setCrosshairHandler(handler: ((candle: ChartEngineCandle | null) => void) | null): void { this.crosshairHandler = handler; }

  setViewLinkHandler(handler: ((event: ChartViewEvent) => void) | null): void { this.viewLinkHandler = handler; }
  setViewLinkStatusHandler(handler: ((message: string) => void) | null): void { this.viewLinkStatusHandler = handler; }

  setLinkedCrosshair(time: number | null): void {
    if (time !== null && (!Number.isFinite(time) || time <= 0)) return;
    this.linkedCursor = time;
    this.pendingLinkedCursor = undefined;
    this.hoveredCandle = time === null ? null : candleAtLinkedTime(this.candles, time, this.intervalSeconds);
    if (this.chart && this.series && this.hoveredCandle) {
      // Each view uses its OWN candle close, not another instrument's price.
      this.chart.setCrosshairPosition(this.hoveredCandle.close, this.hoveredCandle.time as UTCTimestamp, this.series);
    } else this.chart?.clearCrosshairPosition();
    this.queueLegendUpdate();
  }

  setLinkedTimeRange(range: ChartTimeRange | null): void {
    if (range && !validTimeRange(range)) return;
    this.ownsRange = false;
    this.pendingRange = false;
    this.linkedRange = range ? { ...range } : null;
    if (!range) { this.viewLinkStatusHandler?.(""); return; }
    const first = this.candles[0], last = this.candles.at(-1);
    if (!this.chart || !first || !last) { this.viewLinkStatusHandler?.("Linked time range is waiting for candles."); return; }
    let lo = 0, hi = this.candles.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.candles[mid]!.time < range.from) lo = mid + 1; else hi = mid; }
    let from = lo;
    if (lo > 0 && range.from < this.candles[lo - 1]!.time + this.intervalSeconds) from--;
    lo = 0; hi = this.candles.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.candles[mid]!.time <= range.to) lo = mid + 1; else hi = mid; }
    const to = lo - 1;
    if (from > to || from >= this.candles.length || to < 0) {
      this.viewLinkStatusHandler?.("Linked time range is outside loaded history. This view has not moved.");
      return;
    }
    // Map UTC time to this instrument's real bars, never copy logical indices
    // between intervals or create candles across a closed-market gap.
    const current = this.chart.timeScale().getVisibleLogicalRange();
    if (!current || Math.abs(current.from-from) > 1e-6 || Math.abs(current.to-to) > 1e-6) {
      this.chart.timeScale().setVisibleLogicalRange({from,to});
    }
    this.viewLinkStatusHandler?.(range.from < first.time || range.to >= last.time + this.intervalSeconds
      ? "Linked time range is clipped to this view's loaded history." : "");
  }

  private takeRangeOwnership(): void {
    this.ownsRange = true;
    this.linkedRange = null;
    this.viewLinkStatusHandler?.("");
  }

  private queueViewLinkUpdate(): void {
    if (this.viewLinkFrame != null || !this.viewLinkHandler) return;
    this.viewLinkFrame = requestAnimationFrame(() => {
      this.viewLinkFrame = null;
      const cursor = this.pendingLinkedCursor;
      this.pendingLinkedCursor = undefined;
      if (cursor !== undefined) this.viewLinkHandler?.({kind:"crosshair",time:cursor});
      if (this.pendingRange && this.ownsRange) {
        this.pendingRange = false;
        const range = this.chart?.timeScale().getVisibleRange();
        if (range && typeof range.from === "number" && typeof range.to === "number" && validTimeRange(range as ChartTimeRange)) {
          this.viewLinkHandler?.({kind:"range",range:{from:range.from,to:range.to}});
        }
      }
    });
  }

  /** Series point for this.candles[index] in the current style. Close-only
   * styles plot canonical closes; Heikin Ashi reads the display cache. */
  private displayPoint(index: number) {
    const candle = this.candles[index]!, time = candle.time as UTCTimestamp, mode = this.displayMode;
    if (mode === "ohlc") return {...candle,time};
    if (mode === "close") return {time,value:candle.close};
    if (mode === "heikinAshi") return {...this.haBars[index]!,time};
    return {...hollowPoint(candle, index > 0 ? this.candles[index - 1]!.close : null),time};
  }
  private displayPoints() { return this.candles.map((_, i) => this.displayPoint(i)); }
  /** Keep the Heikin Ashi cache equal to heikinAshi(this.candles) from `from`. */
  private syncDisplay(from: number): void {
    if (this.displayMode === "heikinAshi") heikinAshiSuffix(this.candles, this.haBars, from);
    else if (this.haBars.length) this.haBars = [];
  }
  /** Baseline base = first loaded close; one applyOptions only when it changes
   * (prepend, replay seek, reset, or the live window rolling forward). */
  private applyBaselineValue(): void {
    const series = this.series, first = this.candles[0];
    if (this.style !== "baseline" || !series || !first || first.close === this.baselineValue) return;
    this.baselineValue = first.close;
    series.applyOptions({baseValue:{type:"price",price:first.close}});
  }
  /** Transformed display bar at this time (Heikin Ashi only); null in other
   * styles. Legend text only; never used for studies, drawings or orders. */
  getDisplayCandle(time: number): ChartEngineCandle | null {
    if (this.displayMode !== "heikinAshi") return null;
    const bar = this.haBars[candleIndex(this.candles, time)];
    return bar && bar.time === time ? {...bar} : null;
  }

  setChartStyle(style: ChartStyle): void {
    const chart = this.chart, previous = this.series;
    if (!chart || !previous || this.style === style) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    this.markersApi?.detach(); this.markersApi = null;
    this.clearStructureOverlays();
    const options = {priceLineVisible:false,lastValueVisible:false};
    const firstClose = this.candles[0]?.close ?? null;
    const next: PriceSeries = style === "line"
      ? chart.addSeries(LineSeries, {...options,color:"#38bdf8",lineWidth:2})
      : style === "area"
      ? chart.addSeries(AreaSeries, {...options,lineColor:"#38bdf8",topColor:"rgba(56, 189, 248, 0.28)",bottomColor:"rgba(56, 189, 248, 0.02)",lineWidth:2})
      : style === "baseline"
      ? chart.addSeries(BaselineSeries, {...options,baseValue:{type:"price",price:firstClose ?? 0},lineWidth:2,
          topLineColor:"#10b981",topFillColor1:"rgba(16, 185, 129, 0.28)",topFillColor2:"rgba(16, 185, 129, 0.05)",
          bottomLineColor:"#ef4444",bottomFillColor1:"rgba(239, 68, 68, 0.05)",bottomFillColor2:"rgba(239, 68, 68, 0.28)"})
      : style === "bars"
      ? chart.addSeries(BarSeries, {...options,upColor:"#10b981",downColor:"#ef4444"})
      : style === "hollow"
      ? chart.addSeries(CandlestickSeries, {...options,upColor:"#10b981",downColor:"#ef4444",borderUpColor:"#10b981",borderDownColor:"#ef4444",wickUpColor:"#10b981",wickDownColor:"#ef4444",borderVisible:true})
      : chart.addSeries(CandlestickSeries, {...options,upColor:"#10b981",downColor:"#ef4444",wickUpColor:"#10b981",wickDownColor:"#ef4444",borderVisible:false});
    this.style = style; this.displayMode = displayModeOf(style); this.series = next;
    this.baselineValue = style === "baseline" ? firstClose : null;
    this.syncDisplay(0);
    next.setData(this.displayPoints());
    this.analysis?.replacePriceSeries(next, this.candles);
    if (this.smartAnnotationPrimitive) {
      previous.detachPrimitive(this.smartAnnotationPrimitive);
      next.attachPrimitive(this.smartAnnotationPrimitive);
      this.smartAnnotationPrimitive.setData(this.smartAnnotation,this.candles);
    }
    chart.removeSeries(previous);
    this.lastPriceLine = null; this.overlayLines = []; this.precision = -1;
    this.applyPricePrecision(); this.applyLivePriceAffordance();
    this.setOverlays(this.overlaysRaw, this.overlayTime);
    this.applyStructureFromRaw(true);
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    if (this.linkedCursor !== undefined) this.setLinkedCrosshair(this.linkedCursor);
    // Refresh the legend in the next frame without pointer movement, so the
    // Heikin Ashi suffix appears or disappears with the style.
    this.queueLegendUpdate();
  }
  setStudies(studies: ChartStudy[]): void { this.analysis?.setStudies(studies, this.candles); }
  setDrawings(drawings: ChartDrawing[]): void { this.drawingEditor?.setDrawings(drawings); this.analysis?.setDrawings(drawings, this.candles); }
  setDrawingInteraction(config: DrawingInteraction | null): void {
    this.drawingInteraction = config;
    this.drawingEditor?.configure(this.navigationMode === "pan" ? null : config);
  }
  setDrawingHandler(handler: ((anchor: ChartAnchor) => void) | null): void {
    this.drawingHandler = handler;
    this.applyDrawingPlacement();
  }
  private applyDrawingPlacement(): void {
    const handler = this.navigationMode === "pan" ? null : this.drawingHandler;
    this.drawingEditor?.setPlacement(handler);
    this.chart?.applyOptions({handleScroll:!handler});
    if (this.container) this.container.style.cursor = this.navigationMode === "pan" ? "grab" : handler ? "crosshair" : "";
  }
  exportImage(): string | null { this.analysis?.flushPending(); return this.chart?.takeScreenshot().toDataURL("image/png") ?? null; }

  priceToCoordinate(price: number): number | null {
    const s = this.series;
    if (!s) return null;
    try {
      const y = s.priceToCoordinate(price);
      return y != null && Number.isFinite(y) ? y : null;
    } catch {
      return null;
    }
  }

  updateActiveCandle(candle: ChartEngineCandle): void {
    const series = this.series;
    if (!series) return;
    // Defensive out-of-order guard: lightweight-charts' series.update throws if
    // given a time older than the newest point. Drop any tip whose time is
    // behind the newest bar/tip already on screen so a late or reordered frame
    // can never crash the chart or rewind a bar. An equal time updates the
    // current bar in place (merge); a greater time appends a new bar.
    if (
      !Number.isFinite(candle.time) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      candle.time <= 0 || candle.high < Math.max(candle.open, candle.close, candle.low) ||
      candle.low > Math.min(candle.open, candle.close, candle.high) ||
      (this.newestSeriesTime != null && candle.time < this.newestSeriesTime)
    ) {
      return;
    }
    try {
      const changedIndex = this.candles.at(-1)?.time === candle.time ? this.candles.length - 1 : this.candles.length;
      const time = candle.time as UTCTimestamp, mode = this.displayMode;
      // O(1): one display bar from the previous display/canonical bar.
      const ha = mode === "heikinAshi" ? heikinAshiBar(candle, changedIndex > 0 ? this.haBars[changedIndex - 1] ?? null : null) : null;
      series.update(mode === "ohlc" ? {...candle,time}
        : mode === "close" ? {time,value:candle.close}
        : ha ? {...ha,time}
        : {...hollowPoint(candle, changedIndex > 0 ? this.candles[changedIndex - 1]!.close : null),time});
      this.newestSeriesTime = candle.time;
      this.streamTip = { ...candle };
      if (this.hoveredCandle?.time === candle.time) this.hoveredCandle = { ...candle };
      if (this.candles.at(-1)?.time === candle.time) this.candles[this.candles.length - 1] = { ...candle };
      else this.candles.push({ ...candle });
      if (ha) { this.haBars.length = changedIndex; this.haBars.push(ha); }
      if (changedIndex === 0) this.applyBaselineValue();
      this.analysis?.refreshLater(this.candles, changedIndex);
      this.queueLegendUpdate();
      if (this.lastPriceLine && this.feedState.livePriceAffordance) this.lastPriceLine.applyOptions({ price: candle.close });
    } catch { /* ignore a bad streaming update */ }
  }

  setSymbol(symbol: string): void {
    this.symbol = symbol;
    this.applyPricePrecision();
    // The shell resets context-owned data before changing this identifier;
    // lightweight-charts itself has no instrument concept.
  }

  setTimeframe(timeframe: string): void {
    const intervals: Record<string, number> = {M1:60,M5:300,M15:900,M30:1800,H1:3600,H4:14400,D1:86400};
    this.intervalSeconds = intervals[timeframe] ?? 0;
  }

  setReachStartHandler(handler: (() => void) | null, thresholdBars?: number): void {
    this.reachStartHandler = handler;
    if (thresholdBars != null && Number.isFinite(thresholdBars) && thresholdBars >= 0) {
      this.reachStartThresholdBars = thresholdBars;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private applyLivePriceAffordance(): void {
    const series = this.series;
    if (!series) return;
    const live = this.feedState.livePriceAffordance;

    // Suppress the candlestick last-value / price-line label unless the feed is
    // genuinely LIVE — a frozen, delayed or composite feed must never imply a
    // live last price (shared honesty rule). A Heikin Ashi series' own label
    // would show the averaged close, so it stays hidden; the dashed "Last"
    // line below always carries the canonical last close.
    const seriesLabel = live && this.displayMode !== "heikinAshi";
    series.applyOptions({ priceLineVisible: seriesLabel, lastValueVisible: seriesLabel });

    const last = this.candles.at(-1);
    if (!live || !last) {
      if (this.lastPriceLine) series.removePriceLine(this.lastPriceLine);
      this.lastPriceLine = null;
    } else if (this.lastPriceLine) {
      this.lastPriceLine.applyOptions({ price: last.close });
    } else {
      this.lastPriceLine = series.createPriceLine({
        price: last.close, color: "#60a5fa", lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Last",
      });
    }
  }

  private queueLegendUpdate(): void {
    if (this.crosshairFrame != null || !this.crosshairHandler) return;
    this.crosshairFrame = requestAnimationFrame(() => {
      this.crosshairFrame = null;
      this.crosshairHandler?.(this.linkedCursor !== undefined ? this.hoveredCandle : this.hoveredCandle ?? this.candles.at(-1) ?? null);
    });
  }

  private applyPricePrecision(): void {
    if (!this.candles.length || !this.series) return;
    const precision = candleDisplayPrecision(this.candles, this.symbol);
    if (precision === this.precision) return;
    this.precision = precision;
    this.series.applyOptions({ priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
  }

  private applyDefaultVisibleRange(): void {
    const chart = this.chart;
    if (!chart) return;
    const times = this.candles
      .map((c) => c.time)
      .filter((t) => Number.isFinite(t));
    if (times.length === 0) {
      try { chart.timeScale().fitContent(); } catch { /* ignore */ }
      return;
    }
    const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
    const defaultVisible = isMobile ? this.visibleMobile : this.visibleDesktop;
    try {
      if (times.length <= defaultVisible) {
        chart.timeScale().fitContent();
      } else {
        chart.timeScale().setVisibleRange({
          from: times[times.length - defaultVisible]! as UTCTimestamp,
          to: times[times.length - 1]! as UTCTimestamp,
        });
      }
    } catch { /* ignore */ }
  }
}
