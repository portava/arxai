// Drawing render fidelity — the drawing half of Render Accuracy evidence
// (owner ruling 2026-11-09: every chart read, drawing and prediction must be
// accurate).
//
// For every drawing the renderer actually placed, take the pixel it projected
// each stored anchor to, read that pixel back through the engine's own axes
// (pixel→price, pixel→time) and require the stored anchor back; then require
// the PAINTED geometry (the strokes / note cards the primitive draws) to pass
// through that pixel. A drawing whose anchors read back to another price or
// bar, or whose painted line misses its anchors, is a failed drawing — and one
// failed drawing fails the whole render read on the server.
//
// A drawing whose anchors are not on the loaded series (or off the price
// scale) is not drawn at all; it is counted as "unplaced", never as a pass.
// Read-only: nothing here changes a drawing, a candle or an order.
import { drawingSegments, type ChartAnchor, type ChartDrawing } from "./chartWorkspace";
import type { DrawingNote, DrawingStroke, PixelPoint, ProjectAnchor } from "./chartDrawingPrimitive";

/** Pixel tolerance for "the painted line passes through the anchor". */
export const DRAWING_PIXEL_TOLERANCE = 0.5;
const MAX_FAILED_IDS = 20;

export interface DrawingFidelity {
  /** Drawings (and engine-drawn lines) whose rendered anchors were read back. */
  checked: number;
  /** Of those, how many read back to a different anchor or were painted elsewhere. */
  failed: number;
  /** Drawings not on screen (anchor bar not loaded / off-scale) — not measured. */
  unplaced: number;
  /** Ids of failed drawings (capped). */
  failedIds: string[];
}

export const EMPTY_DRAWING_FIDELITY: DrawingFidelity = { checked: 0, failed: 0, unplaced: 0, failedIds: [] };

export interface AxisInverse {
  price(y: number): number | null;
  time(x: number): number | null;
}

interface ExpectedAnchor { anchor: ChartAnchor; priceOnly?: boolean; timeOnly?: boolean; onLine?: boolean }

/** The anchors a drawing's painted geometry must pass through, by kind. Fib
 * levels and rectangle corners come from the same `drawingSegments` the
 * renderer uses, so each painted level/edge is checked at both ends. */
export function expectedDrawingAnchors(d: ChartDrawing): ExpectedAnchor[] {
  switch (d.kind) {
    case "horizontal": return [{ anchor: d.start, priceOnly: true }];
    case "vertical": return [{ anchor: d.start, timeOnly: true }];
    case "text": return [{ anchor: d.start }];
    case "measure": case "trend": case "ray": case "extended":
      return d.end ? [{ anchor: d.start }, { anchor: d.end }] : [];
    case "channel":
      // The offset handle sets the parallel rail; it lies on that rail's line
      // (not necessarily inside its finite segment).
      return d.end && d.offset ? [{ anchor: d.start }, { anchor: d.end }, { anchor: d.offset, onLine: true }] : [];
    default: {
      const seen = new Set<string>();
      const out: ExpectedAnchor[] = [];
      for (const s of drawingSegments(d)) for (const a of [s.start, s.end]) {
        const k = `${a.time}|${a.price}`;
        if (!seen.has(k)) { seen.add(k); out.push({ anchor: a }); }
      }
      return out;
    }
  }
}

/** Distance from p to segment ab (or to the infinite line through a,b). */
export function distanceToStroke(p: PixelPoint, a: PixelPoint, b: PixelPoint, infinite = false): number {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  if (!len) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
  if (!infinite) t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

const priceClose = (got: number | null, want: number, step: number) =>
  got != null && Number.isFinite(got) && Math.abs(got - want) <= step;

/**
 * Measure painted drawings against their stored anchors.
 * `project` must be the SAME projection the primitive painted with; `strokes`
 * and `notes` are what it painted; `invert` reads a pixel back through the
 * engine's axes. `priceStep` is the displayed price step (one tick).
 */
export function measureDrawingRender(
  drawings: readonly ChartDrawing[], strokes: readonly DrawingStroke[], notes: readonly DrawingNote[],
  project: ProjectAnchor, invert: AxisInverse, width: number, height: number, priceStep: number,
): DrawingFidelity {
  const out: DrawingFidelity = { checked: 0, failed: 0, unplaced: 0, failedIds: [] };
  for (const d of drawings) {
    if (d.hidden) continue;
    const expected = expectedDrawingAnchors(d);
    // Degenerate lines (both anchors on one bar) are not painted by design.
    const degenerate = ["ray", "extended", "channel"].includes(d.kind) && d.end != null && d.end.time === d.start.time;
    if (!expected.length || degenerate) { out.unplaced++; continue; }
    const pixels = expected.map(e => project(e.anchor, e.priceOnly));
    if (pixels.some(p => p == null || !Number.isFinite(p.x) || !Number.isFinite(p.y))) { out.unplaced++; continue; }
    const points = pixels.map((p, i): PixelPoint => {
      const e = expected[i]!;
      if (e.priceOnly) return { x: width / 2, y: p!.y };
      if (e.timeOnly) return { x: p!.x, y: height / 2 };
      return p!;
    });
    if (d.kind === "text") {
      const p = points[0]!;
      if (p.x < 0 || p.x > width || p.y < 0 || p.y > height) { out.unplaced++; continue; }
    }
    const own = strokes.filter(s => s.id === d.id);
    let ok = true;
    for (let i = 0; i < expected.length && ok; i++) {
      const e = expected[i]!, p = points[i]!;
      if (!e.timeOnly && !priceClose(invert.price(p.y), e.anchor.price, priceStep)) ok = false;
      if (ok && !e.priceOnly && p.x >= 0 && p.x <= width && invert.time(p.x) !== e.anchor.time) ok = false;
      if (!ok) break;
      if (d.kind === "text") {
        ok = notes.some(n => n.id === d.id && Math.hypot(n.anchor.x - p.x, n.anchor.y - p.y) <= DRAWING_PIXEL_TOLERANCE);
      } else {
        ok = own.some(s => distanceToStroke(p, s.start, s.end, e.onLine) <= DRAWING_PIXEL_TOLERANCE);
      }
    }
    out.checked++;
    if (!ok) { out.failed++; if (out.failedIds.length < MAX_FAILED_IDS) out.failedIds.push(d.id); }
  }
  return out;
}

/** Combine several drawing measurements (user drawings, engine-drawn lines). */
export function mergeDrawingFidelity(...parts: DrawingFidelity[]): DrawingFidelity {
  return parts.reduce((acc, p) => ({
    checked: acc.checked + p.checked, failed: acc.failed + p.failed, unplaced: acc.unplaced + p.unplaced,
    failedIds: [...acc.failedIds, ...p.failedIds].slice(0, MAX_FAILED_IDS),
  }), { ...EMPTY_DRAWING_FIDELITY });
}
