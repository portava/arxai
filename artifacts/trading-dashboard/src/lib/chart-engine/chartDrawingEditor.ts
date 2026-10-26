import { hitTestDrawings, type PixelPoint, type ProjectAnchor } from "./chartDrawingPrimitive";
import { validateDrawings, type ChartAnchor, type ChartDrawing } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";

export interface DrawingInteraction {
  selectedId: string | null;
  snap: boolean;
  onSelect(id: string | null): void;
  onCommit(drawings: ChartDrawing[]): void;
}
export interface DrawingProjection {
  candles(): ChartEngineCandle[];
  project: ProjectAnchor;
  anchor(point: PixelPoint, snap: boolean): ChartAnchor | null;
  price(y: number): number | null;
  size(): { width: number; height: number };
}

export function candleIndex(candles: ChartEngineCandle[], time: number): number {
  let lo = 0, hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1, at = candles[mid]!.time;
    if (at === time) return mid;
    if (at < time) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** Translate in candle indices and screen-space prices. Weekends never become
 * invented bars, and logarithmic/inverted scales keep their visible geometry. */
export function moveDrawing(drawing: ChartDrawing, part: "start" | "end" | "body", origin: PixelPoint, point: PixelPoint, projection: DrawingProjection, snap: boolean): ChartDrawing | null {
  const target = projection.anchor(point, snap);
  if (!target) return null;
  if (part !== "body") {
    const anchor = drawing.kind === "horizontal" ? { ...drawing.start, price: target.price }
      : drawing.kind === "vertical" ? { ...drawing.start, time: target.time } : target;
    return validateDrawings([{ ...drawing, [part]: anchor }])[0] ?? null;
  }
  const candles = projection.candles();
  const startPoint = projection.anchor(origin, false);
  if (!startPoint) return null;
  const index = (time: number) => candleIndex(candles, time);
  let delta = index(target.time) - index(startPoint.time);
  const anchors = [drawing.start, ...(drawing.end ? [drawing.end] : [])];
  const indexes = anchors.map(anchor => index(anchor.time));
  if (drawing.kind !== "horizontal") {
    if (indexes.some(i => i < 0)) return null;
    delta = Math.max(-Math.min(...indexes), Math.min(candles.length - 1 - Math.max(...indexes), delta));
  }
  const moved = anchors.map((anchor, i) => {
    const pixel = projection.project(anchor, drawing.kind === "horizontal");
    if (!pixel) return null;
    const price = drawing.kind === "vertical" ? anchor.price : projection.price(pixel.y + point.y - origin.y);
    if (price == null || !Number.isFinite(price) || price <= 0) return null;
    return { time: drawing.kind === "horizontal" ? anchor.time : candles[indexes[i]! + delta]!.time, price };
  });
  if (moved.some(anchor => !anchor)) return null;
  return validateDrawings([{ ...drawing, start: moved[0], ...(drawing.end ? { end: moved[1] } : {}) }])[0] ?? null;
}

interface EditorContext extends DrawingProjection {
  render(drawings: ChartDrawing[]): void;
  select(id: string | null): void;
  freeze(active: boolean): void;
}
interface Gesture {
  pointerId: number;
  origin: PixelPoint;
  original: ChartDrawing[];
  drawing: ChartDrawing;
  part: "start" | "end" | "body";
  preview: ChartDrawing[];
  changed: boolean;
}

/** Local analysis-only gestures. Preview stays imperative; one completed drag
 * produces one persisted edit/undo entry. Cancel never writes partial geometry. */
export class ChartDrawingEditor {
  private config: DrawingInteraction | null = null;
  private drawings: ChartDrawing[] = [];
  private placement: ((anchor: ChartAnchor) => void) | null = null;
  private gesture: Gesture | null = null;
  private tap: { id: number; point: PixelPoint } | null = null;
  private suppressClickUntil = 0;
  private originalTouchAction: string;

  constructor(private container: HTMLElement, private context: EditorContext) {
    this.originalTouchAction = container.style.touchAction;
    container.addEventListener("pointerdown", this.down, true);
    window.addEventListener("pointermove", this.move, true);
    window.addEventListener("pointerup", this.up, true);
    window.addEventListener("pointercancel", this.cancelPointer, true);
    window.addEventListener("keydown", this.key);
    window.addEventListener("blur", this.cancel);
    for (const name of ["mousedown", "touchstart", "touchmove", "click", "dblclick"]) container.addEventListener(name, this.blockCompatibility, { capture: true, passive: false });
  }
  configure(config: DrawingInteraction | null): void {
    this.config = config;
    this.context.select(config?.selectedId ?? null);
    if (!config) this.cancel();
  }
  setDrawings(drawings: ChartDrawing[]): void { this.cancel(); this.drawings = drawings; }
  setPlacement(handler: ((anchor: ChartAnchor) => void) | null): void {
    this.cancel(); this.placement = handler;
    this.container.style.touchAction = handler ? "none" : this.originalTouchAction;
  }
  destroy(): void {
    this.cancel();
    this.container.style.touchAction = this.originalTouchAction;
    this.container.removeEventListener("pointerdown", this.down, true);
    window.removeEventListener("pointermove", this.move, true);
    window.removeEventListener("pointerup", this.up, true);
    window.removeEventListener("pointercancel", this.cancelPointer, true);
    window.removeEventListener("keydown", this.key);
    window.removeEventListener("blur", this.cancel);
    for (const name of ["mousedown", "touchstart", "touchmove", "click", "dblclick"]) this.container.removeEventListener(name, this.blockCompatibility, true);
    this.config = null; this.placement = null;
  }
  private point(event: PointerEvent): PixelPoint {
    const rect = this.container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private block(event: Event): void { event.preventDefault(); event.stopImmediatePropagation(); }
  private blockCompatibility = (event: Event) => {
    if (this.gesture || this.placement || Date.now() < this.suppressClickUntil) this.block(event);
  };
  private down = (event: PointerEvent) => {
    if (this.gesture || this.tap) { this.cancel(); return; }
    if (event.button !== 0 || event.isPrimary === false || !(event.target instanceof HTMLCanvasElement)) return;
    const point = this.point(event), size = this.context.size();
    if (point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) return;
    if (this.placement) {
      this.tap = { id: event.pointerId, point }; this.block(event);
      try { this.container.setPointerCapture(event.pointerId); } catch { /* detached/test surface */ }
      return;
    }
    if (!this.config) return;
    const hit = hitTestDrawings(this.drawings, this.config.selectedId, this.context.project, size.width, size.height, point, event.pointerType === "touch" ? 14 : 8);
    this.config.onSelect(hit?.id ?? null); this.context.select(hit?.id ?? null);
    const drawing = this.drawings.find(d => d.id === hit?.id);
    if (!hit || !drawing || drawing.locked) return;
    this.gesture = { pointerId: event.pointerId, origin: point, original: this.drawings, drawing, part: hit.part, preview: this.drawings, changed: false };
    this.block(event); this.context.freeze(true);
    this.container.style.touchAction = "none";
    try { this.container.setPointerCapture(event.pointerId); } catch { /* detached/test surface */ }
  };
  private move = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.block(event);
    const point = this.point(event), size = this.context.size();
    if (point.x < 0 || point.x > size.width || point.y < 0 || point.y > size.height) return;
    if (!gesture.changed && Math.hypot(point.x - gesture.origin.x, point.y - gesture.origin.y) < 3) return;
    const moved = moveDrawing(gesture.drawing, gesture.part, gesture.origin, point, this.context, this.config?.snap ?? false);
    if (!moved) return;
    gesture.preview = gesture.original.map(d => d.id === moved.id ? moved : d);
    gesture.changed = JSON.stringify(moved) !== JSON.stringify(gesture.drawing);
    this.context.render(gesture.preview);
  };
  private up = (event: PointerEvent) => {
    if (this.tap && this.tap.id === event.pointerId) {
      const tap = this.tap; this.tap = null; this.release(event.pointerId); this.block(event);
      const point = this.point(event), size = this.context.size();
      if (point.x < 0 || point.x > size.width || point.y < 0 || point.y > size.height) return;
      if (Math.hypot(point.x - tap.point.x, point.y - tap.point.y) <= 5) {
        const anchor = this.context.anchor(point, this.config?.snap ?? false);
        if (anchor) this.placement?.(anchor);
      }
      return;
    }
    if (!this.gesture || this.gesture.pointerId !== event.pointerId) return;
    this.move(event);
    const gesture = this.gesture; this.gesture = null; this.release(event.pointerId);
    this.context.freeze(false); this.container.style.touchAction = this.originalTouchAction;
    this.suppressClickUntil = Date.now() + 250;
    if (gesture.changed) { this.drawings = gesture.preview; this.config?.onCommit(gesture.preview); }
  };
  private release(id: number): void { try { this.container.releasePointerCapture(id); } catch { /* capture may already be released */ } }
  private cancelPointer = (event: PointerEvent) => { if (this.gesture?.pointerId === event.pointerId || this.tap?.id === event.pointerId) this.cancel(); };
  private key = (event: KeyboardEvent) => { if (event.key === "Escape") this.cancel(); };
  private cancel = () => {
    if (this.gesture) { this.context.render(this.gesture.original); this.release(this.gesture.pointerId); this.gesture = null; this.context.freeze(false); }
    if (this.tap) this.release(this.tap.id);
    this.tap = null;
    this.container.style.touchAction = this.placement ? "none" : this.originalTouchAction;
  };
}
