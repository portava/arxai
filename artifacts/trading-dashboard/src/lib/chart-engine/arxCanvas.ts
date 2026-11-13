/** ARX's first-party Canvas2D renderer. No remote scripts or chart vendors.
 * The small imperative API keeps existing feed gates and overlay controllers intact.
 * All prices and times come from caller-supplied observations or labelled overlays.
 */
export type UTCTimestamp = number;
export type SeriesType = "Candlestick" | "Line";
export const CandlestickSeries = "Candlestick" as const;
export const LineSeries = "Line" as const;
export const ColorType = { Solid: "solid" } as const;
export const CrosshairMode = { Normal: 0 } as const;
export const LineStyle = { Solid: 0, Dotted: 1, Dashed: 2 } as const;
export interface LineData<T = number> {
  time: T;
  value: number;
}
export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
type Point = CandleData | LineData;
type Options = Record<string, any>;
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
      kind === "Candlestick"
        ? validCandle(p as CandleData)
        : Number.isFinite(p.time) &&
          p.time > 0 &&
          Number.isFinite((p as LineData).value)
    )
      unique.set(p.time, p);
  return [...unique.values()].sort((a, b) => a.time - b.time);
}
export function zoomRange(range: Range, factor: number, anchor = 0.5): Range {
  const span = Math.max(8, Math.min(3000, (range.to - range.from) * factor));
  const pivot = range.from + (range.to - range.from) * anchor;
  return { from: pivot - span * anchor, to: pivot + span * (1 - anchor) };
}

