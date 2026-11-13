import {
  validDrawings,
  fibonacciLevels,
  type ChartDrawing,
  type DrawingTool,
  type DrawingAnchor,
} from "./drawings";
/** ARX's first-party Canvas2D renderer. No remote scripts or chart vendors.
 * The small imperative API keeps existing feed gates and overlay controllers intact.
 * All prices and times come from caller-supplied observations or labelled overlays.
 */
export type UTCTimestamp = number;
export type Time = number;
export type TickMarkType = 0 | 1 | 2 | 3 | 4;
export type TickMarkFormatter = (time: Time, type: TickMarkType, locale: string) => string | null;

export function adaptiveTimeTickCount(plotWidth: number, labelWidth = 42): number {
  const width = Number.isFinite(plotWidth) ? Math.max(0, plotWidth) : 0;
  return Math.max(1, Math.floor(width / Math.max(64, labelWidth + 12)));
}

/** Tick detail follows the viewport, even with years of offscreen history. */
export function visibleTimeTickType(times: readonly number[], range: { from: number; to: number }): TickMarkType {
  const first = times[Math.max(0, Math.min(times.length - 1, Math.ceil(range.from)))];
  const last = times[Math.max(0, Math.min(times.length - 1, Math.floor(range.to)))];
  const span = Math.max(0, (last ?? 0) - (first ?? 0));
  return span > 86400 * 365 ? 1 : span > 86400 * 3 ? 2 : span > 600 ? 3 : 4;
}

export function niceLinearPriceTicks(low: number, high: number, targetCount: number): number[] {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low || !Number.isFinite(targetCount) || targetCount < 1) return [];
  const rawStep = (high - low) / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = [1, 2, 2.5, 5, 10].reduce((best, value) =>
    Math.abs(value - normalized) < Math.abs(best - normalized) ? value : best);
  const step = factor * magnitude;
  if (!Number.isFinite(step) || step <= 0) return [];
  const firstIndex = Math.ceil(low / step);
  const lastIndex = Math.floor(high / step);
  const ticks: number[] = [];
  for (let index = firstIndex; index <= lastIndex && ticks.length < 128; index++) {
    const value = index * step;
    if (Number.isFinite(value)) ticks.push(value);
  }
  return ticks;
}
export type SeriesType = "Candlestick" | "Line" | "Histogram" | "Bar" | "Area" | "Baseline";
export const CandlestickSeries = "Candlestick" as const;
export const LineSeries = "Line" as const;
export const HistogramSeries = "Histogram" as const;
export const BarSeries = "Bar" as const;
export const AreaSeries = "Area" as const;
export const BaselineSeries = "Baseline" as const;
export const ColorType = { Solid: "solid" } as const;
export const CrosshairMode = { Normal: 0 } as const;
export const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2 } as const;
export const PriceScaleMode = { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 } as const;
type Options = Record<string, any>;
export type LogicalRange = { from: number; to: number };
export type LineSeriesPartialOptions = Options;
export type HistogramSeriesPartialOptions = Options;
export type AutoscaleInfoProvider = (original: () => unknown) => unknown;
export interface CanvasRenderingTarget2D {
  useMediaCoordinateSpace<T>(fn: (scope: { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } }) => T): T;
}
export interface IPrimitivePaneRenderer { draw(target: CanvasRenderingTarget2D): void }
export interface IPrimitivePaneView { zOrder(): "bottom" | "normal" | "top"; renderer(): IPrimitivePaneRenderer }
export interface ISeriesPrimitiveAxisView {
  coordinate(): number;
  text(): string;
  textColor(): string;
  backColor(): string;
  visible(): boolean;
}
export interface ISeriesPrimitive {
  attached?(parameter: SeriesAttachedParameter): void;
  detached?(): void;
  updateAllViews?(): void;
  paneViews?(): readonly IPrimitivePaneView[];
  priceAxisViews?(): readonly ISeriesPrimitiveAxisView[];
}
export interface SeriesAttachedParameter { chart: IChartApi; series: ISeriesApi; requestUpdate(): void }
export interface LineData<T = number> {
  time: T;
  value: number;
  color?: string;
}
export interface WhitespaceData<T = number> { time: T }
export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
type Point = CandleData | LineData | WhitespaceData;
type Range = { from: number; to: number };
export interface SeriesMarker<T = number> {
  time: T;
  position: "aboveBar" | "belowBar" | "inBar";
  color: string;
  shape: string;
  text?: string;
  size?: number;
}
export interface IPriceLine {
  options(): Options;
  applyOptions(options: Options): void;
}
export type ISeriesApi<T extends SeriesType = SeriesType> = CanvasSeries<T>;
export type IChartApi = CanvasChart;

