import { prepareNativePriceSeries, createNativePriceFrame, paintNativePriceLayer, type NativePriceFrame } from "./nativePriceRenderer";
import { nativePlotLayout, paintNativeAxes } from "./nativeChartAxes";
import { panChartWindow, zoomChartWindow, type LogicalWindow } from "./chartNavigation";
import { candleDisplayPrecision, historyRangeShift } from "./candleReconciliation";
import { CHART_STYLES, type ChartStyle, type ChartScaleMode } from "./chartWorkspace";
import { effectiveDisplayZone, isChartTimeZone, type ChartTimeZone } from "./chartTimeZone";
import type { ChartEngineCandle } from "./types";
import type { ChartStudy } from "./chartStudies";
import { NativeChartStudies, layoutNativeStudyPanes, paintNativeStudies } from "./nativeChartStudies";

export interface NativeCrosshair {
  readonly candle: Readonly<ChartEngineCandle>;
  readonly x: number;
  readonly y: number;
  /** Cursor coordinate converted to actual price; never HA or axis-percent units. */
  readonly price: number | null;
}
export interface NativeChartViewportOptions {
  height?: number;
  visibleBars?: number;
  style?: ChartStyle;
  scale?: ChartScaleMode;
  inverted?: boolean;
  timeZone?: ChartTimeZone;
  timeframe?: string;
  priceDigits?: number;
  onCrosshair?: (value: NativeCrosshair | null) => void;
  onViewportChange?: () => void;
}
interface Point { x: number; y: number }
interface Gesture { center: Point; distance: number }
// Resource ceilings, not market policy. Effective DPR is exposed to callers.
const MAX_CSS_SIDE = 16_384, MAX_BACKING_SIDE = 8_192, MAX_BACKING_PIXELS = 16_777_216;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Independent DOM controller. Still not a complete engine adapter: drawings,
 * trading overlays and replay are pending; the registered app is unchanged. */
export class NativeChartViewport {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: NativeChartViewportOptions;
  private series = prepareNativePriceSeries([]);
  private readonly studies = new NativeChartStudies();
  private priceOnlyScale = false;
  private range: LogicalWindow | null = null;
  private frame: NativePriceFrame | null = null;
  private referencePrice: number | null = null;
  private referenceSet = false;
  private style: ChartStyle = "candles";
  private scale: ChartScaleMode = "linear";
  private inverted = false;
  private timeZone: ChartTimeZone = "UTC";
  private timeframe = "M1";
  private priceDigits = 2;
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private followingLatest = true;
  private destroyed = false;
  private generation = 0;
  private mutationRevision = 0;
  private raf: number | null = null;
  private drawCount = 0;
  private paintError: string | null = null;
  private frameIssue: string | null = null;
  private callbackError: string | null = null;
  private hover: NativeCrosshair | null = null;
  private pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private observer: ResizeObserver | null = null;
  private media: MediaQueryList | null = null;
  private listeners: Array<() => void> = [];

