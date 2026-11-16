// Pure drawing read-back: painted geometry versus stored anchors, through an
// explicit linear projection. Faults are injected into the PAINTED strokes or
// the axes, as a renderer bug would produce them.
import { describe, it, expect } from "vitest";
import { drawingNotes, drawingStrokes, type DrawingStroke, type ProjectAnchor } from "./chartDrawingPrimitive";
import { distanceToStroke, expectedDrawingAnchors, measureDrawingRender, mergeDrawingFidelity, type AxisInverse } from "./drawingRenderFidelity";
import type { ChartDrawing } from "./chartWorkspace";

const W = 1000, H = 500, STEP = 0.00001;
const loaded = new Set([100, 200, 300, 400, 500]);
const project: ProjectAnchor = (a, priceOnly) => {
  const y = (2 - a.price) * 1000;
  if (priceOnly) return { x: 0, y };
  return loaded.has(a.time) ? { x: a.time * 2, y } : null;
};
const exactAxes: AxisInverse = { price: y => 2 - y / 1000, time: x => x / 2 };
const d = (over: Partial<ChartDrawing> & Pick<ChartDrawing, "id" | "kind">): ChartDrawing =>
  ({ start: { time: 100, price: 1.1 }, color: "#ffffff", ...over }) as ChartDrawing;
const ALL: ChartDrawing[] = [
  d({ id: "h", kind: "horizontal", start: { time: 200, price: 1.2 } }),
  d({ id: "v", kind: "vertical", start: { time: 300, price: 1.7 } }),
  d({ id: "t", kind: "trend", end: { time: 400, price: 1.3 } }),
  d({ id: "r", kind: "ray", end: { time: 200, price: 1.15 } }),
  d({ id: "x", kind: "extended", start: { time: 200, price: 1.2 }, end: { time: 300, price: 1.25 } }),
  d({ id: "z", kind: "rectangle", end: { time: 300, price: 1.3 } }),
  d({ id: "f", kind: "fibonacci", end: { time: 500, price: 1.5 } }),
  d({ id: "c", kind: "channel", end: { time: 300, price: 1.2 }, offset: { time: 200, price: 1.3 } }),
  d({ id: "m", kind: "measure", end: { time: 300, price: 1.2 } }),
  d({ id: "n", kind: "text", start: { time: 200, price: 1.6 }, text: "note" }),
];
const measure = (drawings: ChartDrawing[], strokes?: DrawingStroke[], axes = exactAxes) =>
  measureDrawingRender(drawings, strokes ?? drawingStrokes(drawings, project, W, H), drawingNotes(drawings, project, W, H, () => 40),
    project, axes, W, H, STEP);

describe("measureDrawingRender", () => {
  it("every drawing kind painted by the real stroke builder reads back at its anchors", () => {
    expect(measure(ALL)).toEqual({ checked: ALL.length, failed: 0, unplaced: 0, failedIds: [] });
  });

  it("fib levels and rectangle corners are each checked", () => {
    expect(expectedDrawingAnchors(ALL.find(x => x.id === "f")!)).toHaveLength(14);
    expect(expectedDrawingAnchors(ALL.find(x => x.id === "z")!)).toHaveLength(4);
  });

  it("a trendline painted one pixel off its anchor fails", () => {
    const t = [ALL[2]!];
    const strokes = drawingStrokes(t, project, W, H).map(s => ({ ...s, start: { ...s.start, y: s.start.y + 1 } }));
    expect(measure(t, strokes)).toMatchObject({ checked: 1, failed: 1, failedIds: ["t"] });
  });

  it("a fib whose 61.8% level is painted at the wrong price fails", () => {
    const f = [ALL[6]!];
    const strokes = drawingStrokes(f, project, W, H).map(s => s.label === "Fib 61.8%" ? { ...s, start: { ...s.start, y: s.start.y + 5 }, end: { ...s.end, y: s.end.y + 5 } } : s);
    expect(measure(f, strokes).failedIds).toEqual(["f"]);
  });

  it("a horizontal level painted at another height fails; a missing stroke fails", () => {
    const h = [ALL[0]!];
    expect(measure(h, drawingStrokes(h, project, W, H).map(s => ({ ...s, start: { ...s.start, y: 10 }, end: { ...s.end, y: 10 } }))).failed).toBe(1);
    expect(measure(h, []).failed).toBe(1);
  });

  it("axes that do not map a pixel back to the anchor fail the drawing", () => {
    expect(measure([ALL[2]!], undefined, { ...exactAxes, price: y => 2 - y / 1000 + 0.001 }).failed).toBe(1);
    expect(measure([ALL[2]!], undefined, { ...exactAxes, time: x => x / 2 + 100 }).failed).toBe(1);
  });

  it("drawings whose anchor bar is not loaded, hidden or degenerate are not measured as passes", () => {
    const r = measure([
      d({ id: "old", kind: "trend", start: { time: 50, price: 1.1 }, end: { time: 400, price: 1.2 } }),
      d({ id: "deg", kind: "ray", end: { time: 100, price: 1.2 } }),
      d({ id: "hid", kind: "trend", end: { time: 400, price: 1.2 }, hidden: true }),
    ]);
    expect(r).toEqual({ checked: 0, failed: 0, unplaced: 2, failedIds: [] });
  });

  it("geometry helpers", () => {
    expect(distanceToStroke({ x: 5, y: 1 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(1);
    expect(distanceToStroke({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(10);
    expect(distanceToStroke({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }, true)).toBe(0);
    expect(mergeDrawingFidelity({ checked: 1, failed: 1, unplaced: 0, failedIds: ["a"] }, { checked: 2, failed: 0, unplaced: 1, failedIds: [] }))
      .toEqual({ checked: 3, failed: 1, unplaced: 1, failedIds: ["a"] });
  });
});