export function validCandle(c: CandleData): boolean {
  return (
    [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.time > 0 &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  );
}
export function cleanPoints<T extends Point>(
  points: readonly T[],
  kind: SeriesType,
): T[] {
  const unique = new Map<number, T>();
  for (const p of points)
    if (
      kind === "Candlestick" || kind === "Bar"
        ? validCandle(p as CandleData)
        : Number.isFinite(p.time) &&
          p.time > 0 &&
          (!("value" in p) || Number.isFinite(p.value))
    )
      unique.set(p.time, p);
  return [...unique.values()].sort((a, b) => a.time - b.time);
}
export function zoomRange(range: Range, factor: number, anchor = 0.5): Range {
  const span = Math.max(8, Math.min(3000, (range.to - range.from) * factor));
  const pivot = range.from + (range.to - range.from) * anchor;
  return { from: pivot - span * anchor, to: pivot + span * (1 - anchor) };
}

export class CanvasSeries<T extends SeriesType> {
  data: Point[] = [];
  private seriesOptions: Options;
  lines = new Set<IPriceLine>();
  primitives = new Set<ISeriesPrimitive>();
  markerLayers = new Map<symbol, SeriesMarker[]>();
  constructor(
    readonly chart: CanvasChart,
    readonly kind: T,
    options: Options,
    readonly paneIndex = 0,
  ) {
    this.seriesOptions = {
      priceLineVisible: false,
      lastValueVisible: false,
      ...options,
    };
  }
  setData(points: Point[]) {
    this.data = cleanPoints(points, this.kind);
    this.chart.dataChanged();
  }
  update(point: Point) {
    if (!cleanPoints([point], this.kind).length) return;
    const last = this.data.at(-1);
    if (last && point.time < last.time) return;
    const following = this.chart.isFollowing();
    if (last?.time === point.time) this.data[this.data.length - 1] = point;
    else this.data.push(point);
    this.chart.dataChanged(following && last?.time !== point.time);
  }
  applyOptions(options: Options) {
    Object.assign(this.seriesOptions, options);
    this.chart.paintSoon();
  }
  createPriceLine(options: Options): IPriceLine {
    const state = { ...options };
    const line = {
      options: () => state,
      applyOptions: (next: Options) => {
        Object.assign(state, next);
        this.chart.paintSoon();
      },
    };
    this.lines.add(line);
    this.chart.paintSoon();
    return line;
  }
  removePriceLine(line: IPriceLine) {
    this.lines.delete(line);
    this.chart.paintSoon();
  }
  coordinateToPrice(y: number) {
    return this.chart.coordinateToPrice(y, this.paneIndex);
  }
  priceToCoordinate(price: number) { return this.chart.priceToCoordinate(price, this.paneIndex); }
  priceScale() { return this.chart.priceScale("right", this.paneIndex); }
  getPane() { return this.chart.panes()[this.paneIndex]; }
  options() { return this.seriesOptions; }
  setSeriesOrder(order: number) { this.seriesOptions.zOrder = order; this.chart.paintSoon(); }
  pop(count = 1) {
    const removed = this.data.splice(Math.max(0, this.data.length - count), count);
    this.chart.dataChanged();
    return removed;
  }
  priceFormatter() {
    const precision = Number(this.seriesOptions.priceFormat?.precision);
    const minimumFractionDigits = Number.isInteger(precision) ? precision : 2;
    return { format: (value: number) => value.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits: minimumFractionDigits }) };
  }
  barsInLogicalRange(range: Range) {
    const from = this.chart.logicalIndex(range.from);
    const to = this.chart.logicalIndex(range.to);
    const visible = this.data.filter((point) => {
      const index = this.chart.logicalIndex(point.time);
      return index >= range.from && index <= range.to;
    });
    const before = this.data.filter((point) => this.chart.logicalIndex(point.time) < range.from).length;
    const after = this.data.filter((point) => this.chart.logicalIndex(point.time) > range.to).length;
    return { barsBefore: before, barsAfter: after, from, to, visible };
  }
  attachPrimitive(primitive: ISeriesPrimitive) {
    this.primitives.add(primitive);
    primitive.attached?.({ chart: this.chart, series: this, requestUpdate: () => this.chart.paintSoon() });
    this.chart.paintSoon();
  }
  detachPrimitive(primitive: ISeriesPrimitive) {
    if (this.primitives.delete(primitive)) primitive.detached?.();
    this.chart.paintSoon();
  }
}

