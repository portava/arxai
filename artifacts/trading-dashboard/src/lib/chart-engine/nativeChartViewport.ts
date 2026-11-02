import { scaleNativePriceRange, type NativePriceRange, updateNativePriceSeries, prepareNativePriceSeries, createNativePriceFrame, paintNativePriceLayer, type NativePriceFrame } from "./nativePriceRenderer";
import { nativePlotLayout, paintNativeAxes } from "./nativeChartAxes";
import { panChartWindow, zoomChartWindow, type LogicalWindow } from "./chartNavigation";
import { candleDisplayPrecision, historyRangeShift, sameCandle } from "./candleReconciliation";
import { CHART_STYLES, validatePreferences, validateDrawings, type ChartAnchor, type ChartDrawing, type ChartStyle, type ChartScaleMode } from "./chartWorkspace";
import { effectiveDisplayZone, isChartTimeZone, type ChartTimeZone } from "./chartTimeZone";
import type { ChartEngineCandle, ChartStructureLine, ChartStructureMarker } from "./types";
import type { ChartOverlay } from "../chart-overlays";
import type { SmartChartAnnotation } from "./smartChartAnnotationCanvas";
import { NativeScannerOverlays, paintScannerPriceLines } from "./nativeScannerOverlays";
import { NativeChartOverlayLayers } from "./nativeChartOverlayLayers";
import type { ChartStudy } from "./chartStudies";
import { NativeChartStudies, layoutNativeStudyPanes, paintNativeStudies } from "./nativeChartStudies";

import { candleIndex, ChartDrawingEditor, type DrawingInteraction } from "./chartDrawingEditor";
import { drawingStrokes, drawingNotes, drawingHandles, paintChartDrawings, type PixelPoint } from "./chartDrawingCanvas";

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
  /** User-origin pan/zoom only. Programmatic/data/link updates never echo. */
  onUserRangeChange?: (range: Readonly<LogicalWindow>) => void;
}
interface Point { x: number; y: number }
interface Gesture { center: Point; distance: number }
// Resource ceilings, not market policy. Effective DPR is exposed to callers.
const MAX_CSS_SIDE = 16_384, MAX_BACKING_SIDE = 8_192, MAX_BACKING_PIXELS = 16_777_216;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** ARX DOM/Canvas controller. The adapter and shell retain feed/source
 * qualification, replay boundaries and cross-view policy; no execution API. */
export class NativeChartViewport {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: NativeChartViewportOptions;
  private requestedHeight: number | undefined;
  private series = prepareNativePriceSeries([]);
  private readonly studies = new NativeChartStudies();
  private priceOnlyScale = false;
  private analysisFocused = false;
  private readonly overlayLayers = new NativeChartOverlayLayers();
  private readonly scannerOverlays: NativeScannerOverlays;
  private drawingEditor: ChartDrawingEditor;
  private drawings: ChartDrawing[] = [];
  private selectedDrawing: string | null = null;
  private drawingInteraction: DrawingInteraction | null = null;
  private drawingHandler: ((anchor: ChartAnchor) => void) | null = null;
  private drawingNavigationMode: "inspect" | "pan" = "inspect";
  private frozenDrawingFrame: NativePriceFrame | null = null;
  private editAnchorTimes: number[] = [];

  private range: LogicalWindow | null = null;
  private frame: NativePriceFrame | null = null;
  private referencePrice: number | null = null;
  private referenceSet = false;
  private style: ChartStyle = "candles";
  private scale: ChartScaleMode = "linear";
  private inverted = false;
  private timeZone: ChartTimeZone = "UTC";
  private utcClockQualified = false;
  private timeframe = "M1";
  private priceDigits = 2;
  private symbol = "";
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private followingLatest = true;
  private destroyed = false;
  private generation = 0;
  private mutationRevision = 0;
  private raf: number | null = null;
  private drawCount = 0;
  // Presentation proof belongs to a completed paint of the latest request,
  // never merely a queued focus change. This does not qualify source evidence.
  private paintRevision = 0;
  private paintedRevision = -1;
  private paintError: string | null = null;
  private frameIssue: string | null = null;
  private callbackError: string | null = null;
  private hover: NativeCrosshair | null = null;
  private inspectionPinned = false;
  private linkedCrosshairTime: number | null = null;
  private livePriceAffordance = false;
  private pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private manualPriceRange: NativePriceRange | null = null;
  private timeAxisGesture: {pointerId:number; x:number; lastX:number; width:number; fraction:number; span:number; anchorTime:number; offset:number} | null = null;
  private priceAxisGesture: {pointerId:number; y:number; height:number; range:NativePriceRange; scale:ChartScaleMode} | null = null;
  private observer: ResizeObserver | null = null;
  private media: MediaQueryList | null = null;
  private listeners: Array<() => void> = [];

