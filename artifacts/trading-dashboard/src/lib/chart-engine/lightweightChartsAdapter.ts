import {
  createChart,
  CandlestickSeries,
  BarSeries,
  LineSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  type UTCTimestamp,
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
import { candleDisplayPrecision, incrementalCandles, historyRangeShift } from "./candleReconciliation";
import { ChartAnalysisRenderer } from "./chartAnalysisRenderer";
import type { ChartStudy } from "./chartStudies";
import type { ChartAnchor, ChartDrawing, ChartStyle } from "./chartWorkspace";
import { applyStructureLines, clearStructureLines } from "./structureLines";


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
  private series: ISeriesApi<"Candlestick" | "Bar" | "Line"> | null = null;
  private style: ChartStyle = "candles";
  private analysis: ChartAnalysisRenderer | null = null;
  private drawingCleanup: (() => void) | null = null;
  private drawingHandler: ((anchor: ChartAnchor) => void) | null = null;
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
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
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
      if (event.point && event.paneIndex === 0 && typeof time === "number") while (lo <= hi) {
        const mid = (lo + hi) >>> 1, candle = this.candles[mid]!;
        if (candle.time === time) { this.hoveredCandle = candle; break; }
        if (candle.time < time) lo = mid + 1; else hi = mid - 1;
      }
      this.queueLegendUpdate();
    });

    // Handle drawing anchors directly: the library intentionally consumes the
    // second rapid click even when it is too far away to be a double-click.
    // Pointer coordinates keep fast two-anchor tools and touch taps reliable.
    let down: {x:number;y:number} | null = null;
    const pointerDown = (event: PointerEvent) => { down = event.button === 0 ? {x:event.clientX,y:event.clientY} : null; };
    const pointerUp = (event: PointerEvent) => {
      const start = down; down = null;
      if (!start || !this.drawingHandler || Math.hypot(event.clientX-start.x,event.clientY-start.y) > 5) return;
      if (!(event.target instanceof HTMLCanvasElement)) return;
      const rect = el.getBoundingClientRect(), x = event.clientX-rect.left, y = event.clientY-rect.top;
      if (x < 0 || x > chart.timeScale().width() || y < 0 || y > chart.panes()[0]!.getHeight()) return;
      const time = chart.timeScale().coordinateToTime(x), price = this.series?.coordinateToPrice(y);
      if (typeof time === "number" && price != null && Number.isFinite(price) && price > 0 && this.candles.some(c => c.time === time)) this.drawingHandler({time,price});
    };
    el.addEventListener("pointerdown",pointerDown); el.addEventListener("pointerup",pointerUp);
    this.drawingCleanup = () => {el.removeEventListener("pointerdown",pointerDown);el.removeEventListener("pointerup",pointerUp);};

    // Deep-history scroll-back: when the user pans so the left edge approaches the
    // OLDEST loaded bar (logical index near 0), ask the Shell to load more. The
    // handler guards its own concurrency; this only signals intent. View-only.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!this.reachStartHandler || !range) return;
      if (range.from <= this.reachStartThresholdBars) {
        this.reachStartHandler();
      }
    });

    this.chart = chart;
    this.series = series;
    this.style = "candles";
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
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch { /* already gone */ }
      this.resizeObserver = null;
    }
    if (this.crosshairFrame != null) cancelAnimationFrame(this.crosshairFrame);
    this.crosshairFrame = null;
    this.crosshairHandler = null;
    this.hoveredCandle = null;
    this.streamTip = null;
    this.candles = [];
    this.reachStartHandler = null;
    if (this.chart) {
      try { this.chart.remove(); } catch { /* already removed */ }
    }
    this.chart = null;
    this.series = null;
    this.analysis = null;
    this.drawingHandler = null;
    this.drawingCleanup?.(); this.drawingCleanup = null;
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
    this.feedState = state;
    // Re-apply affordance immediately if data is already on screen so a feed
    // verdict flip (live→stale) takes effect without waiting for new candles.
    if (this.series && this.candles.length > 0) this.applyLivePriceAffordance();
  }

  setCandles(candles: ChartEngineCandle[]): void {
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
    this.candles = sanitized;
    this.newestSeriesTime = sanitized.at(-1)?.time ?? null;
    this.applyPricePrecision();
    if (updates === null) {
      series.setData(sanitized.map(c => this.priceData(c)));
    } else {
      for (const candle of updates) series.update(this.priceData(candle));
    }

    if (updates === null || updates.length) this.analysis?.refresh(this.candles, updates === null ? 0 : Math.max(0, previous.length - 1), updates === null);
    if (updates === null) this.analysis?.refreshDrawings(this.candles);

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

    if (!this.didFit && sanitized.length > 0) {
      this.applyDefaultVisibleRange();
      this.didFit = true;
    } else if (updates === null && savedRange && chart && sanitized.length) {
      chart.timeScale().setVisibleLogicalRange({ from: savedRange.from + shift, to: savedRange.to + shift });
    }
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
    if (this.candles.length === 0) {
      try { this.chart.timeScale().fitContent(); } catch { /* ignore */ }
      return;
    }
    this.chart.applyOptions({ rightPriceScale: { autoScale: true } });
    this.applyDefaultVisibleRange();
  }

  goToLatest(): void { this.chart?.timeScale().scrollToRealTime(); }
  fitHistory(): void {
    this.chart?.applyOptions({ rightPriceScale: { autoScale: true } });
    this.chart?.timeScale().fitContent();
  }
  setScaleMode(mode: "linear" | "log"): void {
    this.chart?.applyOptions({ rightPriceScale: { mode: mode === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal } });
  }
  setCrosshairHandler(handler: ((candle: ChartEngineCandle | null) => void) | null): void { this.crosshairHandler = handler; }

  private priceData(candle: ChartEngineCandle) {
    return this.style === "line" ? {time:candle.time as UTCTimestamp,value:candle.close} : {...candle,time:candle.time as UTCTimestamp};
  }

  setChartStyle(style: ChartStyle): void {
    const chart = this.chart, previous = this.series;
    if (!chart || !previous || this.style === style) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    this.markersApi?.detach(); this.markersApi = null;
    this.clearStructureOverlays();
    const options = {priceLineVisible:false,lastValueVisible:false};
    const next: ISeriesApi<"Candlestick" | "Bar" | "Line"> = style === "line"
      ? chart.addSeries(LineSeries, {...options,color:"#38bdf8",lineWidth:2})
      : style === "bars"
      ? chart.addSeries(BarSeries, {...options,upColor:"#10b981",downColor:"#ef4444"})
      : chart.addSeries(CandlestickSeries, {...options,upColor:"#10b981",downColor:"#ef4444",wickUpColor:"#10b981",wickDownColor:"#ef4444",borderVisible:false});
    this.style = style; this.series = next;
    next.setData(this.candles.map(c => this.priceData(c)));
    this.analysis?.replacePriceSeries(next, this.candles);
    chart.removeSeries(previous);
    this.lastPriceLine = null; this.overlayLines = []; this.precision = -1;
    this.applyPricePrecision(); this.applyLivePriceAffordance();
    this.setOverlays(this.overlaysRaw, this.overlayTime);
    this.applyStructureFromRaw(true);
    if (range) chart.timeScale().setVisibleLogicalRange(range);
  }
  setStudies(studies: ChartStudy[]): void { this.analysis?.setStudies(studies, this.candles); }
  setDrawings(drawings: ChartDrawing[]): void { this.analysis?.setDrawings(drawings, this.candles); }
  setDrawingHandler(handler: ((anchor: ChartAnchor) => void) | null): void {
    this.drawingHandler = handler;
    this.chart?.applyOptions({handleScroll:!handler});
    if (this.container) this.container.style.cursor = handler ? "crosshair" : "";
  }
  exportImage(): string | null { return this.chart?.takeScreenshot().toDataURL("image/png") ?? null; }

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
      series.update(this.priceData(candle));
      const changedIndex = this.candles.at(-1)?.time === candle.time ? this.candles.length - 1 : this.candles.length;
      this.newestSeriesTime = candle.time;
      this.streamTip = { ...candle };
      if (this.hoveredCandle?.time === candle.time) this.hoveredCandle = { ...candle };
      this.queueLegendUpdate();
      if (this.candles.at(-1)?.time === candle.time) this.candles[this.candles.length - 1] = { ...candle };
      else this.candles.push({ ...candle });
      this.analysis?.refresh(this.candles, changedIndex, false);
      if (this.lastPriceLine && this.feedState.livePriceAffordance) this.lastPriceLine.applyOptions({ price: candle.close });
    } catch { /* ignore a bad streaming update */ }
  }

  setSymbol(symbol: string): void {
    this.symbol = symbol;
    this.applyPricePrecision();
    // Informational only. lightweight-charts has no instrument concept; the
    // Shell rebuilds the engine (init) on a symbol change so overlays/levels
    // never bleed across instruments.
  }

  setTimeframe(_timeframe: string): void {
    // Informational only — see setSymbol. The Shell rebuilds on timeframe change.
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
    // live last price (shared honesty rule).
    series.applyOptions({ priceLineVisible: live, lastValueVisible: live });

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
      this.crosshairHandler?.(this.hoveredCandle ?? this.candles.at(-1) ?? null);
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