export class CanvasChart {
  readonly canvas: HTMLCanvasElement;
  readonly series: CanvasSeries<SeriesType>[] = [];
  private ctx: CanvasRenderingContext2D | null;
  private chartOptions: Options;
  private paneWeights = new Map<number, number>([[0, 3]]);
  private paneScaleOptions = new Map<string, Options>();
  private width = 0;
  private height = 0;
  private frame = 0;
  private dead = false;
  private times: number[] = [];
  private range: Range = { from: 0, to: 100 };
  private fitted = false;
  private low = 0;
  private high = 1;
  private paneRanges = new Map<number, { low: number; high: number }>();
  private hover: { x: number; y: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: { range: Range; x: number; distance: number } | null = null;
  private rangeListeners = new Set<(r: Range | null) => void>();
  private crosshairListeners = new Set<(p: any) => void>();
  private clickListeners = new Set<(p: any) => void>();
  private cleanups: (() => void)[] = [];
  private drawingsVisible = true;
  setDrawingsVisible(visible: boolean) {
    this.drawingsVisible = visible;
    this.paintSoon();
  }
  private drawingTool: DrawingTool = "cursor";
  private drawings: ChartDrawing[] = [];
  private drawingStart: DrawingAnchor | null = null;
  private undoStack: ChartDrawing[][] = [];
  private drawingListener:
    | ((drawings: ChartDrawing[], canUndo: boolean) => void)
    | null = null;
  setDrawingTool(tool: DrawingTool) {
    this.drawingTool = tool;
    this.drawingStart = null;
    this.canvas.style.cursor = tool === "cursor" ? "crosshair" : "crosshair";
    this.canvas.style.touchAction = tool === "cursor" ? "pan-y" : "none";
    this.paintSoon();
  }
  setDrawings(drawings: ChartDrawing[]) {
    this.drawings = validDrawings(drawings);
    this.undoStack = [];
    this.emitDrawings();
  }
  getDrawings() {
    return validDrawings(this.drawings);
  }
  onDrawingsChange(
    listener: ((drawings: ChartDrawing[], canUndo: boolean) => void) | null,
  ) {
    this.drawingListener = listener;
  }
  undoDrawing() {
    const prev = this.undoStack.pop();
    if (prev) {
      this.drawings = prev;
      this.drawingStart = null;
      this.emitDrawings();
    }
  }
  clearDrawings() {
    if (this.drawings.length) {
      this.rememberDrawings();
      this.drawings = [];
      this.drawingStart = null;
      this.emitDrawings();
    }
  }
  private rememberDrawings() {
    this.undoStack.push(this.getDrawings());
    if (this.undoStack.length > 50) this.undoStack.shift();
  }
  private emitDrawings() {
    this.canvas.dataset.drawingCount = String(this.drawings.length);
    this.drawingListener?.(this.getDrawings(), this.undoStack.length > 0);
    this.paintSoon();
  }
  private anchorAt(point: { x: number; y: number }): DrawingAnchor | null {
    if (!this.times.length || point.x < 0 || point.x > this.plotWidth())
      return null;
    const price = this.coordinateToPrice(point.y);
    if (price == null) return null;
    const index = this.indexAt(point.x),
      lo = Math.floor(index),
      fraction = index - lo;
    const step =
      this.times.length > 1 ? this.times.at(-1)! - this.times.at(-2)! : 60;
    const timeAt = (i: number) =>
      i < 0
        ? this.times[0] + i * step
        : i >= this.times.length
          ? this.times.at(-1)! + (i - this.times.length + 1) * step
          : this.times[i];
    return {
      time: timeAt(lo) + (timeAt(lo + 1) - timeAt(lo)) * fraction,
      price,
    };
  }
  private placeDrawing(point: { x: number; y: number }) {
    const anchor = this.anchorAt(point);
    if (!anchor || this.drawingTool === "cursor") return;
    if (this.drawingTool !== "horizontal" && !this.drawingStart) {
      this.drawingStart = anchor;
      this.paintSoon();
      return;
    }
    this.rememberDrawings();
    this.drawings.push({
      id: crypto.randomUUID(),
      tool: this.drawingTool,
      start: this.drawingStart ?? anchor,
      end: anchor,
    });
    this.drawings = this.drawings.slice(-200);
    this.drawingStart = null;
    this.emitDrawings();
  }
  constructor(
    private container: HTMLElement,
    options: Options,
  ) {
    this.chartOptions = options;
    this.canvas = document.createElement("canvas");
    this.canvas.dataset.arxChart = "canvas";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute(
      "aria-label",
      "ARX candlestick chart. Drag to pan, scroll or pinch to zoom. Arrow keys pan, plus and minus zoom, zero resets.",
    );
    this.canvas.style.cssText =
      "display:block;max-width:100%;touch-action:pan-y;outline-offset:-3px";
    this.container.append(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.applyOptions(options);
    this.on("pointerdown", (e: PointerEvent) => {
      if (this.drawingTool !== "cursor") {
        e.preventDefault();
        this.canvas.focus({ preventScroll: true });
        this.placeDrawing(this.point(e));
        return;
      }
      if (this.chartOptions.handleScroll?.pressedMouseMove === false) return;
      this.canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, this.point(e));
      this.startGesture();
    });
    this.on("pointermove", (e: PointerEvent) => {
      const p = this.point(e);
      this.hover = p;
      if (this.pointers.has(e.pointerId) && this.gesture) {
        this.pointers.set(e.pointerId, p);
        const values = [...this.pointers.values()];
        if (values.length > 1 && this.chartOptions.handleScale?.pinch !== false) {
          const distance = Math.abs(values[1].x - values[0].x);
          if (distance > 5)
            this.setRange(
              zoomRange(this.gesture.range, this.gesture.distance / distance),
            );
        } else {
          const shift =
            ((this.gesture.x - p.x) / this.plotWidth()) *
            (this.gesture.range.to - this.gesture.range.from);
          this.setRange({
            from: this.gesture.range.from + shift,
            to: this.gesture.range.to + shift,
          });
        }
      }
      for (const f of this.crosshairListeners)
        f({ point: p, time: this.times[Math.round(this.indexAt(p.x))] });
      this.paintSoon();
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      this.on(name, (e: PointerEvent) => {
        this.pointers.delete(e.pointerId);
        this.startGesture();
      });
    this.on("pointerleave", () => {
      if (!this.pointers.size) {
        this.hover = null;
        this.paintSoon();
      }
    });
    this.on("click", (event: MouseEvent) => {
      const point = this.point(event);
      const time = this.timeAtIndex(this.indexAt(point.x));
      const selected = this.series.find((series) => series.kind === "Candlestick");
      const seriesData = new Map<CanvasSeries<SeriesType>, Point>();
      for (const series of this.series) {
        const row = series.data.find((item) => item.time === time);
        if (row) seriesData.set(series, row);
      }
      for (const listener of this.clickListeners) {
        listener({
          time,
          point,
          seriesData,
          hoveredSeries: selected,
          hoveredObjectId: undefined,
          sourceEvent: event,
        });
      }
    });
    this.on(
      "wheel",
      (e: WheelEvent) => {
        if (this.chartOptions.handleScale?.mouseWheel === false) return;
        e.preventDefault();
        const p = this.point(e);
        this.setRange(
          zoomRange(
            this.range,
            Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.003))),
            Math.max(0, Math.min(1, p.x / this.plotWidth())),
          ),
        );
      },
      { passive: false },
    );
    this.on("dblclick", () => this.fitContent());
    this.on("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.drawingStart = null;
        this.paintSoon();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        this.undoDrawing();
        return;
      }
      if (
        this.drawingTool !== "cursor" &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"].includes(
          e.key,
        )
      ) {
        e.preventDefault();
        const p = this.hover ?? {
          x: this.plotWidth() / 2,
          y: this.plotHeight() / 2,
        };
        if (e.key === "Enter") this.placeDrawing(p);
        else
          this.hover = {
            x: Math.max(
              0,
              Math.min(
                this.plotWidth(),
                p.x +
                  (e.key === "ArrowRight"
                    ? 10
                    : e.key === "ArrowLeft"
                      ? -10
                      : 0),
              ),
            ),
            y: Math.max(
              0,
              Math.min(
                this.plotHeight(),
                p.y +
                  (e.key === "ArrowDown" ? 10 : e.key === "ArrowUp" ? -10 : 0),
              ),
            ),
          };
        this.paintSoon();
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "+", "=", "-", "0"].includes(e.key))
        return;
      e.preventDefault();
      if (e.key === "0") this.fitContent();
      else if (e.key.startsWith("Arrow")) {
        const shift =
          (this.range.to - this.range.from) *
          0.1 *
          (e.key === "ArrowLeft" ? -1 : 1);
        this.setRange({
          from: this.range.from + shift,
          to: this.range.to + shift,
        });
      } else this.setRange(zoomRange(this.range, e.key === "-" ? 1.2 : 0.8));
    });
    const observer = new MutationObserver(() => this.paintSoon());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    this.cleanups.push(() => observer.disconnect());
  }
  private on(name: string, fn: any, options?: AddEventListenerOptions) {
    this.canvas.addEventListener(name, fn, options);
    this.cleanups.push(() =>
      this.canvas.removeEventListener(name, fn, options),
    );
  }
  private point(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private startGesture() {
    const p = [...this.pointers.values()];
    this.gesture = p.length
      ? {
          range: { ...this.range },
          x: p[0].x,
          distance: p.length > 1 ? Math.max(5, Math.abs(p[1].x - p[0].x)) : 1,
        }
      : null;
  }
  private drawingX(time: number) {
    if (!this.times.length) return 0;
    const step =
      this.times.length > 1 ? this.times.at(-1)! - this.times.at(-2)! : 60;
    const index =
      time < this.times[0]
        ? (time - this.times[0]) / step
        : time > this.times.at(-1)!
          ? this.times.length - 1 + (time - this.times.at(-1)!) / step
          : this.indexForTime(time);
    return this.x(index);
  }
  private plotWidth() {
    return Math.max(1, this.width - 82);
  }
  private plotHeight() {
    return Math.max(1, this.height - 24);
  }
  private indexAt(x: number) {
    return (
      this.range.from +
      (x / this.plotWidth()) * (this.range.to - this.range.from)
    );
  }
  private x(index: number) {
    return (
      ((index - this.range.from) / (this.range.to - this.range.from)) *
      this.plotWidth()
    );
  }
  private indexForTime(time: number) {
    let lo = 0,
      hi = this.times.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] === time) return mid;
      if (this.times[mid] < time) lo = mid + 1;
      else hi = mid - 1;
    }
    if (lo === 0) return 0;
    if (lo >= this.times.length) return this.times.length - 1;
    return (
      lo -
      1 +
      (time - this.times[lo - 1]) / (this.times[lo] - this.times[lo - 1])
    );
  }
  logicalIndex(time: number) { return this.indexForTime(time); }
  private logicalIndexAtTime(time: number) {
    if (!this.times.length) return 0;
    const step = this.times.length > 1 ? this.times.at(-1)! - this.times.at(-2)! : 60;
    if (time < this.times[0]!) return (time - this.times[0]!) / step;
    if (time > this.times.at(-1)!) return this.times.length - 1 + (time - this.times.at(-1)!) / step;
    return this.indexForTime(time);
  }
  private setRange(range: Range) {
    const span = Math.max(8, range.to - range.from),
      max = Math.max(this.times.length + span * 0.8, span);
    const from = Math.max(-span * 0.8, Math.min(range.from, max - span));
    this.range = { from, to: from + span };
    this.fitted = true;
    this.updateScale();
    for (const fn of this.rangeListeners) fn({ ...this.range });
    this.paintSoon();
  }
  isFollowing() {
    return this.range.to >= this.times.length - 2;
  }
  dataChanged(advance = false) {
    const oldCount = this.times.length;
    const candleTimes = this.series
      .filter((s) => s.kind === "Candlestick" || s.kind === "Bar")
      .flatMap((s) => s.data.map((p) => p.time));
    this.times = [
      ...new Set(
        candleTimes.length
          ? candleTimes
          : this.series.flatMap((s) => s.data.map((p) => p.time)),
      ),
    ].sort((a, b) => a - b);
    if (!this.fitted && this.times.length) this.fitContent();
    else {
      if (advance && this.times.length > oldCount) {
        const delta = this.times.length - oldCount;
        this.range = {
          from: this.range.from + delta,
          to: this.range.to + delta,
        };
      }
      this.updateScale();
      this.paintSoon();
    }
    const bars = this.series.find((s) => s.kind === "Candlestick" || s.kind === "Bar")?.data;
    const last = bars?.at(-1) as CandleData | undefined;
    this.canvas.setAttribute(
      "aria-description",
      last
        ? `${bars!.length} observations. Last bar: open ${last.open}, high ${last.high}, low ${last.low}, close ${last.close}. Feed status is displayed above the chart.`
        : "No price observations available.",
    );
  }
  private updateScale() {
    const panes = this.panes().length;
    for (let pane = 0; pane < panes; pane++) {
      if (this.priceScale("right", pane).options().autoScale === false && this.paneRanges.has(pane)) continue;
      const values: number[] = [];
      for (const s of this.series.filter((item) => item.paneIndex === pane))
        for (const p of s.data) {
          const i = this.indexForTime(p.time);
          if (i < this.range.from - 1 || i > this.range.to + 1) continue;
          if ("close" in p) {
            const high = this.toScaleValue(p.high, pane);
            const low = this.toScaleValue(p.low, pane);
            if (Number.isFinite(high)) values.push(high);
            if (Number.isFinite(low)) values.push(low);
          }
          else if ("value" in p) {
            const autoscale = s.options().autoscaleInfoProvider;
            const included = typeof autoscale !== "function" ||
              autoscale(() => ({ priceRange: { minValue: p.value, maxValue: p.value } })) !== null;
            const value = this.toScaleValue(p.value, pane);
            if (included && Number.isFinite(value)) values.push(value);
            if (included && s.kind === "Histogram") {
              const base = this.toScaleValue(Number(s.options().base) || 0, pane);
              if (Number.isFinite(base)) values.push(base);
            }
          }
        }
      let low = values.length ? Math.min(...values) : 0;
      let high = values.length ? Math.max(...values) : 1;
      const pad = Math.max((high - low) * 0.04, Math.abs(high) * 0.00002, 0.000001);
      low -= pad;
      high += pad;
      this.paneRanges.set(pane, { low, high });
      if (pane === 0) { this.low = low; this.high = high; }
    }
  }
  private paneTop(index: number): number {
    let top = 0;
    for (let pane = 0; pane < index; pane++) top += this.paneHeight(pane);
    return top;
  }
  private paneRange(index: number) { return this.paneRanges.get(index) ?? { low: this.low, high: this.high }; }
  private priceMode(pane: number) {
    return Number(this.priceScale("right", pane).options().mode ?? 0);
  }
  private priceBase(pane: number) {
    const series = this.series.find((item) => item.paneIndex === pane && (item.kind === "Candlestick" || item.kind === "Bar"));
    const first = series?.data[0] as CandleData | undefined;
    return Number(first?.close) || 1;
  }
  private toScaleValue(price: number, pane: number) {
    const mode = this.priceMode(pane);
    if (mode === 1) return price > 0 ? Math.log(price) : Number.NaN;
    if (mode === 2) return ((price / this.priceBase(pane)) - 1) * 100;
    if (mode === 3) return (price / this.priceBase(pane)) * 100;
    return price;
  }
  private fromScaleValue(value: number, pane: number) {
    const mode = this.priceMode(pane);
    if (mode === 1) return Math.exp(value);
    if (mode === 2) return this.priceBase(pane) * (1 + value / 100);
    if (mode === 3) return this.priceBase(pane) * value / 100;
    return value;
  }
  private scaleMargins(pane: number) {
    const margins = this.priceScale("right", pane).options().scaleMargins ?? {};
    const top = Math.max(0, Math.min(0.45, Number(margins.top ?? 0)));
    const bottom = Math.max(0, Math.min(0.45, Number(margins.bottom ?? 0)));
    return { top, available: Math.max(0.1, 1 - top - bottom) };
  }
  priceToCoordinate(price: number, pane = 0): number | null {
    const {low,high} = this.paneRange(pane);
    if (!Number.isFinite(price)) return null;
    const value = this.toScaleValue(price, pane);
    if (value < low || value > high) return null;
    const margins = this.scaleMargins(pane);
    const fraction = (high - value) / (high - low);
    const inverted = this.priceScale("right", pane).options().invertScale === true ? 1 - fraction : fraction;
    return (margins.top + inverted * margins.available) * this.paneHeight(pane);
  }
  coordinateToPrice(y: number, pane = 0): number | null {
    const {low,high} = this.paneRange(pane);
    if (!Number.isFinite(y) || y < 0 || y > this.paneHeight(pane)) return null;
    const margins = this.scaleMargins(pane);
    const rawFraction = (y / this.paneHeight(pane) - margins.top) / margins.available;
    const fraction = this.priceScale("right", pane).options().invertScale === true ? 1 - rawFraction : rawFraction;
    return this.fromScaleValue(high - fraction * (high - low), pane);
  }
  addSeries<T extends SeriesType>(type: T, options: Options = {}, paneIndex = 0) {
    const s = new CanvasSeries(this, type, options, paneIndex);
    if (!this.paneWeights.has(paneIndex)) this.paneWeights.set(paneIndex, 1);
    this.series.push(s);
    this.paintSoon();
    return s;
  }
  removeSeries(s: CanvasSeries<SeriesType>) {
    const index = this.series.indexOf(s);
    if (index >= 0) this.series.splice(index, 1);
    const used = new Set([0, ...this.series.map((series) => series.paneIndex)]);
    for (const pane of this.paneWeights.keys()) if (!used.has(pane)) this.paneWeights.delete(pane);
    this.dataChanged();
  }
  panes() {
    const count = Math.max(1, ...this.series.map((series) => series.paneIndex + 1));
    return Array.from({ length: count }, (_, index) => ({
      getSeries: () => this.series.filter((series) => series.paneIndex === index),
      getHeight: () => this.paneHeight(index),
      setStretchFactor: (factor: number) => {
        if (Number.isFinite(factor) && factor > 0) {
          this.paneWeights.set(index, factor);
          this.paintSoon();
        }
      },
    }));
  }
  private paneHeight(index: number) {
    const total = [...this.paneWeights.values()].reduce((sum, value) => sum + value, 0) || 1;
    return this.plotHeight() * (this.paneWeights.get(index) ?? 1) / total;
  }
  priceScale(side: "left" | "right" = "right", paneIndex = 0) {
    const key = `${paneIndex}:${side}`;
    const defaults = paneIndex === 0
      ? this.chartOptions[`${side}PriceScale`] ?? {}
      : this.paneScaleOptions.get(key) ?? this.chartOptions[`${side}PriceScale`] ?? {};
    return {
      options: () => ({ ...defaults, ...(this.paneScaleOptions.get(key) ?? {}) }),
      applyOptions: (next: Options) => {
        this.paneScaleOptions.set(key, { ...defaults, ...(this.paneScaleOptions.get(key) ?? {}), ...next });
        this.updateScale();
        this.paintSoon();
      },
    };
  }
  applyOptions(options: Options) {
    const merged: Options = { ...this.chartOptions, ...options };
    for (const key of ["layout", "grid", "crosshair", "timeScale", "rightPriceScale", "leftPriceScale", "localization", "handleScale", "handleScroll"] as const) {
      const current = this.chartOptions[key];
      const incoming = options[key];
      if (current && incoming && typeof current === "object" && typeof incoming === "object") {
        merged[key] = { ...current, ...incoming };
      }
    }
    this.chartOptions = merged;
    this.width = Math.max(
      1,
      Number(this.chartOptions.width) || this.container.clientWidth || 600,
    );
    this.height = Math.max(80, Number(this.chartOptions.height) || 400);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.updateScale();
    this.paintSoon();
  }
  subscribeCrosshairMove(fn: (p: any) => void) {
    this.crosshairListeners.add(fn);
  }
  unsubscribeCrosshairMove(fn: (p: any) => void) {
    this.crosshairListeners.delete(fn);
  }
  timeScale() {
    return {
      options: () => this.chartOptions.timeScale ?? {},
      fitContent: () => this.fitContent(),
      getVisibleLogicalRange: () =>
        this.times.length ? { ...this.range } : null,
      setVisibleLogicalRange: (r: Range) => this.setRange(r),
      setVisibleRange: (r: Range) =>
        this.setRange({
          from: this.indexForTime(r.from),
          to:
            this.indexForTime(r.to) +
             Math.max(2, Number(this.chartOptions.timeScale?.rightOffset) || 3),
        }),
      subscribeVisibleLogicalRangeChange: (fn: (r: Range | null) => void) =>
        this.rangeListeners.add(fn),
      unsubscribeVisibleLogicalRangeChange: (fn: (r: Range | null) => void) =>
        this.rangeListeners.delete(fn),
      timeToCoordinate: (time: number) =>
        this.times.length ? this.x(this.logicalIndexAtTime(time)) : null,
      coordinateToTime: (x: number) => this.timeAtIndex(this.indexAt(x)),
      getVisibleRange: () => {
        if (!this.times.length) return null;
        const from = this.timeAtIndex(this.range.from);
        const to = this.timeAtIndex(this.range.to);
        return from == null || to == null ? null : { from, to };
      },
      width: () => this.plotWidth(),
      scrollToRealTime: () => this.fitContent(),
      scrollToPosition: (position: number, _animated?: boolean) => {
        const span = this.range.to - this.range.from;
        this.setRange({ from: this.times.length + position - span, to: this.times.length + position });
      },
    };
  }
  options() { return this.chartOptions; }
  resize(width: number, height: number) { this.applyOptions({ width, height }); }
  takeScreenshot() { return this.canvas; }
  subscribeClick(listener: (event: any) => void) { this.clickListeners.add(listener); }
  unsubscribeClick(listener: (event: any) => void) { this.clickListeners.delete(listener); }
  setCrosshairPosition(price: number, time: number, _series?: CanvasSeries<SeriesType>) {
    const x = this.timeScale().timeToCoordinate(time);
    const y = this.priceToCoordinate(price);
    this.hover = x == null || y == null ? null : { x, y };
    this.paintSoon();
  }
  clearCrosshairPosition() { this.hover = null; this.paintSoon(); }
  private timeAtIndex(index: number): number | null {
    if (!this.times.length || !Number.isFinite(index)) return null;
    const lo = Math.floor(index);
    const fraction = index - lo;
    const step = this.times.length > 1 ? this.times.at(-1)! - this.times.at(-2)! : 60;
    const at = (i: number) => i < 0 ? this.times[0]! + i * step : i >= this.times.length ? this.times.at(-1)! + (i - this.times.length + 1) * step : this.times[i]!;
    return at(lo) + (at(lo + 1) - at(lo)) * fraction;
  }
  private fitContent() {
    this.setRange({
      from: -1, // Explicit fit includes every loaded candle; the adapter owns the initial recent-bar view.
      to:
        this.times.length +
            Math.max(3, Number(this.chartOptions.timeScale?.rightOffset) || 5),
    });
  }
  paintSoon() {
    if (this.dead || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }
  private paint() {
    const c = this.ctx;
    if (!c || this.dead) return;
    const w = this.plotWidth(),
      h = this.plotHeight();
    const dark = document.documentElement.classList.contains("dark");
    const text = dark ? "#91a5bc" : "#596c80",
      grid = dark ? "#1c2a3b" : "#e5ebf1",
      background = dark ? "#0b1421" : "#ffffff";
    const declaredPrecision = Number(this.series.find((series) => series.kind === "Candlestick" || series.kind === "Bar")?.options().priceFormat?.precision);
    const precision = Number.isInteger(declaredPrecision) && declaredPrecision >= 0
      ? Math.min(12, declaredPrecision)
      : this.high < 10 ? 5 : this.high < 100 ? 3 : 2;
    const fmt = (n: number) =>
      n.toLocaleString("en-US", {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      });
    const paneTop = (pane: number) => this.paneTop(pane);
    const paneHeight = (pane: number) => this.paneHeight(pane);
    const rawY = (price: number, pane = 0) => {
      const coordinate = this.priceToCoordinate(price, pane);
      return coordinate == null ? Number.NaN : paneTop(pane) + coordinate;
    };
    c.clearRect(0, 0, this.width, this.height);
    c.fillStyle = background;
    c.fillRect(0, 0, this.width, this.height);
    c.font = "11px Arial, sans-serif";
    c.textBaseline = "middle";
    c.strokeStyle = grid;
    c.lineWidth = 1;
    c.setLineDash([]);
    for (let pane = 0; pane < this.panes().length; pane++) {
      const top = paneTop(pane), paneH = paneHeight(pane), range = this.paneRange(pane);
      const paneSeries = this.series.find(series => series.paneIndex === pane && series.options().visible !== false);
      const paneFormat = paneSeries?.priceFormatter();
      const margins = this.scaleMargins(pane);
      const tickCount = Math.max(2, Math.floor(paneH * margins.available / 40));
      const priceTicks = this.priceMode(pane) === 0
        ? niceLinearPriceTicks(range.low, range.high, tickCount)
        : Array.from({ length: tickCount + 1 }, (_, i) =>
            this.fromScaleValue(range.high - (i / tickCount) * (range.high - range.low), pane));
      const ticks = priceTicks.length >= 2
        ? priceTicks
        : Array.from({ length: tickCount + 1 }, (_, i) =>
            this.fromScaleValue(range.high - (i / tickCount) * (range.high - range.low), pane));
      for (const price of ticks) {
        const scaleValue = this.toScaleValue(price, pane);
        const fraction = (range.high - scaleValue) / (range.high - range.low);
        const inverted = this.priceScale("right", pane).options().invertScale === true ? 1 - fraction : fraction;
        const y = top + paneH * (margins.top + margins.available * inverted);
        c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
        c.fillStyle = text;
        c.fillText(pane > 0 && paneFormat ? paneFormat.format(price) : fmt(price), w + 5, y);
      }
      if (pane > 0) {
        c.strokeStyle = dark ? "#31445c" : "#cad3de";
        c.beginPath(); c.moveTo(0, top); c.lineTo(w, top); c.stroke();
        c.strokeStyle = grid;
      }
    }
    const tickType = visibleTimeTickType(this.times, this.range);
    const formatter = this.chartOptions.timeScale?.tickMarkFormatter as TickMarkFormatter | undefined;
    const formatTime = (time: number) => formatter?.(time, tickType, this.chartOptions.localization?.locale ?? navigator.language) ??
      new Date(time * 1000).toLocaleString("en-GB", {
        timeZone: "UTC", day: "2-digit", month: "short",
        ...(tickType < 2 ? { year: "numeric" as const } : {}),
        ...(tickType >= 3 ? { hour: "2-digit" as const, minute: "2-digit" as const } : {}),
      });
    const samples = [this.range.from, (this.range.from + this.range.to) / 2, this.range.to]
      .map(index => this.times[Math.max(0, Math.min(this.times.length - 1, Math.round(index)))])
      .filter((time): time is number => time != null);
    const labelWidth = Math.max(42, ...samples.map(time => c.measureText(formatTime(time)).width));
    const timeTicks = adaptiveTimeTickCount(w, labelWidth);
    let lastLabelRight = -12;
    let lastTickIndex = -1;
    for (let i = 0; i <= timeTicks; i++) {
      const index = Math.round(this.indexAt((w * i) / timeTicks));
      const time = this.times[index];
      if (time == null || index === lastTickIndex) continue;
      lastTickIndex = index;
      const x = this.x(index);
      if (x < 0 || x > w) continue;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
      {
        const stamp = formatTime(time);
        const width = c.measureText(stamp).width;
        const left = Math.max(3, Math.min(w - width - 3, x - width / 2));
        if (left < lastLabelRight + 10 || width > w - 6) continue;
        c.fillStyle = text;
        c.fillText(stamp, left, h + 12);
        lastLabelRight = left + width;
      }
    }
    c.save();
    c.beginPath();
    c.rect(0, 0, w, h);
    c.clip();
    for (const s of this.series) {
      const pane = s.paneIndex, top = paneTop(pane), paneH = paneHeight(pane);
      const localY = (price: number) => {
        const coordinate = this.priceToCoordinate(price, pane);
        return coordinate == null ? Number.NaN : top + coordinate;
      };
      c.save();
      c.beginPath(); c.rect(0, top, w, paneH); c.clip();
      const body = Math.max(
        1,
        Math.min(14, (w / (this.range.to - this.range.from)) * 0.62),
      );
      if (s.kind === "Line" || s.kind === "Area" || s.kind === "Baseline") {
        c.strokeStyle = s.options().color || "#60a5fa";
        c.lineWidth = s.options().lineWidth || 1;
        c.setLineDash(s.options().lineStyle === 1 ? [1, 3] : s.options().lineStyle === 2 ? [5, 4] : []);
        c.beginPath();
        let drawing = false;
        for (const p of s.data) {
          if (!("value" in p)) { drawing = false; continue; }
          const x = this.x(this.indexForTime(p.time)), y = localY(p.value);
          if (drawing) c.lineTo(x, y); else { c.moveTo(x, y); drawing = true; }
        }
        if (s.kind === "Baseline") {
          const base = Number(s.options().baseValue?.price ?? s.options().base ?? 0);
          const baseY = localY(base);
          for (const point of s.data) {
            if (!("value" in point)) continue;
            const x = this.x(this.indexForTime(point.time));
            const y = localY(point.value);
            c.globalAlpha = 0.22;
            c.fillStyle = point.value >= base
              ? s.options().topFillColor ?? "#22c55e"
              : s.options().bottomFillColor ?? "#ef4444";
            c.fillRect(x - body / 2, Math.min(y, baseY), body, Math.max(1, Math.abs(baseY - y)));
          }
          c.globalAlpha = 1;
        }
        if (s.kind === "Area" && drawing) {
          const valid = s.data.filter((point): point is LineData => "value" in point);
          const last = valid.at(-1), first = valid[0];
          if (first && last) {
            c.lineTo(this.x(this.indexForTime(last.time)), top + paneH);
            c.lineTo(this.x(this.indexForTime(first.time)), top + paneH);
            c.closePath(); c.globalAlpha = 0.18; c.fillStyle = s.options().topColor ?? s.options().lineColor ?? "#38bdf8"; c.fill(); c.globalAlpha = 1;
            c.beginPath();
            valid.forEach((point, index) => {
              const x = this.x(this.indexForTime(point.time)), y = localY(point.value);
              index ? c.lineTo(x, y) : c.moveTo(x, y);
            });
          }
        }
        c.stroke();
        c.setLineDash([]);
      } else if (s.kind === "Histogram") {
        const base = Number(s.options().base) || 0;
        for (const point of s.data) {
          if (!("value" in point)) continue;
          const x = this.x(this.indexForTime(point.time));
          if (x < -body || x > w + body) continue;
          const y = localY(point.value), baseY = localY(base);
          c.fillStyle = point.color ?? s.options().color ?? (point.value >= base ? "#22c55e" : "#ef4444");
          c.fillRect(x - body / 2, Math.min(y, baseY), body, Math.max(1, Math.abs(baseY - y)));
        }
      } else
        for (const point of s.data) {
          const p = point as CandleData,
            x = this.x(this.indexForTime(p.time));
          if (x < -body || x > w + body) continue;
          const up = p.close >= p.open;
          const color = up
            ? s.options().upColor || "#35c9a6"
            : s.options().downColor || "#f27787";
          c.fillStyle = color;
          c.strokeStyle = up
            ? s.options().wickUpColor || color
            : s.options().wickDownColor || color;
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(x, localY(p.high));
          c.lineTo(x, localY(p.low));
          c.stroke();
          const candleTop = localY(Math.max(p.open, p.close)),
            candleHeight = Math.max(1, Math.abs(localY(p.close) - localY(p.open)));
          if (s.kind === "Bar") {
            c.beginPath(); c.moveTo(x - body / 2, localY(p.open)); c.lineTo(x, localY(p.open));
            c.moveTo(x, localY(p.close)); c.lineTo(x + body / 2, localY(p.close)); c.stroke();
            continue;
          }
          if (s.options().title === "Illustrative scenario") {
            c.strokeStyle = color;
            c.strokeRect(x - body / 2, candleTop, body, candleHeight);
          } else c.fillRect(x - body / 2, candleTop, body, candleHeight);
        }
      for (const markers of s.markerLayers.values())
        for (const m of markers) {
          const bar = s.data.find((p) => p.time === m.time) as
            | CandleData
            | undefined;
          if (!bar) continue;
          const x = this.x(this.indexForTime(m.time));
          if (x < 0 || x > w) continue;
          const above = m.position === "aboveBar",
            y = localY(above ? bar.high : bar.low) + (above ? -12 : 12);
          c.fillStyle = m.color;
          c.beginPath();
          c.arc(x, y, 3, 0, Math.PI * 2);
          c.fill();
          if (m.text) {
            c.fillStyle = m.color;
            c.fillText(
              m.text,
              Math.max(3, Math.min(w - c.measureText(m.text).width - 4, x + 7)),
              y,
            );
          }
        }
      for (const line of s.lines) {
        const lineOptions = line.options();
        const y = localY(Number(lineOptions.price));
        if (!Number.isFinite(y) || y < top || y > top + paneH) continue;
        c.strokeStyle = lineOptions.color ?? "#57d7f0";
        c.lineWidth = Number(lineOptions.lineWidth) || 1;
        c.setLineDash(lineOptions.lineStyle ? [5, 4] : []);
        c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); c.setLineDash([]);
        if (lineOptions.axisLabelVisible) { c.fillStyle = lineOptions.axisLabelColor ?? c.strokeStyle; c.fillText(lineOptions.title ?? fmt(Number(lineOptions.price)), w + 8, y); }
      }
      if (s.primitives.size) {
        const target: CanvasRenderingTarget2D = {
          useMediaCoordinateSpace: (render) => {
            c.save(); c.translate(0, top);
            try { return render({ context: c, mediaSize: { width: w, height: paneH } }); }
            finally { c.restore(); }
          },
        };
        for (const primitive of s.primitives) {
          primitive.updateAllViews?.();
          for (const view of primitive.paneViews?.() ?? []) view.renderer().draw(target);
          for (const axis of primitive.priceAxisViews?.() ?? []) if (axis.visible()) {
            const y = top + axis.coordinate();
            c.fillStyle = axis.backColor(); c.fillRect(w + 2, y - 8, 80, 16);
            c.fillStyle = axis.textColor(); c.fillText(axis.text(), w + 5, y);
          }
        }
      }
      c.restore();
    }
    const drawAnnotation = (d: ChartDrawing, preview = false) => {
      const x1 = this.drawingX(d.start.time),
        x2 = this.drawingX(d.end.time),
        y1 = rawY(d.start.price),
        y2 = rawY(d.end.price);
      c.strokeStyle = preview ? "#a5c5d8" : "#6ce3ff";
      c.fillStyle = "rgba(108,227,255,0.08)";
      c.lineWidth = 1.5;
      c.setLineDash(preview ? [4, 4] : []);
      if (d.tool === "rectangle") {
        c.fillRect(
          Math.min(x1, x2),
          Math.min(y1, y2),
          Math.abs(x2 - x1),
          Math.abs(y2 - y1),
        );
        c.strokeRect(x1, y1, x2 - x1, y2 - y1);
      } else if (d.tool === "fibonacci") {
        for (const level of fibonacciLevels(d.start.price, d.end.price)) {
          const y = rawY(level.price);
          c.beginPath();
          c.moveTo(Math.min(x1, x2), y);
          c.lineTo(Math.max(x1, x2), y);
          c.stroke();
          c.fillStyle = "#9aebff";
          c.fillText(
            `${(level.ratio * 100).toFixed(1)}% · ${fmt(level.price)}`,
            Math.max(4, Math.min(x1, x2) + 6),
            y - 7,
          );
        }
      } else {
        c.beginPath();
        c.moveTo(d.tool === "horizontal" ? 0 : x1, y1);
        c.lineTo(
          d.tool === "horizontal" ? w : x2,
          d.tool === "horizontal" ? y1 : y2,
        );
        c.stroke();
        if (d.tool === "horizontal") {
          c.fillStyle = "#9aebff";
          c.fillText(`Level ${fmt(d.start.price)}`, 8, y1 - 8);
        }
      }
      c.setLineDash([]);
      c.fillStyle = "#6ce3ff";
      c.beginPath();
      c.arc(x1, y1, 3, 0, Math.PI * 2);
      c.fill();
    };
    if (this.drawingsVisible) for (const d of this.drawings) drawAnnotation(d);
    if (this.drawingStart && this.hover && this.drawingTool !== "cursor") {
      const end = this.anchorAt(this.hover);
      if (end)
        drawAnnotation(
          {
            id: "preview",
            tool: this.drawingTool,
            start: this.drawingStart,
            end,
          },
          true,
        );
    }
    c.restore();
    const priceLine = (o: Options) => {
      const y = this.priceToCoordinate(o.price);
      if (y == null) return;
      c.strokeStyle = o.color || "#4ebed3";
      c.lineWidth = o.lineWidth || 1;
      c.setLineDash(o.lineStyle ? [5, 4] : []);
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
      c.setLineDash([]);
      if (o.axisLabelVisible !== false) {
        c.fillStyle = o.color || "#4ebed3";
        c.fillRect(w, y - 9, 82, 18);
        c.fillStyle = "#08121e";
        c.fillText(fmt(o.price), w + 7, y);
      }
      if (o.title) {
        c.fillStyle = background;
        c.fillRect(7, y - 9, c.measureText(o.title).width + 12, 18);
        c.fillStyle = o.color || text;
        c.fillText(o.title, 13, y);
      }
    };
    for (const s of this.series) {
      for (const line of s.lines) priceLine(line.options());
      const last = s.data.at(-1) as CandleData | undefined;
      if (last && s.kind === "Candlestick" && s.options().priceLineVisible)
        priceLine({
          price: last.close,
          color: s.options().priceLineColor || "#4ebed3",
          lineStyle: 2,
          axisLabelVisible: s.options().lastValueVisible,
        });
    }
    if (this.hover && this.hover.x < w && this.hover.y < h) {
      const { x, y } = this.hover;
      c.strokeStyle = text;
      c.setLineDash([3, 5]);
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
      c.setLineDash([]);
      const time = this.times[Math.round(this.indexAt(x))],
        bar = this.series
          .find((s) => s.kind === "Candlestick")
          ?.data.find((p) => p.time === time) as CandleData | undefined;
      if (bar) {
        const label = `${new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC   O ${fmt(bar.open)}  H ${fmt(bar.high)}  L ${fmt(bar.low)}  C ${fmt(bar.close)}`;
        c.fillStyle = background;
        c.fillRect(7, 7, Math.min(w - 14, c.measureText(label).width + 16), 24);
        c.fillStyle = text;
        c.fillText(label, 14, 19, w - 28);
      }
    }
  }
  remove() {
    if (this.dead) return;
    this.dead = true;
    cancelAnimationFrame(this.frame);
    this.cleanups.forEach((fn) => fn());
    this.rangeListeners.clear();
    this.crosshairListeners.clear();
    this.pointers.clear();
    this.drawingListener = null;
    this.series.length = 0;
    this.canvas.remove();
  }
}
export function createChart(container: HTMLElement, options: Options = {}) {
  return new CanvasChart(container, options);
}
export function createSeriesMarkers(
  series: CanvasSeries<SeriesType>,
  markers: SeriesMarker[],
) {
  const id = Symbol("markers");
  series.markerLayers.set(id, markers);
  series.chart.paintSoon();
  return {
    setMarkers: (next: SeriesMarker[]) => {
      series.markerLayers.set(id, next);
      series.chart.paintSoon();
    },
    detach: () => {
      series.markerLayers.delete(id);
      series.chart.paintSoon();
    },
  };
}
