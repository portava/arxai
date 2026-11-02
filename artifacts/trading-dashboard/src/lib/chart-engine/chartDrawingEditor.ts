import { hitTestDrawings, type PixelPoint, type ProjectAnchor } from "./chartDrawingCanvas";
import { threeAnchorDrawing, validateDrawings, type ChartAnchor, type ChartDrawing } from "./chartWorkspace";
import type { ChartEngineCandle } from "./types";

export interface DrawingInteraction {
  /** Stable owner/context token permits controlled selection rerenders during a drag. */
  owner?: object;
  selectedId: string | null;
  snap: boolean;
  onSelect(id: string | null): void;
  onCommit(drawings: ChartDrawing[]): void;
  /** Present only when this chart has a local drawing history action. */
  onUndo?(): void;
  onRedo?(): void;
}
export interface DrawingProjection {
  candles(): ChartEngineCandle[];
  /** Optional CSS/client to price-plot-local mapping. Null rejects non-price panes. */
  eventPoint?(event: { clientX: number; clientY: number }): PixelPoint | null;
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
export function moveDrawing(drawing: ChartDrawing, part: "start" | "end" | "offset" | "body", origin: PixelPoint, point: PixelPoint, projection: DrawingProjection, snap: boolean): ChartDrawing | null {
  if (drawing.kind === "text" && part === "body") {
    // A note's card can extend over whitespace with no candle beneath it. Move
    // the actual anchor by the pointer delta rather than rebinding that card
    // pixel to an unrelated candle. Body movement keeps the unsnapped price.
    const start = projection.project(drawing.start);
    if (!start) return null;
    const moved = projection.anchor({ x: start.x + point.x - origin.x, y: start.y + point.y - origin.y }, false);
    return moved ? validateDrawings([{ ...drawing, start: moved }])[0] ?? null : null;
  }
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
  const anchors = [drawing.start, ...(drawing.end ? [drawing.end] : []), ...(threeAnchorDrawing(drawing.kind) && drawing.offset ? [drawing.offset] : [])];
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
  return validateDrawings([{ ...drawing, start: moved[0], ...(drawing.end ? { end: moved[1] } : {}), ...(threeAnchorDrawing(drawing.kind) ? {offset:moved[2]} : {}) }])[0] ?? null;
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
  part: "start" | "end" | "offset" | "body";
  preview: ChartDrawing[];
  changed: boolean;
  onCommit: DrawingInteraction["onCommit"];
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
  private destroyed = false;
  private revision = 0;
  private clone(drawings: ChartDrawing[]): ChartDrawing[] {
    const ids = new Set<string>();
    // Render rows may include previews beyond the persisted-object limit.
    return drawings.flatMap(row => validateDrawings([row])).filter(row => {
      if (ids.has(row.id)) return false;
      ids.add(row.id); return true;
    });
  }
  private current(revision: number): boolean { return !this.destroyed && revision === this.revision; }

  constructor(private container: HTMLElement, private context: EditorContext) {
    this.originalTouchAction = container.style.touchAction;
    container.addEventListener("pointerdown", this.down, true);
    window.addEventListener("pointermove", this.move, true);
    window.addEventListener("pointerup", this.up, true);
    window.addEventListener("pointercancel", this.cancelPointer, true);
    container.addEventListener("lostpointercapture", this.cancelPointer, true);
    window.addEventListener("keydown", this.key);
    window.addEventListener("blur", this.cancel);
    for (const name of ["mousedown", "touchstart", "touchmove", "click", "dblclick"]) container.addEventListener(name, this.blockCompatibility, { capture: true, passive: false });
  }
  configure(config: DrawingInteraction | null): void {
    if (this.destroyed) return;
    if (config?.owner && config.owner === this.config?.owner
      && config.selectedId === this.config.selectedId && config.snap === this.config.snap) {
      // React may recreate callbacks after selecting this same object. Keep the
      // gesture and its original commit owner; context switches must use a new token.
      this.config = { ...config };
      return;
    }
    const revision = this.cancelCurrent();
    if (!this.current(revision)) return;
    this.config = config ? { ...config } : null;
    this.context.select(config?.selectedId ?? null);
  }
  setDrawings(drawings: ChartDrawing[]): void {
    if (this.destroyed) return;
    const next = this.clone(drawings), revision = this.cancelCurrent();
    if (this.current(revision)) this.drawings = next;
  }
  setPlacement(handler: ((anchor: ChartAnchor) => void) | null): void {
    if (this.destroyed) return;
    const revision = this.cancelCurrent();
    if (!this.current(revision)) return;
    this.placement = handler;
    this.container.style.touchAction = handler ? "none" : this.originalTouchAction;
  }
  /** Cancel an unfinished preview/tap without persisting it. */
  cancelGesture(): void { if (!this.destroyed) this.cancelCurrent(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelCurrent();
    this.container.style.touchAction = this.originalTouchAction;
    this.container.removeEventListener("pointerdown", this.down, true);
    window.removeEventListener("pointermove", this.move, true);
    window.removeEventListener("pointerup", this.up, true);
    window.removeEventListener("pointercancel", this.cancelPointer, true);
    this.container.removeEventListener("lostpointercapture", this.cancelPointer, true);
    window.removeEventListener("keydown", this.key);
    window.removeEventListener("blur", this.cancel);
    for (const name of ["mousedown", "touchstart", "touchmove", "click", "dblclick"]) this.container.removeEventListener(name, this.blockCompatibility, true);
    this.config = null; this.placement = null; this.drawings = [];
  }
  private point(event: PointerEvent): PixelPoint | null {
    const rect = this.container.getBoundingClientRect();
    const point = this.context.eventPoint ? this.context.eventPoint(event)
      : { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  }
  private block(event: Event): void { event.preventDefault(); event.stopImmediatePropagation(); }
  private blockCompatibility = (event: Event) => {
    if (this.gesture || this.placement || Date.now() < this.suppressClickUntil) this.block(event);
  };
  private down = (event: PointerEvent) => {
    if (this.destroyed) return;
    if (this.gesture || this.tap) { this.cancel(); return; }
    if (event.button !== 0 || event.isPrimary === false || !(event.target instanceof HTMLCanvasElement)) return;
    const revision = this.revision;
    const point = this.point(event), size = this.context.size();
    if (!this.current(revision) || !point || point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height) return;
    this.container.focus({preventScroll:true});
    if (!this.current(revision)) return;
    if (this.placement) {
      this.tap = { id: event.pointerId, point }; this.block(event);
      try { this.container.setPointerCapture(event.pointerId); } catch { /* detached/test surface */ }
      return;
    }
    if (!this.config) return;
    const hit = hitTestDrawings(this.drawings, this.config.selectedId, this.context.project, size.width, size.height, point, event.pointerType === "touch" ? 14 : 8);
    const drawing = this.drawings.find(d => d.id === hit?.id);
    // Claim editable geometry before owner callbacks can reset this context.
    if (hit && drawing && !drawing.locked) this.block(event);
    const config = { ...this.config, selectedId: hit?.id ?? null };
    this.config = config;
    config.onSelect(config.selectedId);
    if (!this.current(revision)) return;
    this.context.select(config.selectedId);
    if (!this.current(revision) || !hit || !drawing || drawing.locked) return;
    const gesture: Gesture = { pointerId: event.pointerId, origin: point, original: this.drawings, drawing, part: hit.part, preview: this.drawings, changed: false, onCommit: config.onCommit };
    this.gesture = gesture; this.context.freeze(true);
    if (!this.current(revision) || this.gesture !== gesture) return;
    this.container.style.touchAction = "none";
    try { this.container.setPointerCapture(event.pointerId); } catch { /* detached/test surface */ }
  };
  private move = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (this.destroyed || !gesture || gesture.pointerId !== event.pointerId) return;
    this.block(event);
    const point = this.point(event), size = this.context.size();
    if (!point || point.x < 0 || point.x > size.width || point.y < 0 || point.y > size.height) return;
    if (!gesture.changed && Math.hypot(point.x - gesture.origin.x, point.y - gesture.origin.y) < 3) return;
    const moved = moveDrawing(gesture.drawing, gesture.part, gesture.origin, point, this.context, this.config?.snap ?? false);
    if (!moved) return;
    gesture.preview = gesture.original.map(d => d.id === moved.id ? moved : d);
    gesture.changed = JSON.stringify(moved) !== JSON.stringify(gesture.drawing);
    this.context.render(this.clone(gesture.preview));
  };
  private up = (event: PointerEvent) => {
    if (this.destroyed) return;
    if (this.tap && this.tap.id === event.pointerId) {
      const tap = this.tap, revision = this.revision, placement = this.placement;
      this.tap = null; this.release(event.pointerId); this.block(event);
      if (!this.current(revision)) return;
      const point = this.point(event), size = this.context.size();
      if (!this.current(revision) || !point || point.x < 0 || point.x > size.width || point.y < 0 || point.y > size.height) return;
      if (Math.hypot(point.x - tap.point.x, point.y - tap.point.y) <= 5) {
        const anchor = this.context.anchor(point, this.config?.snap ?? false);
        if (anchor && this.current(revision)) placement?.(anchor);
      }
      return;
    }
    const gesture = this.gesture, revision = this.revision;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const point = this.point(event), size = this.context.size();
    if (!point || point.x < 0 || point.x > size.width || point.y < 0 || point.y > size.height) { this.block(event); this.cancel(); return; }
    this.move(event);
    if (!this.current(revision) || this.gesture !== gesture) return;
    this.gesture = null; this.release(event.pointerId);
    this.container.style.touchAction = this.originalTouchAction;
    this.suppressClickUntil = Date.now() + 250;
    this.context.freeze(false);
    if (!this.current(revision)) return;
    if (gesture.changed) {
      this.drawings = this.clone(gesture.preview);
      gesture.onCommit(this.clone(this.drawings));
    }
  };
  private release(id: number): void { try { this.container.releasePointerCapture(id); } catch { /* capture may already be released */ } }
  private cancelPointer = (event: PointerEvent) => { if (this.gesture?.pointerId === event.pointerId || this.tap?.id === event.pointerId) this.cancel(); };
  private key = (event: KeyboardEvent) => {
    if (this.destroyed) return;
    if (event.key === "Escape") { this.cancel(); return; }
    // Each chart owns its shortcuts. A selected drawing in a background chart
    // must not receive keys typed into another chart, toolbar or dialog.
    if (event.defaultPrevented || event.isComposing || event.repeat || event.altKey
      || event.target !== this.container || document.activeElement !== this.container
      || !this.config || this.gesture || this.tap || this.placement) return;
    const key = event.key.toLowerCase();
    if (event.ctrlKey || event.metaKey) {
      const action = key === "z" ? (event.shiftKey ? this.config.onRedo : this.config.onUndo)
        : key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey ? this.config.onRedo : undefined;
      if (action) { this.block(event); action(); }
      return;
    }
    if (event.shiftKey || (key !== "delete" && key !== "backspace")) return;
    const selected = this.drawings.find(d => d.id === this.config!.selectedId);
    if (!selected || selected.locked || selected.hidden) return;
    this.block(event);
    const revision = ++this.revision, config = this.config;
    this.config = { ...config, selectedId: null };
    this.drawings = this.drawings.filter(d => d.id !== selected.id);
    this.context.render(this.clone(this.drawings));
    if (!this.current(revision)) return;
    this.context.select(null);
    if (!this.current(revision)) return;
    config.onSelect(null);
    if (this.current(revision)) config.onCommit(this.clone(this.drawings));
  };
  private cancelCurrent(): number {
    const revision = ++this.revision, gesture = this.gesture, tap = this.tap;
    // Clear state before callbacks/release events can re-enter cancellation.
    this.gesture = null; this.tap = null;
    this.container.style.touchAction = this.placement ? "none" : this.originalTouchAction;
    if (gesture) this.release(gesture.pointerId);
    if (tap) this.release(tap.id);
    if (gesture) {
      this.context.freeze(false);
      if (revision === this.revision) this.context.render(this.clone(gesture.original));
    }
    return revision;
  }
  private cancel = () => { if (!this.destroyed) this.cancelCurrent(); };
}