  constructor(private readonly container: HTMLElement, options: NativeChartViewportOptions = {}) {
    this.options = { ...options };
    this.requestedHeight = options.height;
    if (options.style && CHART_STYLES.includes(options.style)) this.style = options.style;
    if (options.scale && ["linear", "log", "percent", "indexed"].includes(options.scale)) this.scale = options.scale;
    this.inverted = options.inverted === true;
    if (isChartTimeZone(options.timeZone)) this.timeZone = options.timeZone;
    this.timeframe = options.timeframe ?? "M1";this.studies.setTimeframe(this.timeframe);
    this.canvas = container.ownerDocument.createElement("canvas");
    this.canvas.dataset.arxNativeViewport = "true";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "region");
    this.canvas.setAttribute("aria-label", "ARX price chart. Drag to pan, scroll or pinch to zoom. Arrow keys pan. Shift plus Left/Right inspects adjacent loaded candles, Shift plus Home/End inspects first/last loaded candle, Enter pins inspection, Escape releases it. Plus and minus zoom, Home fits history, End returns to latest. Drag the price axis vertically to scale prices; double-click it to restore automatic price scale. Drag the bottom time axis right to increase candle spacing, left to decrease it; double-click to restore the default time span.");
    this.canvas.style.touchAction = "none";
    this.canvas.style.display = "block";
    this.canvas.width = 0;this.canvas.height = 0;
    this.canvas.style.width = "0px";this.canvas.style.height = "0px";
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable");
    this.context = context;
    container.appendChild(this.canvas);
    this.scannerOverlays = new NativeScannerOverlays({container:this.canvas,
      getFrame:()=>this.getFrame(),getSize:()=>({width:this.width,height:this.height}),invalidate:()=>this.schedule()});
    // Run before the drawing editor's capture listener: a second pointer on
    // the axis must not cancel an existing drawing and then acquire its scale.
    this.canvas.addEventListener("pointerdown", this.onAxisPointerConflict, true);
    this.listeners.push(() => this.canvas.removeEventListener("pointerdown", this.onAxisPointerConflict, true));
    this.drawingEditor = new ChartDrawingEditor(this.canvas, {
      candles: () => this.series.candles as ChartEngineCandle[],
      project: (anchor, priceOnly) => this.projectDrawing(anchor, priceOnly),
      anchor: (point, snap) => this.drawingAnchor(point, snap),
      price: y => { const frame = this.getFrame(); return frame?.yToPrice(y + frame.plot.top) ?? null; },
      size: () => { const plot = this.getFrame()?.plot; return { width: plot?.width ?? 0, height: plot?.height ?? 0 }; },
      eventPoint: event => {
        const point = this.point(event), plot = this.getFrame()?.plot;
        return point && plot ? {x: point.x - plot.left, y: point.y - plot.top} : null;
      },
      render: drawings => { if (!this.destroyed) { this.drawings = this.cloneDrawings(drawings); this.schedule(); } },
      select: id => { if (!this.destroyed) { this.selectedDrawing = id; this.schedule(); } },
      freeze: active => {
        if (active) {
          this.cancelGesture(); this.frozenDrawingFrame = this.getFrame();
          const drawing = this.drawings.find(row=>row.id===this.selectedDrawing);
          this.editAnchorTimes = drawing && drawing.kind!=="horizontal"
            ? [drawing.start, ...(drawing.end?[drawing.end]:[]), ...(drawing.offset?[drawing.offset]:[])].map(anchor=>anchor.time) : [];
          this.clearHover();
        } else { this.frozenDrawingFrame = null; this.editAnchorTimes=[]; this.invalidate(); }
      },
    });
    const listen = (type: string, handler: EventListener, options?: AddEventListenerOptions) => {
      this.canvas.addEventListener(type, handler, options);
      this.listeners.push(() => this.canvas.removeEventListener(type, handler, options));
    };
    listen("dblclick", this.onAxisDoubleClick as EventListener);
    listen("pointerdown", this.onPointerDown as EventListener);
    listen("pointermove", this.onPointerMove as EventListener);
    listen("pointerup", this.onPointerUp as EventListener);
    listen("pointercancel", this.onPointerCancel as EventListener);
    listen("lostpointercapture", this.onLostCapture as EventListener);
    listen("pointerleave", (() => { if (!this.pointers.size && !this.inspectionPinned) this.clearHover(); }) as EventListener);
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
    // The canvas occupies the content box. Feeding the bordered host's full
    // width back into its child grows auto-sized grid tracks on every observer
    // delivery. Explicit dimensions remain drawing CSS dimensions.
    const computed = this.container.ownerDocument.defaultView?.getComputedStyle(this.container);
    const cssPixels = (value: string | undefined) => { const number = Number.parseFloat(value ?? ""); return Number.isFinite(number) ? number : 0; };
    const insetX = cssPixels(computed?.borderLeftWidth) + cssPixels(computed?.borderRightWidth) + cssPixels(computed?.paddingLeft) + cssPixels(computed?.paddingRight);
    const insetY = cssPixels(computed?.borderTopWidth) + cssPixels(computed?.borderBottomWidth) + cssPixels(computed?.paddingTop) + cssPixels(computed?.paddingBottom);
    const w = width ?? Math.max(0, bounds.width - insetX), h = height ?? this.requestedHeight ?? Math.max(0, bounds.height - insetY);
    const requestedRatio = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const valid = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= MAX_CSS_SIDE && h <= MAX_CSS_SIDE;
    const nextWidth = valid ? w : 0, nextHeight = valid ? h : 0;
    const ratio = valid ? Math.min(requestedRatio, MAX_BACKING_SIDE / w, MAX_BACKING_SIDE / h, Math.sqrt(MAX_BACKING_PIXELS / (w * h))) : 1;
    if (nextWidth !== this.width || nextHeight !== this.height || ratio !== this.pixelRatio) {
      this.drawingEditor.cancelGesture(); this.cancelGesture(); this.clearHover();
      if (this.destroyed || revision !== this.mutationRevision) return;
      this.width = nextWidth; this.height = nextHeight; this.pixelRatio = ratio;
      this.canvas.width = Math.floor(this.width * ratio); this.canvas.height = Math.floor(this.height * ratio);
      this.canvas.style.width = `${this.width}px`; this.canvas.style.height = `${this.height}px`;
      this.invalidate();
    }
    // Responsive callers own the latest explicit height. Observer/DPR events
    // must not reinstate the constructor height (or a superseded resize).
    if (height !== undefined) this.requestedHeight = height;
    this.watchDpr();
  }

  setCandles(candles: readonly ChartEngineCandle[]): void {
    if (this.destroyed) return;
    const revision = ++this.mutationRevision;
    const previous = this.series.candles;
    let previousHover = this.hover;
    const next = prepareNativePriceSeries(candles);
    const times = new Set(next.candles.map(candle => candle.time));
    const overlap = previous.some(candle => times.has(candle.time));
    const selected = this.drawings.find(drawing => drawing.id === this.selectedDrawing);
    const anchors = selected ? [selected.start, ...(selected.end ? [selected.end] : []), ...(selected.offset ? [selected.offset] : [])] : [];
    if (!next.candles.length || (previous.length && !overlap) || (selected?.kind !== "horizontal" && anchors.some(anchor => !times.has(anchor.time))) || this.editAnchorTimes.some(time=>!times.has(time))) this.drawingEditor.cancelGesture();
    // Withdrawal precedes replacement so a callback that changes context or
    // display state can supersede this old source mutation.
    if (previousHover && !times.has(previousHover.candle.time)) { this.clearHover(); previousHover = null; }
    if (this.destroyed || revision !== this.mutationRevision) return; this.series = next;
    this.studies.setCandles(next.candles);
    if (!this.referenceSet && next.candles.length) {
      // Preserve the exact first canonical close, including invalid-for-percent
      // zero/negative references. Never substitute a later positive observation.
      this.referencePrice = next.candles[0]!.close; this.referenceSet = true;
    }
    this.priceDigits = Number.isInteger(this.options.priceDigits) && this.options.priceDigits! >= 0 && this.options.priceDigits! <= 16
      ? this.options.priceDigits! : candleDisplayPrecision(next.candles,this.symbol);
    // A refresh, append, prepend or rolling window retains the CSS pointer
    // baseline: historyRangeShift rebases its logical observation below. Empty
    // or disjoint history has no shared anchor and explicitly ends the gesture.
    if (!next.candles.length || (previous.length && !overlap) || (this.timeAxisGesture && !times.has(this.timeAxisGesture.anchorTime))) this.cancelGesture();
    if (!next.candles.length) this.range = null;
    else if ((this.followingLatest && !this.frozenDrawingFrame && !this.timeAxisGesture) || !this.range || !overlap) this.range = this.latestRange(this.range ? this.range.to - this.range.from : undefined);
    else {
      // A time-axis gesture owns one observed timestamp, including when a
      // provider inserts a real missing bar inside previously loaded history.
      const axis = this.timeAxisGesture;
      const shift = axis ? candleIndex(next.candles as ChartEngineCandle[],axis.anchorTime) - candleIndex(previous as ChartEngineCandle[],axis.anchorTime)
        : historyRangeShift(previous, next.candles);
      const desired = {from:this.range.from+shift,to:this.range.to+shift};
      const bounded = panChartWindow(desired,0,next.candles.length);
      // A bounded history trim can move X even when selected anchors survive.
      // Cancel rather than committing an edit against a shifted origin pixel.
      if (this.frozenDrawingFrame && (!bounded || Math.abs(bounded.from-desired.from)>1e-9 || Math.abs(bounded.to-desired.to)>1e-9)) this.drawingEditor.cancelGesture();
      this.range = bounded;
    }
    this.invalidate();
    this.remapHover(previousHover);
  }

  /** Immutable applied source snapshot. No parallel adapter candle cache. */
  getCandles(): readonly ChartEngineCandle[] { return this.series.candles; }
  getVisibleCandles(): ChartEngineCandle[] {
    if (this.destroyed || !this.range) return [];
    return this.series.candles.slice(Math.max(0,Math.ceil(this.range.from)),Math.max(0,Math.floor(this.range.to)+1)).map(bar=>({...bar}));
  }
  getDisplayCandle(time: number): ChartEngineCandle | null {
    if (this.destroyed || this.style!=="heikinAshi" || !Number.isFinite(time)) return null;
    const index=candleIndex(this.series.candles as ChartEngineCandle[],time);
    return index<0 ? null : {...this.series.heikinAshi[index]!};
  }
  getPricePrecision(): number { return this.priceDigits; }
  /** Display precision only. Caller must reset source context separately. */
  setSymbol(symbol: string): void {
    if(this.destroyed||typeof symbol!=="string"||this.symbol===symbol)return;
    this.symbol=symbol;
    this.priceDigits=Number.isInteger(this.options.priceDigits)&&this.options.priceDigits!>=0&&this.options.priceDigits!<=16
      ?this.options.priceDigits!:candleDisplayPrecision(this.series.candles,this.symbol);
    this.schedule();
  }
  setLivePriceAffordance(enabled: boolean): void {
    if (this.destroyed || this.livePriceAffordance===(enabled===true)) return;
    this.livePriceAffordance=enabled===true;this.schedule();
  }
  setLinkedCrosshair(time: number | null): void {
    if (this.destroyed) return;
    const next=typeof time==="number" && Number.isFinite(time) && time>0 ? time : null;
    if(this.linkedCrosshairTime===next && this.hover===null)return;
    // Programmatic inspection owns this display but never emits a user event.
    this.hover=null;this.inspectionPinned=false;this.linkedCrosshairTime=next;this.schedule();
  }
  private linkedCrosshair(frame: NativePriceFrame): NativeCrosshair | null {
    if(this.linkedCrosshairTime===null)return null;
    const index=candleIndex(this.series.candles as ChartEngineCandle[],this.linkedCrosshairTime);
    if(index<0)return null;
    const candle=this.series.candles[index]!,x=frame.timeToX(candle.time),y=frame.priceToY(candle.close);
    if(x===null||y===null||x<frame.plot.left||x>frame.plot.left+frame.plot.width||y<frame.plot.top||y>frame.plot.top+frame.plot.height)return null;
    return {candle,x,y,price:candle.close};
  }
  /** Tail-only data revision. Does not authorize live-price presentation. */
  updateActiveCandle(candle: ChartEngineCandle): boolean {
    if(this.destroyed)return false;
    const next=updateNativePriceSeries(this.series,candle);
    if(!next)return false;
    const revision=++this.mutationRevision,previousHover=this.hover;
    this.series=next;
    // Both helpers use the same canonical validation. A full reinstall is only
    // a recovery for an independently replaced study history, never the normal tip path.
    if(!this.studies.updateActiveCandle(next.candles.at(-1)!))this.studies.setCandles(next.candles);
    if(!this.referenceSet&&next.candles.length){this.referencePrice=next.candles[0]!.close;this.referenceSet=true;}
    this.priceDigits=Number.isInteger(this.options.priceDigits)&&this.options.priceDigits!>=0&&this.options.priceDigits!<=16
      ?this.options.priceDigits!:candleDisplayPrecision(next.candles,this.symbol);
    if(!this.range||(this.followingLatest&&!this.frozenDrawingFrame&&!this.timeAxisGesture))this.range=this.latestRange(this.range?this.range.to-this.range.from:undefined);
    this.invalidate();
    this.remapHover(previousHover);
    return !this.destroyed&&revision===this.mutationRevision;
  }

  private remapHover(previousHover: NativeCrosshair | null): void {
    if (!previousHover || this.destroyed) return;
    // Data reconciliation is not a pointer leave. Preserve only the exact
    // observed timestamp; never move inspection to a neighboring bar.
    const frame = this.getFrame(), index = candleIndex(this.series.candles as ChartEngineCandle[], previousHover.candle.time);
    const candle = index < 0 ? null : this.series.candles[index]!, x = candle && frame ? frame.timeToX(candle.time) : null;
    if (frame && candle && x !== null && x >= frame.plot.left && x <= frame.plot.left + frame.plot.width) {
      const projectedY=this.inspectionPinned?frame.priceToY(candle.close):previousHover.y;
      if(projectedY==null){this.clearHover();return;}
      const y=this.inspectionPinned?clamp(projectedY,frame.plot.top,frame.plot.top+frame.plot.height):previousHover.y;
      this.hover = Object.freeze({candle, x, y, price: this.inspectionPinned?candle.close:y >= frame.plot.top && y <= frame.plot.top + frame.plot.height ? frame.yToPrice(y) : null});
      // Full source snapshots clone rows. Reference inequality alone must not
      // broadcast a new user inspection when the canonical evidence is equal.
      if (!sameCandle(candle, previousHover.candle)) this.notify("crosshair", () => this.options.onCrosshair?.(this.hover));
    } else this.clearHover();
  }

  private latestRange(span = this.options.visibleBars ?? 100): LogicalWindow | null {
    const count = this.series.candles.length;
    const width = Number.isFinite(span) && span > 0 ? span : 100;
    return panChartWindow({ from: count + 1 - width, to: count + 1 }, 0, count);
  }
  private cloneDrawings(drawings: readonly ChartDrawing[]): ChartDrawing[] {
    const seen = new Set<string>();
    // Preserve unsaved previews beyond the saved-object limit, as the current
    // registered adapter does. Validation clones anchors and source evidence.
    return drawings.flatMap(row => validateDrawings([row])).filter(row => {
      if (seen.has(row.id)) return false; seen.add(row.id); return true;
    });
  }
  setDrawings(drawings: readonly ChartDrawing[]): void {
    if (this.destroyed) return;
    this.drawingEditor.cancelGesture();
    this.drawings = this.cloneDrawings(drawings);
    this.drawingEditor.setDrawings(this.drawings); this.schedule();
  }
  getDrawings(): ChartDrawing[] { return this.cloneDrawings(this.drawings); }
  setDrawingInteraction(config: DrawingInteraction | null): void {
    if (this.destroyed) return;
    this.drawingInteraction = config ? {...config,
      onSelect: id => this.notify("drawing selection", () => config.onSelect(id)),
      onCommit: next => {
        this.drawings = this.cloneDrawings(next);this.schedule();
        this.notify("drawing commit", () => config.onCommit(this.cloneDrawings(next)));
      },
    } : null;
    this.drawingEditor.configure(this.analysisFocused || this.drawingNavigationMode === "pan" ? null : this.drawingInteraction);
  }
  setDrawingHandler(handler: ((anchor: ChartAnchor) => void) | null): void {
    if (this.destroyed) return;
    this.drawingHandler = handler;this.applyDrawingPlacement();
  }
  setNavigationMode(mode: "inspect" | "pan"): void {
    if (this.destroyed || (mode !== "inspect" && mode !== "pan")) return;
    this.drawingNavigationMode = mode;
    this.drawingEditor.configure(this.analysisFocused || mode === "pan" ? null : this.drawingInteraction);
    this.applyDrawingPlacement();
  }
  private activeDrawingPlacement() { return !this.analysisFocused && this.drawingNavigationMode !== "pan" && this.drawingHandler !== null; }
  private applyDrawingPlacement() {
    this.cancelGesture();this.clearHover();
    const handler = this.activeDrawingPlacement() ? this.drawingHandler : null;
    this.drawingEditor.setPlacement(handler ? anchor => this.notify("drawing placement", () => handler(anchor)) : null);
    this.canvas.style.cursor = this.drawingNavigationMode === "pan" ? "grab" : handler ? "crosshair" : "";
  }
  private projectDrawing(anchor: ChartAnchor, priceOnly = false): PixelPoint | null {
    const frame = this.getFrame(); if (!frame) return null;
    const x = priceOnly ? frame.plot.left : frame.timeToX(anchor.time), y = frame.priceToY(anchor.price);
    return x == null || y == null ? null : { x: x - frame.plot.left, y: y - frame.plot.top };
  }
  private drawingAnchor(point: PixelPoint, snap: boolean): ChartAnchor | null {
    const frame = this.getFrame(); if (!frame || point.x < 0 || point.y < 0 || point.x > frame.plot.width || point.y > frame.plot.height) return null;
    const x = point.x + frame.plot.left, y = point.y + frame.plot.top, candle = frame.barAtX(x);
    let price = frame.yToPrice(y);
    if (!candle || price == null || price <= 0 || !Number.isFinite(price)) return null;
    if (snap) price = [candle.open,candle.high,candle.low,candle.close].reduce((best,value) => {
      const a = frame.priceToY(value), b = frame.priceToY(best);
      return a != null && b != null && Math.abs(a-y) < Math.abs(b-y) ? value : best;
    });
    return {time:candle.time,price};
  }
  private paintDrawings(ctx: CanvasRenderingContext2D, frame: NativePriceFrame) {
    if (!this.drawings.length) return;
    const {width,height,left,top} = frame.plot;
    const project = (anchor: ChartAnchor, priceOnly?: boolean) => this.projectDrawing(anchor,priceOnly);
    const strokes = drawingStrokes(this.drawings,project,width,height);
    const notes = drawingNotes(this.drawings,project,width,height);
    const selected = this.drawings.find(drawing => drawing.id === this.selectedDrawing && !drawing.hidden && !drawing.locked);
    const handles = selected ? drawingHandles(selected,project,width,height).map(handle => handle.point) : [];
    ctx.save();
    try { ctx.translate(left,top);paintChartDrawings(ctx,{width,height},strokes,notes,handles); }
    finally { ctx.restore(); }
    // Price-only levels retain their raw price label, including on percent or
    // indexed axes. The gutter is clipped so labels cannot cover another pane.
    ctx.save();
    try {
      ctx.beginPath();ctx.rect(left+width,top,this.width-left-width,height);ctx.clip();
      ctx.font="10px sans-serif";ctx.textBaseline="middle";ctx.textAlign="left";
      for (const drawing of this.drawings) {
        if (drawing.hidden || drawing.kind!=="horizontal") continue;
        const y=frame.priceToY(drawing.start.price);
        if(y==null||y<top||y>top+height)continue;
        ctx.fillStyle=drawing.color;ctx.fillRect(left+width,y-8,this.width-left-width,16);
        ctx.fillStyle="#09090b";
        let label=drawing.start.price.toFixed(this.priceDigits);
        if(Number(label)===0&&drawing.start.price!==0)label=String(drawing.start.price);
        ctx.fillText(label,left+width+3,y,this.width-left-width-6);
      }
    } finally {ctx.restore();}
  }
  setStructureLines(lines: readonly ChartStructureLine[], markers: readonly ChartStructureMarker[]): void {
    if (this.destroyed) return;
    this.overlayLayers.setStructureLines(lines,markers);this.schedule();
  }
  setSmartAnnotation(annotation: SmartChartAnnotation | null): void {
    if (this.destroyed) return;
    this.overlayLayers.setSmartAnnotation(annotation);this.schedule();
  }
  setOverlays(overlays: readonly ChartOverlay[], latestBarTime: number | null): void {
    if (this.destroyed) return;
    this.overlayLayers.setOverlays(overlays,latestBarTime);this.schedule();
  }
  getScannerOverlaySurface() { return this.destroyed ? null : this.scannerOverlays.getSurface(); }
  isAnalysisFocused(): boolean { return this.analysisFocused; }
  isAnalysisFocusVerified(): boolean {
    return !this.destroyed && !this.paintError && this.raf === null
      && this.paintedRevision === this.paintRevision;
  }
  setAnalysisFocus(enabled: boolean): void {
    if (this.destroyed || this.analysisFocused===enabled) return;
    const revision=++this.mutationRevision;
    this.drawingEditor.cancelGesture();this.cancelGesture();this.clearHover();
    if(this.destroyed||revision!==this.mutationRevision)return;
    this.analysisFocused=enabled;
    this.drawingEditor.configure(enabled || this.drawingNavigationMode==="pan" ? null : this.drawingInteraction);
    this.applyDrawingPlacement();this.invalidate();
  }
  getRange(): Readonly<LogicalWindow> | null { return this.range ? Object.freeze({ ...this.range }) : null; }
  getPaneLayout() {
    const full = nativePlotLayout(this.width, this.height);
    return full ? layoutNativeStudyPanes(full, this.analysisFocused ? 0 : this.studies.paneCount, this.analysisFocused?[]:this.studies.getPaneWeights()) : null;
  }
  setStudies(configs: ChartStudy[]): void {
    if (this.destroyed) return;
    const valid=validatePreferences({studies:configs}).studies;
    const plotInputs=(studies:readonly ChartStudy[])=>JSON.stringify(studies.map(({showInDataWindow:_readout,...plot})=>plot));
    const readoutOnly=plotInputs(valid)===plotInputs(this.studies.getStudies());
    const revision = ++this.mutationRevision;
    if(!readoutOnly){
      this.drawingEditor.cancelGesture();this.cancelGesture();this.clearHover();
      if(this.destroyed || revision!==this.mutationRevision)return;
    }
    this.studies.setStudies(valid, this.series.candles);this.invalidate();
  }
  getStudies(): readonly Readonly<ChartStudy>[] { return this.studies.getStudies(); }
  getStudyValues(time: number) { return this.analysisFocused ? [] : this.studies.getValues(time); }
  getVolumeProfiles() { return this.analysisFocused ? [] : this.studies.getProfiles(); }
  setPriceOnlyScale(enabled: boolean): void {
    if(this.destroyed || this.priceOnlyScale===enabled)return;
    const revision=++this.mutationRevision;
    this.drawingEditor.cancelGesture();this.cancelGesture();this.clearHover();if(this.destroyed||revision!==this.mutationRevision)return;
    this.priceOnlyScale=enabled;this.manualPriceRange=null;this.invalidate();
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
      inverted: this.inverted, referencePrice: this.referencePrice ?? undefined, priceRange: this.manualPriceRange ?? undefined,
      additionalPriceValues: this.priceOnlyScale || this.analysisFocused ? [] : this.studies.getPriceBounds(this.range, this.scale) });
    this.frame = result.ok ? result.frame : null;
    // Incoming observations remain current during an edit, but the price axis
    // stays where the pointer gesture began. Time mapping rebases on actual
    // timestamps when history is prepended; no invented weekend bars.
    if (this.frame && this.frozenDrawingFrame) this.frame = Object.freeze({ ...this.frame,
      priceToY: this.frozenDrawingFrame.priceToY, yToPrice: this.frozenDrawingFrame.yToPrice });
    this.frameIssue = result.ok ? null : result.reason;
    return this.frame;
  }
  getState() {
    const frame = this.getFrame();
    return Object.freeze({ status: this.destroyed ? "destroyed" : this.paintError ? "error" : !this.series.candles.length ? "empty" : frame ? "ready" : "unavailable",
      error: this.paintError ?? this.frameIssue, callbackError: this.callbackError, referencePrice: this.referencePrice, style: this.style, scale: this.scale, inverted: this.inverted,
      timeZone: this.timeZone, utcClockQualified: this.utcClockQualified, effectiveTimeZone: this.utcClockQualified ? effectiveDisplayZone(this.timeZone, this.timeframe) : "UTC", timeframe: this.timeframe,
      barCount: this.series.candles.length, discarded: this.series.discarded, range: this.getRange(), followingLatest: this.followingLatest,
      manualPriceRange: this.manualPriceRange ? Object.freeze({...this.manualPriceRange}) : null, priceAxisDragging: this.priceAxisGesture !== null, timeAxisDragging: this.timeAxisGesture !== null,
      inspectionPinned:this.inspectionPinned,inspectionTime:this.hover?.candle.time??null,
      livePriceAffordance: this.livePriceAffordance, linkedCrosshairTime: this.linkedCrosshairTime,
      drawingCount: this.drawings.length, selectedDrawing: this.selectedDrawing, editingDrawing: this.frozenDrawingFrame !== null,
      analysisFocused: this.analysisFocused, overlayLayers: this.overlayLayers.getState(), scannerOverlays: this.scannerOverlays.getState(),
      paneCount: this.analysisFocused ? 0 : this.studies.paneCount, priceOnlyScale: this.priceOnlyScale,
      width: this.width, height: this.height, pixelRatio: this.pixelRatio, pendingPaint: this.raf != null, drawCount: this.drawCount, paintCount: this.drawCount });
  }
  setRange(range: LogicalWindow): void {
    if (this.destroyed) return;
    const bounded = panChartWindow(range, 0, this.series.candles.length);
    if (!bounded) return;
    const revision = ++this.mutationRevision;
    this.drawingEditor.cancelGesture(); this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.range = bounded; this.followingLatest = false; this.invalidate();
  }
  fit(): void { if (!this.destroyed) this.setRange({ from: -1, to: this.series.candles.length }); }
  goLatest(): void {
    if (this.destroyed) return;
    const revision = ++this.mutationRevision;
    this.drawingEditor.cancelGesture(); this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.range = this.latestRange(this.range ? this.range.to - this.range.from : undefined);
    this.followingLatest = true; this.invalidate();
  }
  setStyle(style: ChartStyle): void {
    if (!this.destroyed && CHART_STYLES.includes(style) && style !== this.style) {
      const revision = ++this.mutationRevision;
      this.drawingEditor.cancelGesture(); this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.scannerOverlays.reset(); this.manualPriceRange=null; this.style = style; this.invalidate();
    }
  }
  setScale(scale: ChartScaleMode, inverted = this.inverted): void {
    if (this.destroyed || !["linear", "log", "percent", "indexed"].includes(scale)) return;
    const revision = ++this.mutationRevision;
    this.drawingEditor.cancelGesture(); this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; if(this.scale!==scale || this.inverted!==inverted)this.manualPriceRange=null; this.scale = scale; this.inverted = inverted; this.invalidate();
  }
  /** Presentation evidence supplied by the existing source-qualified shell. */
  setSourceClockQualified(qualified: boolean): void {
    const next = qualified === true;
    if (this.destroyed || next === this.utcClockQualified) return;
    ++this.mutationRevision;
    this.utcClockQualified = next; this.invalidate();
  }
  setDisplayTimeZone(zone: ChartTimeZone, timeframe = this.timeframe): void {
    if (this.destroyed || !isChartTimeZone(zone)) return;
    const revision=++this.mutationRevision;
    if(timeframe!==this.timeframe){
      this.drawingEditor.cancelGesture();this.cancelGesture();this.clearHover();
      if(this.destroyed||revision!==this.mutationRevision)return;
    }
    this.timeZone = zone; this.timeframe = timeframe;this.studies.setTimeframe(timeframe);this.invalidate();
  }
  resetContext(): void {
    if (this.destroyed) return;
    const revision = ++this.mutationRevision;
    this.drawingEditor.cancelGesture(); this.cancelGesture(); this.clearHover(); if (this.destroyed || revision !== this.mutationRevision) return; this.generation++;
    if (this.raf != null) cancelAnimationFrame(this.raf); this.raf = null;
    this.series = prepareNativePriceSeries([]); this.range = null; this.referencePrice = null; this.referenceSet = false;
    this.drawingEditor.configure(null); this.drawingEditor.setPlacement(null); this.drawingEditor.setDrawings([]);
    this.drawings = []; this.selectedDrawing = null; this.drawingInteraction = null; this.drawingHandler = null;
    this.frozenDrawingFrame = null;this.editAnchorTimes=[];
    this.overlayLayers.reset();this.scannerOverlays.reset();
    this.livePriceAffordance=false;this.linkedCrosshairTime=null;this.utcClockQualified=false;this.manualPriceRange=null;
    this.studies.reset();
    this.followingLatest = true; this.invalidate();
  }
  private invalidate() { this.frame = null; this.paintError = null; this.schedule(); }
  private schedule() {
    if (this.destroyed) return;
    ++this.paintRevision;
    if (this.raf != null) return;
    const generation = this.generation;
    const id = requestAnimationFrame(() => {
      if (this.destroyed || generation !== this.generation || this.raf !== id) return;
      this.raf = null; this.paint();
    });
    this.raf = id;
  }
  private paint() {
    if (this.destroyed) return;
    const revision = this.paintRevision;
    try {
      const ctx = this.context;
      ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      const frame = this.getFrame();
      if (frame) {
        const layout = this.getPaneLayout()!, last = layout.panes.at(-1) ?? layout.price;
        const chartBottom = last.top + last.height;
        paintNativeAxes(ctx, frame, { timeZone: effectiveDisplayZone(this.timeZone, this.timeframe), utcClockQualified: this.utcClockQualified, priceDigits: this.priceDigits, timeAxisBottom:chartBottom });
        paintNativePriceLayer(ctx, frame);
        if (!this.analysisFocused) {
          paintNativeStudies(ctx, frame, layout.panes, this.studies);
          this.paintDrawings(ctx, frame);
        }
        this.overlayLayers.paint(ctx,frame,this.width,this.analysisFocused);
        this.scannerOverlays.paint(ctx);
        const lastCandle=this.series.candles.at(-1);
        if(this.livePriceAffordance&&lastCandle)paintScannerPriceLines(ctx,frame,this.width,[{price:lastCandle.close,color:"#60a5fa",lineWidth:1,lineStyle:"dashed",axisLabelVisible:true,title:""}]);
        const crosshair=this.hover ?? this.linkedCrosshair(frame);
        if (crosshair) {
          ctx.save();
          try {
            ctx.beginPath(); ctx.rect(frame.plot.left, frame.plot.top, frame.plot.width, chartBottom-frame.plot.top); ctx.clip();
            ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
            ctx.beginPath();ctx.moveTo(crosshair.x, frame.plot.top);ctx.lineTo(crosshair.x, chartBottom);
            ctx.moveTo(frame.plot.left, crosshair.y);ctx.lineTo(frame.plot.left + frame.plot.width, crosshair.y);ctx.stroke();
          } finally { ctx.restore(); }
        }
      }
      this.drawCount++;
      // Publish before callbacks: a callback may enqueue another request or
      // reset this context, which must immediately revoke this paint's proof.
      this.paintedRevision = frame ? revision : -1;
      this.notify("viewport", () => this.options.onViewportChange?.());
    } catch (error) {
      this.paintedRevision = -1;
      this.frame = null; this.paintError = error instanceof Error ? error.message : "Price layer paint failed";
      try { this.context.clearRect(0, 0, this.width, this.height); } catch { /* preserve the original paint failure */ }
      // Notify presentation subscribers of withdrawal just as on completion.
      // This emits state only: it must not schedule an automatic retry loop.
      this.notify("viewport", () => this.options.onViewportChange?.());
    }
  }
  exportImage(): string | null {
    if (this.destroyed) return null;
    if (this.raf != null) { cancelAnimationFrame(this.raf); this.raf = null; this.paint(); }
    // A completion listener may synchronously replace the context or request
    // a different view. Never encode pixels from the superseded revision.
    if (!this.isAnalysisFocusVerified() || !this.getFrame()) return null;
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
  private clearHover() { this.inspectionPinned=false; if (this.hover) { this.hover = null; this.notify("crosshair", () => this.options.onCrosshair?.(null)); this.schedule(); } }
  private updateHover(point: Point) {
    if(this.inspectionPinned)return;
    // User inspection takes ownership; a previous remote cursor must not
    // reappear after this local pointer subsequently leaves the chart.
    if(this.linkedCrosshairTime!==null){this.linkedCrosshairTime=null;this.schedule();}
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
    const ids = [...this.pointers.keys()]; this.pointers.clear(); this.gesture = null; this.priceAxisGesture=null;this.timeAxisGesture=null;
    for (const id of ids) { try { this.canvas.releasePointerCapture(id); } catch { /* unavailable or already lost */ } }
  }
  private insidePriceAxis(point: Point, frame = this.getFrame()): boolean {
    return !!frame && point.x > frame.plot.left + frame.plot.width && point.x <= this.width
      && point.y >= frame.plot.top && point.y <= frame.plot.top + frame.plot.height;
  }
  private insideTimeAxis(point: Point, frame = this.getFrame()): boolean {
    const layout=frame?this.getPaneLayout():null,last=layout?.panes.at(-1)??layout?.price;
    return !!frame && !!last && point.x>=frame.plot.left && point.x<=frame.plot.left+frame.plot.width
      && point.y>last.top+last.height && point.y<=this.height;
  }
  /** Horizontal default span about the current midpoint; price bounds unchanged. */
  resetTimeScale(): void {
    if(this.destroyed||!this.range)return;
    const requested=this.options.visibleBars,span=Number.isFinite(requested)&&requested!>0?requested!:100;
    const center=this.range.from/2+this.range.to/2;
    const next=panChartWindow({from:center-span/2,to:center+span/2},0,this.series.candles.length);
    if(next)this.setRange(next);
  }
  /** Restore vertical auto-fit only; horizontal observation window is retained. */
  resetPriceScale(): void {
    if (this.destroyed || (!this.manualPriceRange && !this.priceAxisGesture)) return;
    const revision=++this.mutationRevision;
    this.drawingEditor.cancelGesture();this.cancelGesture();this.clearHover();
    if(this.destroyed || revision!==this.mutationRevision)return;
    this.manualPriceRange=null;this.invalidate();
  }
  private onAxisDoubleClick = (event: MouseEvent) => {
    if(this.destroyed || this.frozenDrawingFrame || this.activeDrawingPlacement() || event.defaultPrevented || event.button!==0)return;
    const point=this.point(event);if(!point)return;
    if(this.insidePriceAxis(point)){event.preventDefault();this.resetPriceScale();return;}
    if(!this.insideTimeAxis(point))return;
    const before=this.range,revision=this.mutationRevision,generation=this.generation;
    event.preventDefault();this.resetTimeScale();
    if(!this.destroyed&&generation===this.generation&&this.mutationRevision===revision+1)this.emitUserRange(before);
  };
  private onAxisPointerConflict = (event: PointerEvent) => {
    if(this.destroyed)return;
    const point=this.point(event);
    if(this.priceAxisGesture || this.timeAxisGesture || (this.frozenDrawingFrame && point && (this.insidePriceAxis(point)||this.insideTimeAxis(point)))){
      event.preventDefault();event.stopImmediatePropagation();
    }
  };
  private onPointerDown = (event: PointerEvent) => {
    if (this.destroyed || this.frozenDrawingFrame || this.activeDrawingPlacement() || this.priceAxisGesture || this.timeAxisGesture || event.defaultPrevented || event.button !== 0 || this.pointers.size >= 2) return;
    const point = this.point(event),frame=this.getFrame(); if (!point || !frame) return;
    if (this.insideTimeAxis(point,frame)) {
      if(this.pointers.size||!this.range)return;
      const logical=frame.xToLogical(point.x);if(logical===null)return;
      const index=Math.max(0,Math.min(this.series.candles.length-1,Math.round(logical))),bar=this.series.candles[index];if(!bar)return;
      const revision=++this.mutationRevision;
      const gesture={pointerId:event.pointerId,x:point.x,lastX:point.x,width:frame.plot.width,fraction:(point.x-frame.plot.left)/frame.plot.width,span:this.range.to-this.range.from,anchorTime:bar.time,offset:logical-index};
      event.preventDefault();this.canvas.focus({preventScroll:true});this.clearHover();
      if(this.destroyed||revision!==this.mutationRevision)return;
      this.timeAxisGesture=gesture;this.pointers.set(event.pointerId,point);
      try{this.canvas.setPointerCapture(event.pointerId);}catch{/* existing owned window fallback */}
      return;
    }
    if (this.insidePriceAxis(point,frame)) {
      if(this.pointers.size)return;
      const a=frame.yToPrice(frame.plot.top),b=frame.yToPrice(frame.plot.top+frame.plot.height);
      if(a===null||b===null||a===b)return;
      const range=Object.freeze({min:Math.min(a,b),max:Math.max(a,b)});
      const revision=++this.mutationRevision;
      event.preventDefault();this.canvas.focus({preventScroll:true});this.clearHover();
      if(this.destroyed||revision!==this.mutationRevision)return;
      this.priceAxisGesture={pointerId:event.pointerId,y:point.y,height:frame.plot.height,range,scale:this.scale};
      this.pointers.set(event.pointerId,point);
      try{this.canvas.setPointerCapture(event.pointerId);}catch{/* existing owned window fallback */}
      return;
    }
    if (!this.inside(point,frame)) return;
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
  private emitUserRange(previous: Readonly<LogicalWindow> | null): void {
    if(this.destroyed||!this.range||(previous&&previous.from===this.range.from&&previous.to===this.range.to))return;
    const range=Object.freeze({...this.range});
    this.notify("user range",()=>this.options.onUserRangeChange?.(range));
  }
  private onPointerMove = (event: PointerEvent) => {
    if (this.destroyed) return;
    const point = this.point(event); if (!point) return;
    const timeAxis=this.timeAxisGesture;
    if(timeAxis){
      if(event.pointerId!==timeAxis.pointerId)return;
      event.preventDefault();this.pointers.set(event.pointerId,point);
      if(point.x===timeAxis.lastX)return;
      timeAxis.lastX=point.x;
      const index=candleIndex(this.series.candles as ChartEngineCandle[],timeAxis.anchorTime);
      if(index<0){this.cancelGesture();return;}
      // ARX policy: right increases spacing about the starting pointer. This
      // bounded logical view never creates observations or converted times.
      const factor=Math.exp(clamp(-(point.x-timeAxis.x)/timeAxis.width*2,-Math.log(4),Math.log(4)));
      const zoomed=zoomChartWindow({from:0,to:timeAxis.span},factor,this.series.candles.length);
      if(!zoomed)return;
      const span=zoomed.to-zoomed.from,from=index+timeAxis.offset-timeAxis.fraction*span;
      const next=panChartWindow({from,to:from+span},0,this.series.candles.length),previous=this.range;
      if(next&&(!previous||next.from!==previous.from||next.to!==previous.to)){
        this.range=next;this.followingLatest=false;this.invalidate();this.emitUserRange(previous);
      }
      return;
    }
    const axis=this.priceAxisGesture;
    if(axis){
      if(event.pointerId!==axis.pointerId)return;
      event.preventDefault();this.pointers.set(event.pointerId,point);
      const factor=Math.exp(clamp((point.y-axis.y)/axis.height*2,-6,6));
      const next=scaleNativePriceRange(axis.range,axis.scale,factor);
      if(next){this.manualPriceRange=next;this.invalidate();}
      return;
    }
    if (!this.pointers.has(event.pointerId)) { if (!this.pointers.size) this.updateHover(point); return; }
    const previousRange=this.range;
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
    this.emitUserRange(previousRange);
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
    if(this.priceAxisGesture?.pointerId===event.pointerId)this.priceAxisGesture=null;
    if(this.timeAxisGesture?.pointerId===event.pointerId)this.timeAxisGesture=null;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  private onPointerCancel = () => { if (!this.destroyed) { this.cancelGesture();this.clearHover(); } };
  private onLostCapture = (event: PointerEvent) => { if (!this.destroyed && this.pointers.has(event.pointerId)) this.cancelGesture(); };
  private onWheel = (event: WheelEvent) => {
    if (this.destroyed || this.frozenDrawingFrame || this.activeDrawingPlacement() || event.defaultPrevented) return;
    const point = this.point(event), frame = this.getFrame();
    if (!point || !this.inside(point, frame) || !Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX)
      || (event.deltaY === 0 && event.deltaX === 0)) return;
    const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const raw = horizontal ? event.deltaX : event.deltaY;
    const pixels = raw * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (horizontal ? frame!.plot.width : frame!.plot.height) : 1);
    const revision = ++this.mutationRevision,previousRange=this.range;
    event.preventDefault();this.cancelGesture();this.clearHover();if (this.destroyed || revision !== this.mutationRevision) return;
    if (horizontal && this.range) {
      const next = this.shift(this.range, pixels / frame!.spacing);
      if (next) { this.range = next;this.followingLatest = false;this.frame = null;this.schedule(); }
    } else this.zoomAt(Math.exp(clamp(pixels * .002, -.65, .65)), point.x);
    this.emitUserRange(previousRange);
  };
  /** Explicit, temporary inspection of actual loaded bars. Never requests orders or fabricates gaps. */
  inspectCandle(action: "pin"|"previous"|"next"|"first"|"last"|"clear"): boolean {
    if(this.destroyed)return false;
    if(action==="clear"){this.clearHover();return true;}
    if(this.frozenDrawingFrame||this.activeDrawingPlacement()||this.pointers.size)return false;
    const frame=this.getFrame(),bars=this.series.candles;
    if(!frame||!bars.length||!this.range)return false;
    const current=this.hover?candleIndex(bars as ChartEngineCandle[],this.hover.candle.time):-1;
    const visibleLast=Math.max(0,Math.min(bars.length-1,Math.floor(this.range.to)));
    let index=current>=0?current:visibleLast;
    if(action==="first")index=0;
    else if(action==="last")index=bars.length-1;
    else if(action==="previous")index--;
    else if(action==="next")index++;
    if(index<0||index>=bars.length)return false;
    const previousRange=this.range,revision=++this.mutationRevision;
    // Keep the existing zoom while bringing an offscreen selected bar into view.
    const span=this.range.to-this.range.from;
    if(index<this.range.from||index>this.range.to){
      const from=index<this.range.from?index:index-span;
      const next=panChartWindow({from,to:from+span},0,bars.length);
      if(!next)return false;
      this.range=next;this.followingLatest=false;this.invalidate();
    }
    const nextFrame=this.getFrame(),candle=bars[index]!;
    const x=nextFrame?.timeToX(candle.time);
    if(!nextFrame||x==null)return false;
    const projectedY=nextFrame.priceToY(candle.close);
    if(projectedY==null)return false;
    this.followingLatest=false;this.linkedCrosshairTime=null;this.inspectionPinned=true;
    const y=clamp(projectedY,nextFrame.plot.top,nextFrame.plot.top+nextFrame.plot.height);
    this.hover=Object.freeze({candle,x,y,price:candle.close});
    this.notify("crosshair",()=>this.options.onCrosshair?.(this.hover));
    if(this.destroyed||revision!==this.mutationRevision)return false;
    this.schedule();this.emitUserRange(previousRange);return true;
  }
  private onKeyDown = (event: KeyboardEvent) => {
    if (this.destroyed || this.frozenDrawingFrame || this.activeDrawingPlacement() || event.defaultPrevented || event.target !== this.canvas || this.canvas.ownerDocument.activeElement !== this.canvas
      || this.canvas.isContentEditable || this.canvas.getAttribute("contenteditable") === "true"
      || event.ctrlKey || event.metaKey || event.altKey || !this.range) return;
    const inspectionAction=event.key==="Escape"&&this.inspectionPinned?"clear":event.key==="Enter"?"pin":event.shiftKey?({ArrowLeft:"previous",ArrowRight:"next",Home:"first",End:"last"} as const)[event.key as "ArrowLeft"|"ArrowRight"|"Home"|"End"]:undefined;
    if(inspectionAction){event.preventDefault();this.inspectCandle(inspectionAction);return;}
    const previousRange=this.range,generation=this.generation,revision=this.mutationRevision;
    if (event.key === "Home") this.fit();
    else if (event.key === "End") this.goLatest();
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const next = panChartWindow(this.range, event.key === "ArrowLeft" ? -.2 : .2, this.series.candles.length);if (next) this.setRange(next);
    } else if (["+", "=", "-", "_"].includes(event.key)) {
      const next = zoomChartWindow(this.range, event.key === "+" || event.key === "=" ? .8 : 1.25, this.series.candles.length);if (next) this.setRange(next);
    } else return;
    event.preventDefault();
    if(!this.destroyed&&generation===this.generation&&this.mutationRevision===revision+1)this.emitUserRange(previousRange);
  };
  destroy(): void {
    if (this.destroyed) return;
    this.drawingEditor.destroy();this.drawings=[];this.drawingInteraction=null;this.drawingHandler=null;this.selectedDrawing=null;this.frozenDrawingFrame=null;this.editAnchorTimes=[];
    this.scannerOverlays.destroy();this.overlayLayers.reset();this.livePriceAffordance=false;this.linkedCrosshairTime=null;this.manualPriceRange=null;
    this.destroyed = true;this.generation++;this.mutationRevision++;this.cancelGesture();this.clearHover();
    if (this.raf != null) cancelAnimationFrame(this.raf);this.raf = null;
    this.observer?.disconnect();this.observer = null;this.media?.removeEventListener("change", this.onDprChange);this.media = null;
    this.listeners.forEach(remove => remove());this.listeners = [];
    this.frame = null;this.range = null;this.series = prepareNativePriceSeries([]);this.studies.setStudies([],[]);this.referencePrice = null;this.referenceSet = false;this.canvas.remove();
  }
}
