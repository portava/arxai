import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  ColorType,
  CrosshairMode,
  LineStyle,
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
import { applyStructureLines, clearStructureLines } from "./structureLines";

// Crosshair move handler throttle (ms). The chart fires a CrosshairMove event on
// every pixel; throttling prevents thrashing on slow machines (≈60fps).
const CROSSHAIR_THROTTLE_MS = 16;

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
  // Staged for later tasks — lightweight-charts has no built-in drawing tools
  // or draggable order handles, so we advertise them as unsupported today.
  drawingTools: false,
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
  private series: ISeriesApi<"Candlestick"> | null = null;
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
  private crosshairThrottle: number | null = null;

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
        lockVisibleTimeRangeOnResize: false,
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

    // Throttled crosshair subscription (≈60fps) to avoid thrashing.
    chart.subscribeCrosshairMove(() => {
      if (this.crosshairThrottle != null) return;
      this.crosshairThrottle = window.setTimeout(() => {
        this.crosshairThrottle = null;
      }, CROSSHAIR_THROTTLE_MS);
    });

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
    if (this.crosshairThrottle != null) {
      clearTimeout(this.crosshairThrottle);
      this.crosshairThrottle = null;
    }
    if (this.chart) {
      try { this.chart.remove(); } catch { /* already removed */ }
    }
    this.chart = null;
    this.series = null;
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

  resize(width?: number): void {
    if (!this.chart) return;
    const w = width ?? this.container?.clientWidth;
    if (w != null && Number.isFinite(w)) {
      try { this.chart.applyOptions({ width: w }); } catch { /* ignore */ }
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

    // Detect how many bars were PREPENDED (older history loaded at the front).
    // lightweight-charts' setData preserves the visible range by bar INDEX, so a
    // prepend would shift the user's view rightward; we counter-shift the logical
    // range by the prepended count to keep the same bars on screen.
    const prevOldest = this.candles[0]?.time;
    let prependedCount = 0;
    if (prevOldest != null && candles.length > this.candles.length) {
      const idx = candles.findIndex((c) => c.time === prevOldest);
      if (idx > 0) prependedCount = idx;
    }
    const savedRange =
      prependedCount > 0 && chart
        ? chart.timeScale().getVisibleLogicalRange()
        : null;

    this.candles = candles;
    // Drop any malformed bar (missing / null / NaN OHLC) BEFORE handing data to
    // lightweight-charts: its candlestick colorer reads the bar's color data
    // during PAINT via ensureNotNull and throws "Value is null" on the next
    // repaint otherwise — uncatchable at this call site.
    const sanitized = sanitizeCandlestickData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    // The authoritative closed window resets the newest-time watermark so a
    // reconciled closed bar can cleanly supersede a prior live tip.
    this.newestSeriesTime =
      sanitized.length > 0 ? (sanitized[sanitized.length - 1]!.time as number) : null;
    series.setData(sanitized);

    // Re-anchor any structural markers onto the NEW bar set. When the fixed-size
    // window slides forward (oldest bars roll off), a marker still pointing at a
    // dropped bar makes the candlestick colorer throw "Value is null" on the
    // next repaint — so the anchors are re-snapped in the same tick as setData,
    // before the library can paint.
    if (this.structureMarkersRaw.length > 0 || this.structureSnappedTimes.length > 0) {
      this.applyStructureFromRaw(false);
    }

    this.applyLivePriceAffordance();

    if (savedRange && chart) {
      // Restore the user's view shifted by the prepended bars so the chart stays
      // put instead of jumping when older history arrives.
      try {
        chart.timeScale().setVisibleLogicalRange({
          from: savedRange.from + prependedCount,
          to: savedRange.to + prependedCount,
        });
      } catch { /* ignore — fall back to library default */ }
    } else if (!this.didFit && candles.length > 0) {
      // Smart initial visible range: on first real-data load show the most recent
      // N candles so the chart opens with readable price action, not a full-history
      // compression. After that respect the user's own zoom/pan.
      this.applyDefaultVisibleRange();
      this.didFit = true;
    }
  }

  setOverlays(overlays: ChartOverlay[], latestBarTime: number | null): void {
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
    return sanitizeCandlestickData(
      this.candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    ).map((c) => c.time);
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
    this.applyDefaultVisibleRange();
  }

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
      (this.newestSeriesTime != null && candle.time < this.newestSeriesTime)
    ) {
      return;
    }
    try {
      series.update({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
      this.newestSeriesTime = candle.time;
    } catch { /* ignore a bad streaming update */ }
  }

  setSymbol(_symbol: string): void {
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

    if (this.lastPriceLine) {
      try { series.removePriceLine(this.lastPriceLine); } catch { /* gone */ }
      this.lastPriceLine = null;
    }
    const last = this.candles[this.candles.length - 1];
    if (last && live) {
      this.lastPriceLine = series.createPriceLine({
        price: last.close,
        color: "#60a5fa",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Last",
      });
    }
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