  constructor(private readonly container: HTMLElement, options: NativeChartViewportOptions = {}) {
    this.options = { ...options };
    if (options.style && CHART_STYLES.includes(options.style)) this.style = options.style;
    if (options.scale && ["linear", "log", "percent", "indexed"].includes(options.scale)) this.scale = options.scale;
    this.inverted = options.inverted === true;
    if (isChartTimeZone(options.timeZone)) this.timeZone = options.timeZone;
    this.timeframe = options.timeframe ?? "M1";
    this.canvas = container.ownerDocument.createElement("canvas");
    this.canvas.dataset.arxNativeViewport = "true";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "region");
    this.canvas.setAttribute("aria-label", "ARX price chart. Drag to pan, scroll or pinch to zoom. Arrow keys pan, plus and minus zoom, Home fits history, End returns to latest.");
    this.canvas.style.touchAction = "none";
    this.canvas.style.display = "block";
    this.canvas.width = 0;this.canvas.height = 0;
    this.canvas.style.width = "0px";this.canvas.style.height = "0px";
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.context = context;
    container.appendChild(this.canvas);
    const listen = (type: string, handler: EventListener, options?: AddEventListenerOptions) => {
      this.canvas.addEventListener(type, handler, options);
      this.listeners.push(() => this.canvas.removeEventListener(type, handler, options));
    };
    listen("pointerdown", this.onPointerDown as EventListener);
    listen("pointermove", this.onPointerMove as EventListener);
    listen("pointerup", this.onPointerUp as EventListener);
    listen("pointercancel", this.onPointerCancel as EventListener);
    listen("lostpointercapture", this.onLostCapture as EventListener);
    listen("pointerleave", (() => { if (!this.pointers.size) this.clearHover(); }) as EventListener);
    listen("wheel", this.onWheel as EventListener, { passive: false });
    listen("keydown", this.onKeyDown as EventListener);
    // Pointer capture can be unavailable (embedded contexts, detached capture,
    // browser errors). Only already-owned pointers use this window fallback.
    const listenWindow = (type: string, handler: EventListener) => {
      window.addEventListener(type, handler);
      this.listeners.push(() => window.removeEventListener(type, handler));
    };
    listenWindow("pointermove", this.onOutsidePointerMove as EventListener);
    listenWindow("pointerup", this.onPointerUp as EventListener);
    listenWindow("pointercancel", this.onOutsidePointerCancel as EventListener);
    listenWindow("blur", this.onWindowBlur as EventListener);
    window.addEventListener("resize", this.onResize);
    this.listeners.push(() => window.removeEventListener("resize", this.onResize));
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => { if (!this.destroyed) this.resize(); });
      this.observer.observe(container);
    }
    this.resize();
  }

  private watchDpr() {
    this.media?.removeEventListener("change", this.onDprChange);
    this.media = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : null;
    this.media?.addEventListener("change", this.onDprChange);
  }
  private onDprChange = () => { if (!this.destroyed) this.resize(); };
  private onResize = () => { if (!this.destroyed) this.resize(); };

  resize(width?: number, height?: number): void {
    if (this.destroyed) return;
    const revision = ++this.mutationRevision;
    const bounds = this.container.getBoundingClientRect();
    const w = width ?? bounds.width, h = height ?? this.options.height ?? bounds.height;
    const requestedRatio = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const valid = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= MAX_CSS_SIDE && h <= MAX_CSS_SIDE;
    const nextWidth = valid ? w : 0, nextHeight = valid ? h : 0;
    const ratio = valid ? Math.min(requestedRatio, MAX_BACKING_SIDE / w, MAX_BACKING_SIDE / h, Math.sqrt(MAX_BACKING_PIXELS / (w * h))) : 1;
    if (nextWidth !== this.width || nextHeight !== this.height || ratio !== this.pixelRatio) {
      this.cancelGesture(); this.clearHover();
      if (this.destroyed || revision !== this.mutationRevision) return;
      this.width = nextWidth; this.height = nextHeight; this.pixelRatio = ratio;
      this.canvas.width = Math.floor(this.width * ratio); this.canvas.height = Math.floor(this.height * ratio);
      this.canvas.style.width = `${this.width}px`; this.canvas.style.height = `${this.height}px`;
      this.invalidate();
    }
    this.watchDpr();
  }

  setCandles(candles: readonly ChartEngineCandle[]): void {
    if (this.destroyed) return;
    const revision = ++this.mutationRevision;
    const previous = this.series.candles;
    const next = prepareNativePriceSeries(candles);
    this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.series = next;
    this.studies.setCandles(next.candles);
    if (!this.referenceSet && next.candles.length) {
      // Preserve the exact first canonical close, including invalid-for-percent
      // zero/negative references. Never substitute a later positive observation.
      this.referencePrice = next.candles[0]!.close; this.referenceSet = true;
    }
    this.priceDigits = Number.isInteger(this.options.priceDigits) && this.options.priceDigits! >= 0 && this.options.priceDigits! <= 16
      ? this.options.priceDigits! : candleDisplayPrecision(next.candles);
    const times = new Set(next.candles.map(candle => candle.time));
    const overlap = previous.some(candle => times.has(candle.time));
    // A refresh, append, prepend or rolling window retains the CSS pointer
    // baseline: historyRangeShift rebases its logical observation below. Empty
    // or disjoint history has no shared anchor and explicitly ends the gesture.
    if (!next.candles.length || (previous.length && !overlap)) this.cancelGesture();
    if (!next.candles.length) this.range = null;
    else if (this.followingLatest || !this.range || !overlap) this.range = this.latestRange(this.range ? this.range.to - this.range.from : undefined);
    else {
      const shift = historyRangeShift(previous, next.candles);
      this.range = panChartWindow({ from: this.range.from + shift, to: this.range.to + shift }, 0, next.candles.length);
    }
    this.invalidate();
  }

  private latestRange(span = this.options.visibleBars ?? 100): LogicalWindow | null {
    const count = this.series.candles.length;
    const width = Number.isFinite(span) && span > 0 ? span : 100;
    return panChartWindow({ from: count + 1 - width, to: count + 1 }, 0, count);
  }
  getRange(): Readonly<LogicalWindow> | null { return this.range ? Object.freeze({ ...this.range }) : null; }
  getPaneLayout() {
    const full = nativePlotLayout(this.width, this.height);
    return full ? layoutNativeStudyPanes(full, this.studies.paneCount) : null;
  }
  setStudies(configs: ChartStudy[]): void {
    if (this.destroyed) return;
    const revision = ++this.mutationRevision;
    this.cancelGesture();this.clearHover();if(this.destroyed || revision!==this.mutationRevision)return;
    this.studies.setStudies(configs, this.series.candles);this.invalidate();
  }
  getStudyValues(time: number) { return this.studies.getValues(time); }
  getVolumeProfiles() { return this.studies.getProfiles(); }
  setPriceOnlyScale(enabled: boolean): void {
    if(this.destroyed || this.priceOnlyScale===enabled)return;
    const revision=++this.mutationRevision;
    this.cancelGesture();this.clearHover();if(this.destroyed||revision!==this.mutationRevision)return;
    this.priceOnlyScale=enabled;this.invalidate();
  }
  getFrame(): NativePriceFrame | null {
    if (this.destroyed || this.paintError || !this.range) {
      this.frameIssue = this.destroyed ? "DESTROYED" : this.paintError ? "PAINT_FAILED" : "NO_DATA";return null;
    }
    if (this.frame) return this.frame;
    if (!nativePlotLayout(this.width,this.height)) {this.frameIssue="ZERO_SIZE_OR_UNSUPPORTED_DIMENSIONS";return null;}
    const layout = this.getPaneLayout();
    if (!layout) { this.frameIssue = "INSUFFICIENT_PANE_SPACE_OR_UNSUPPORTED_DIMENSIONS";return null; }
    const plot = layout.price;
    const result = createNativePriceFrame(this.series, { plot, range: this.range, style: this.style, scale: this.scale,
      inverted: this.inverted, referencePrice: this.referencePrice ?? undefined,
      additionalPriceValues: this.priceOnlyScale ? [] : this.studies.getPriceBounds(this.range, this.scale) });
    this.frame = result.ok ? result.frame : null;
    this.frameIssue = result.ok ? null : result.reason;
    return this.frame;
  }
  getState() {
    const frame = this.getFrame();
    return Object.freeze({ status: this.destroyed ? "destroyed" : this.paintError ? "error" : !this.series.candles.length ? "empty" : frame ? "ready" : "unavailable",
      error: this.paintError ?? this.frameIssue, callbackError: this.callbackError, referencePrice: this.referencePrice, style: this.style, scale: this.scale, inverted: this.inverted,
      timeZone: this.timeZone, effectiveTimeZone: effectiveDisplayZone(this.timeZone, this.timeframe), timeframe: this.timeframe,
      barCount: this.series.candles.length, discarded: this.series.discarded, range: this.getRange(), followingLatest: this.followingLatest,
      paneCount: this.studies.paneCount, priceOnlyScale: this.priceOnlyScale,
      width: this.width, height: this.height, pixelRatio: this.pixelRatio, pendingPaint: this.raf != null, drawCount: this.drawCount, paintCount: this.drawCount });
  }
  setRange(range: LogicalWindow): void {
    if (this.destroyed) return;
    const bounded = panChartWindow(range, 0, this.series.candles.length);
    if (!bounded) return;
    const revision = ++this.mutationRevision;
    this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.range = bounded; this.followingLatest = false; this.invalidate();
  }
  fit(): void { if (!this.destroyed) this.setRange({ from: -1, to: this.series.candles.length }); }
  goLatest(): void {
    if (this.destroyed) return;
    const revision = ++this.mutationRevision;
    this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.range = this.latestRange(this.range ? this.range.to - this.range.from : undefined);
    this.followingLatest = true; this.invalidate();
  }
  setStyle(style: ChartStyle): void {
    if (!this.destroyed && CHART_STYLES.includes(style) && style !== this.style) {
      const revision = ++this.mutationRevision;
      this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.style = style; this.invalidate();
    }
  }
  setScale(scale: ChartScaleMode, inverted = this.inverted): void {
    if (this.destroyed || !["linear", "log", "percent", "indexed"].includes(scale)) return;
    const revision = ++this.mutationRevision;
    this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.scale = scale; this.inverted = inverted; this.invalidate();
  }
  setDisplayTimeZone(zone: ChartTimeZone, timeframe = this.timeframe): void {
    if (this.destroyed || !isChartTimeZone(zone)) return;
    ++this.mutationRevision;
    this.timeZone = zone; this.timeframe = timeframe; this.invalidate();
  }
  resetContext(): void {
    if (this.destroyed) return;
    const revision = ++this.mutationRevision;
    this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.generation++;
    if (this.raf != null) cancelAnimationFrame(this.raf); this.raf = null;
    this.series = prepareNativePriceSeries([]); this.range = null; this.referencePrice = null; this.referenceSet = false;
    this.studies.reset();
    this.followingLatest = true; this.invalidate();
  }
  private invalidate() { this.frame = null; this.paintError = null; this.schedule(); }
  private schedule() {
    if (this.destroyed || this.raf != null) return;
    const generation = this.generation;
    const id = requestAnimationFrame(() => {
      if (this.destroyed || generation !== this.generation || this.raf !== id) return;
      this.raf = null; this.paint();
    });
    this.raf = id;
  }
  private paint() {
    if (this.destroyed) return;
    try {
      const ctx = this.context;
      ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      const frame = this.getFrame();
      if (frame) {
        const layout = this.getPaneLayout()!, last = layout.panes.at(-1) ?? layout.price;
        const chartBottom = last.top + last.height;
        paintNativeAxes(ctx, frame, { timeZone: effectiveDisplayZone(this.timeZone, this.timeframe), priceDigits: this.priceDigits, timeAxisBottom:chartBottom });
        paintNativePriceLayer(ctx, frame);
        paintNativeStudies(ctx, frame, layout.panes, this.studies);
        if (this.hover) {
          ctx.save();
          try {
            ctx.beginPath(); ctx.rect(frame.plot.left, frame.plot.top, frame.plot.width, chartBottom-frame.plot.top); ctx.clip();
            ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
            ctx.beginPath();ctx.moveTo(this.hover.x, frame.plot.top);ctx.lineTo(this.hover.x, chartBottom);
            ctx.moveTo(frame.plot.left, this.hover.y);ctx.lineTo(frame.plot.left + frame.plot.width, this.hover.y);ctx.stroke();
          } finally { ctx.restore(); }
        }
      }
      this.drawCount++;
      this.notify("viewport", () => this.options.onViewportChange?.());
    } catch (error) {
      this.frame = null; this.paintError = error instanceof Error ? error.message : "Price layer paint failed";
      try { this.context.clearRect(0, 0, this.width, this.height); } catch { /* preserve the original paint failure */ }
    }
  }
  exportImage(): string | null {
    if (this.destroyed) return null;
    if (this.raf != null) { cancelAnimationFrame(this.raf); this.raf = null; this.paint(); }
    if (!this.getFrame() || this.paintError) return null;
    try { return this.canvas.toDataURL("image/png"); } catch { return null; }
  }

  private notify(kind: string, callback: () => void) {
    try { callback(); } catch (error) {
      this.callbackError = `${kind} callback failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  private point(event: { clientX: number; clientY: number }): Point | null {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    const x = (event.clientX - rect.left) * this.width / rect.width, y = (event.clientY - rect.top) * this.height / rect.height;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  private inside(point: Point, frame = this.getFrame()): boolean {
    const layout = frame ? this.getPaneLayout() : null;
    return !!layout && [layout.price,...layout.panes].some(plot=>point.x >= plot.left && point.x <= plot.left + plot.width
      && point.y >= plot.top && point.y <= plot.top + plot.height);
  }
  private clearHover() { if (this.hover) { this.hover = null; this.notify("crosshair", () => this.options.onCrosshair?.(null)); this.schedule(); } }
  private updateHover(point: Point) {
    const frame = this.getFrame(), candle = this.inside(point, frame) ? frame!.barAtX(point.x) : null;
    if (!frame || !candle) { this.clearHover(); return; }
    const x = frame.timeToX(candle.time);
    if (x == null) { this.clearHover(); return; }
    this.hover = Object.freeze({ candle, x, y: point.y,
      price: point.y>=frame.plot.top&&point.y<=frame.plot.top+frame.plot.height ? frame.yToPrice(point.y) : null });
    this.notify("crosshair", () => this.options.onCrosshair?.(this.hover)); this.schedule();
  }
  private gestureState(): Gesture | null {
    const values = [...this.pointers.values()];
    if (!values.length) return null;
    if (values.length === 1) return { center: values[0]!, distance: 0 };
    const [a, b] = values;
    return { center: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
  }
  private cancelGesture() {
    const ids = [...this.pointers.keys()]; this.pointers.clear(); this.gesture = null;
    for (const id of ids) { try { this.canvas.releasePointerCapture(id); } catch { /* unavailable or already lost */ } }
  }
  private onPointerDown = (event: PointerEvent) => {
    if (this.destroyed || event.button !== 0 || this.pointers.size >= 2) return;
    const point = this.point(event); if (!point || !this.inside(point)) return;
    event.preventDefault(); this.canvas.focus({ preventScroll: true });
    this.pointers.set(event.pointerId, point); this.gesture = this.gestureState();
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* owned window fallback retains release/cancel delivery */ }
    this.clearHover();
  };
  private shift(range: LogicalWindow, delta: number): LogicalWindow | null {
    // Reuse the same loaded-history bounds for any finite drag distance.
    return panChartWindow({ from: range.from + delta, to: range.to + delta }, 0, this.series.candles.length);
  }
  private zoomAt(factor: number, oldX: number, newX = oldX) {
    const frame = this.getFrame(); if (!frame || !this.range) return;
    const anchor = frame.xToLogical(oldX); if (anchor == null) return;
    const zoomed = zoomChartWindow(this.range, clamp(factor, .25, 4), this.series.candles.length); if (!zoomed) return;
    const fraction = (newX - frame.plot.left) / frame.plot.width;
    const desiredFrom = anchor - fraction * (zoomed.to - zoomed.from);
    const next = this.shift(zoomed, desiredFrom - zoomed.from);
    if (next) { this.range = next; this.followingLatest = false; this.frame = null; this.schedule(); }
  }
  private onPointerMove = (event: PointerEvent) => {
    if (this.destroyed) return;
    const point = this.point(event); if (!point) return;
    if (!this.pointers.has(event.pointerId)) { if (!this.pointers.size) this.updateHover(point); return; }
    event.preventDefault(); const previous = this.gesture;this.pointers.set(event.pointerId, point);const next = this.gestureState();
    const frame = this.getFrame();
    if (previous && next && frame && this.range) {
      if (this.pointers.size === 2 && previous.distance > 0 && next.distance > 0) this.zoomAt(previous.distance / next.distance, previous.center.x, next.center.x);
      else {
        const shifted = this.shift(this.range, -(next.center.x - previous.center.x) / frame.spacing);
        if (shifted) { this.range = shifted; this.followingLatest = false;this.frame = null;this.schedule(); }
      }
    }
    this.gesture = next;
  };
  private onOutsidePointerMove = (event: PointerEvent) => {
    // Canvas events have already been handled before bubbling here.
    if (!this.destroyed && event.target !== this.canvas && this.pointers.has(event.pointerId)) this.onPointerMove(event);
  };
  private onOutsidePointerCancel = (event: PointerEvent) => {
    if (!this.destroyed && this.pointers.has(event.pointerId)) this.onPointerCancel();
  };
  private onWindowBlur = () => { if (!this.destroyed) { this.cancelGesture(); this.clearHover(); } };
  private onPointerUp = (event: PointerEvent) => {
    if (this.destroyed || !this.pointers.has(event.pointerId)) return;
    this.pointers.delete(event.pointerId);this.gesture = this.gestureState();
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  private onPointerCancel = () => { if (!this.destroyed) { this.cancelGesture();this.clearHover(); } };
  private onLostCapture = (event: PointerEvent) => { if (!this.destroyed && this.pointers.has(event.pointerId)) this.cancelGesture(); };
  private onWheel = (event: WheelEvent) => {
    if (this.destroyed) return;
    const point = this.point(event), frame = this.getFrame();
    if (!point || !this.inside(point, frame) || !Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX)
      || (event.deltaY === 0 && event.deltaX === 0)) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const raw = horizontal ? event.deltaX : event.deltaY;
    const pixels = raw * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (horizontal ? frame!.plot.width : frame!.plot.height) : 1);
    const revision = ++this.mutationRevision;
    event.preventDefault();this.cancelGesture();this.clearHover();if (this.destroyed || revision !== this.mutationRevision) return;
    if (horizontal && this.range) {
      const next = this.shift(this.range, pixels / frame!.spacing);
      if (next) { this.range = next;this.followingLatest = false;this.frame = null;this.schedule(); }
    } else this.zoomAt(Math.exp(clamp(pixels * .002, -.65, .65)), point.x);
  };
  private onKeyDown = (event: KeyboardEvent) => {
    if (this.destroyed || event.target !== this.canvas || this.canvas.ownerDocument.activeElement !== this.canvas
      || this.canvas.isContentEditable || this.canvas.getAttribute("contenteditable") === "true"
      || event.ctrlKey || event.metaKey || event.altKey || !this.range) return;
    if (event.key === "Home") this.fit();
    else if (event.key === "End") this.goLatest();
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const next = panChartWindow(this.range, event.key === "ArrowLeft" ? -.2 : .2, this.series.candles.length);if (next) this.setRange(next);
    } else if (["+", "=", "-", "_"].includes(event.key)) {
      const next = zoomChartWindow(this.range, event.key === "+" || event.key === "=" ? .8 : 1.25, this.series.candles.length);if (next) this.setRange(next);
    } else return;
    event.preventDefault();
  };
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;this.generation++;this.mutationRevision++;this.cancelGesture();this.clearHover();
    if (this.raf != null) cancelAnimationFrame(this.raf);this.raf = null;
    this.observer?.disconnect();this.observer = null;this.media?.removeEventListener("change", this.onDprChange);this.media = null;
    this.listeners.forEach(remove => remove());this.listeners = [];
    this.frame = null;this.range = null;this.series = prepareNativePriceSeries([]);this.studies.setStudies([],[]);this.referencePrice = null;this.referenceSet = false;this.canvas.remove();
  }
}