class CanvasSeries<T extends SeriesType> {
  data: Point[] = [];
  options: Options;
  lines = new Set<IPriceLine>();
  markerLayers = new Map<symbol, SeriesMarker[]>();
  constructor(
    readonly chart: CanvasChart,
    readonly kind: T,
    options: Options,
  ) {
    this.options = {
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
    Object.assign(this.options, options);
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
  priceToCoordinate(price: number) {
    return this.chart.priceToCoordinate(price);
  }
  coordinateToPrice(y: number) {
    return this.chart.coordinateToPrice(y);
  }
}

class CanvasChart {
  readonly canvas: HTMLCanvasElement;
  readonly series: CanvasSeries<SeriesType>[] = [];
  private ctx: CanvasRenderingContext2D | null;
  private options: Options;
  private width = 0;
  private height = 0;
  private frame = 0;
  private dead = false;
  private times: number[] = [];
  private range: Range = { from: 0, to: 100 };
  private fitted = false;
  private low = 0;
  private high = 1;
  private hover: { x: number; y: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: { range: Range; x: number; distance: number } | null = null;
  private rangeListeners = new Set<(r: Range | null) => void>();
  private crosshairListeners = new Set<(p: any) => void>();
  private cleanups: (() => void)[] = [];
  constructor(
    private container: HTMLElement,
    options: Options,
  ) {
    this.options = options;
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
      if (this.options.handleScroll?.pressedMouseMove === false) return;
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
        if (values.length > 1 && this.options.handleScale?.pinch !== false) {
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
    this.on(
      "wheel",
      (e: WheelEvent) => {
        if (this.options.handleScale?.mouseWheel === false) return;
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
  private plotWidth() {
    return Math.max(1, this.width - 82);
  }
  private plotHeight() {
    return Math.max(1, this.height - 32);
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
      .filter((s) => s.kind === "Candlestick")
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
    const bars = this.series.find((s) => s.kind === "Candlestick")?.data;
    const last = bars?.at(-1) as CandleData | undefined;
    this.canvas.setAttribute(
      "aria-description",
      last
        ? `${bars!.length} observations. Last bar: open ${last.open}, high ${last.high}, low ${last.low}, close ${last.close}. Feed status is displayed above the chart.`
        : "No price observations available.",
    );
  }
  private updateScale() {
    const values: number[] = [];
    for (const s of this.series)
      for (const p of s.data) {
        const i = this.indexForTime(p.time);
        if (i < this.range.from - 1 || i > this.range.to + 1) continue;
        if ("close" in p) values.push(p.high, p.low);
        else values.push(p.value);
      }
    if (!values.length) {
      this.low = 0;
      this.high = 1;
      return;
    }
    let low = Math.min(...values),
      high = Math.max(...values);
    const pad = Math.max(
      (high - low) * 0.12,
      Math.abs(high) * 0.00002,
      0.000001,
    );
    this.low = low - pad;
    this.high = high + pad;
  }
  priceToCoordinate(price: number): number | null {
    if (!Number.isFinite(price) || price < this.low || price > this.high)
      return null;
    return ((this.high - price) / (this.high - this.low)) * this.plotHeight();
  }
  coordinateToPrice(y: number): number | null {
    return Number.isFinite(y) && y >= 0 && y <= this.plotHeight()
      ? this.high - (y / this.plotHeight()) * (this.high - this.low)
      : null;
  }
  addSeries<T extends SeriesType>(type: T, options: Options = {}) {
    const s = new CanvasSeries(this, type, options);
    this.series.push(s);
    return s;
  }
  removeSeries(s: CanvasSeries<SeriesType>) {
    const index = this.series.indexOf(s);
    if (index >= 0) this.series.splice(index, 1);
    this.dataChanged();
  }
  applyOptions(options: Options) {
    this.options = { ...this.options, ...options };
    this.width = Math.max(
      1,
      Number(this.options.width) || this.container.clientWidth || 600,
    );
    this.height = Math.max(80, Number(this.options.height) || 400);
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
      fitContent: () => this.fitContent(),
      getVisibleLogicalRange: () =>
        this.times.length ? { ...this.range } : null,
      setVisibleLogicalRange: (r: Range) => this.setRange(r),
      setVisibleRange: (r: Range) =>
        this.setRange({
          from: this.indexForTime(r.from),
          to:
            this.indexForTime(r.to) +
            Math.max(2, Number(this.options.timeScale?.rightOffset) || 3),
        }),
      subscribeVisibleLogicalRangeChange: (fn: (r: Range | null) => void) =>
        this.rangeListeners.add(fn),
      unsubscribeVisibleLogicalRangeChange: (fn: (r: Range | null) => void) =>
        this.rangeListeners.delete(fn),
      timeToCoordinate: (time: number) =>
        this.times.length ? this.x(this.indexForTime(time)) : null,
    };
  }
  private fitContent() {
    this.setRange({
      from: Math.max(-1, this.times.length - (this.width < 600 ? 65 : 150)),
      to:
        this.times.length +
        Math.max(3, Number(this.options.timeScale?.rightOffset) || 5),
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
    const precision = this.high < 10 ? 5 : this.high < 100 ? 3 : 2;
    const fmt = (n: number) =>
      n.toLocaleString("en-US", {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      });
    const rawY = (price: number) =>
      ((this.high - price) / (this.high - this.low)) * h;
    c.clearRect(0, 0, this.width, this.height);
    c.fillStyle = background;
    c.fillRect(0, 0, this.width, this.height);
    c.font = "11px ui-monospace, SFMono-Regular, monospace";
    c.textBaseline = "middle";
    c.strokeStyle = grid;
    c.lineWidth = 1;
    c.setLineDash([]);
    for (let i = 0; i <= 5; i++) {
      const y = 12 + ((h - 24) * i) / 5;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
      c.fillStyle = text;
      c.fillText(fmt(this.high - (y / h) * (this.high - this.low)), w + 9, y);
    }
    const timeTicks = Math.max(2, Math.floor(w / 110));
    for (let i = 0; i <= timeTicks; i++) {
      const x = (w * i) / timeTicks;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
      const time = this.times[Math.round(this.indexAt(x))];
      if (time) {
        const date = new Date(time * 1000);
        const stamp =
          this.times.at(-1)! - this.times[0] > 86400 * 3
            ? date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })
            : date.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "UTC",
              });
        c.fillStyle = text;
        c.fillText(stamp, Math.min(w - 42, Math.max(4, x - 18)), h + 17);
      }
    }
    c.save();
    c.beginPath();
    c.rect(0, 0, w, h);
    c.clip();
    for (const s of this.series) {
      const body = Math.max(
        1,
        Math.min(14, (w / (this.range.to - this.range.from)) * 0.62),
      );
      if (s.kind === "Line") {
        c.strokeStyle = s.options.color || "#60a5fa";
        c.lineWidth = s.options.lineWidth || 1;
        c.setLineDash(s.options.lineStyle ? [5, 4] : []);
        c.beginPath();
        s.data.forEach((p, i) => {
          const x = this.x(this.indexForTime(p.time)),
            y = rawY((p as LineData).value);
          if (i) c.lineTo(x, y);
          else c.moveTo(x, y);
        });
        c.stroke();
        c.setLineDash([]);
      } else
        for (const point of s.data) {
          const p = point as CandleData,
            x = this.x(this.indexForTime(p.time));
          if (x < -body || x > w + body) continue;
          const up = p.close >= p.open;
          const color = up
            ? s.options.upColor || "#35c9a6"
            : s.options.downColor || "#f27787";
          c.fillStyle = color;
          c.strokeStyle = up
            ? s.options.wickUpColor || color
            : s.options.wickDownColor || color;
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(x, rawY(p.high));
          c.lineTo(x, rawY(p.low));
          c.stroke();
          const top = rawY(Math.max(p.open, p.close)),
            height = Math.max(1, Math.abs(rawY(p.close) - rawY(p.open)));
          if (s.options.title === "Illustrative scenario") {
            c.strokeStyle = color;
            c.strokeRect(x - body / 2, top, body, height);
          } else c.fillRect(x - body / 2, top, body, height);
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
            y = rawY(above ? bar.high : bar.low) + (above ? -12 : 12);
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
      if (last && s.kind === "Candlestick" && s.options.priceLineVisible)
        priceLine({
          price: last.close,
          color: s.options.priceLineColor || "#4ebed3",
          lineStyle: 2,
          axisLabelVisible: s.options.lastValueVisible,
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
