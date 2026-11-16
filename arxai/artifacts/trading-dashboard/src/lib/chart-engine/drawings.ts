/** User annotations are local chart coordinates, never orders or forecasts. */
export type DrawingTool =
  | "cursor"
  | "trend"
  | "horizontal"
  | "rectangle"
  | "fibonacci";
export type DrawingAnchor = { time: number; price: number };
export type ChartDrawing = {
  id: string;
  tool: Exclude<DrawingTool, "cursor">;
  start: DrawingAnchor;
  end: DrawingAnchor;
};
export function validDrawings(input: unknown): ChartDrawing[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(-200)
    .filter(
      (d): d is ChartDrawing =>
        d &&
        typeof d.id === "string" &&
        ["trend", "horizontal", "rectangle", "fibonacci"].includes(d.tool) &&
        [d.start, d.end].every(
          (p) =>
            p &&
            Number.isFinite(p.time) &&
            p.time > 0 &&
            Number.isFinite(p.price),
        ),
    )
    .map((d) => ({
      id: d.id,
      tool: d.tool,
      start: { ...d.start },
      end: { ...d.end },
    }));
}
export function fibonacciLevels(a: number, b: number) {
  return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((ratio) => ({
    ratio,
    price: a + (b - a) * ratio,
  }));
}
