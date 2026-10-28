import { describe, expect, it, vi } from "vitest";
import { ChartDrawingPrimitive, drawingStrokes } from "./chartDrawingPrimitive";
import type { ChartDrawing } from "./chartWorkspace";

const drawings: ChartDrawing[] = [
  { id: "fib", kind: "fibonacci", start: { time: 100, price: 20 }, end: { time: 200, price: 10 }, color: "#ffffff" },
  { id: "trend", kind: "trend", start: { time: 100, price: 10 }, end: { time: 200, price: 20 }, color: "#ff0000" },
];
const candles = [100, 200].map(time => ({ time, open: 10, high: 20, low: 10, close: 15 }));
function fixture() {
  const timeToCoordinate = vi.fn((time: number) => time);
  const priceToCoordinate = vi.fn((price: number) => 100 - price);
  const requestUpdate = vi.fn();
  const primitive = new ChartDrawingPrimitive();
  primitive.attached({ chart: { timeScale: () => ({ timeToCoordinate, width: () => 800 }) }, series: { getPane: () => ({getHeight: () => 400}), priceToCoordinate, priceFormatter: () => ({ format: String }) }, requestUpdate } as any);
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), setLineDash: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn() };
  const draw = () => primitive.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (callback: any) => callback({ context, mediaSize: { width: 800, height: 400 } }) } as any);
  return { primitive, draw, context, requestUpdate, timeToCoordinate, priceToCoordinate };
}
describe("shared drawing canvas", () => {
  it("projects directional Fib levels and a trend without creating data points", () => {
    const strokes = drawingStrokes(drawings, anchor => ({ x: anchor.time, y: anchor.price }), 800);
    expect(strokes).toHaveLength(8);
    expect(strokes[4]!.start.y).toBeCloseTo(13.82);
    expect(strokes[7]).toMatchObject({ start: { x: 100, y: 10 }, end: { x: 200, y: 20 }, dashed: false });
  });
  it("excludes unloaded endpoints, but price-only levels remain independent of history dates", () => {
    const { primitive, draw, context, timeToCoordinate } = fixture();
    primitive.setData([...drawings, { id: "level", kind: "horizontal", start: { time: 1, price: 15 }, color: "#ffffff" }], candles.slice(0, 1));
    draw();
    expect(context.stroke).toHaveBeenCalledTimes(1);
    expect(context.moveTo).toHaveBeenLastCalledWith(0, 85);
    expect(context.lineTo).toHaveBeenLastCalledWith(800, 85);
    expect(timeToCoordinate).not.toHaveBeenCalledWith(200);
    expect(primitive.priceAxisViews()[0]!.text()).toBe("15");
    primitive.setData(drawings, candles); draw();
    expect(context.stroke).toHaveBeenCalledTimes(9);
  });
  it("coalesces invalidations until paint and releases all attachment references", () => {
    const { primitive, draw, timeToCoordinate, context } = fixture();
    primitive.setData(drawings, candles);
    for (let i = 0; i < 100; i++) primitive.updateAllViews();
    expect(timeToCoordinate).not.toHaveBeenCalled();
    draw();
    const projections = timeToCoordinate.mock.calls.length;
    expect(projections).toBe(16);
    draw();
    expect(timeToCoordinate).toHaveBeenCalledTimes(projections);
    primitive.updateAllViews(); draw();
    expect(timeToCoordinate).toHaveBeenCalledTimes(projections * 2);
    primitive.detached(); draw();
    expect(primitive.priceAxisViews()).toEqual([]);
    expect(context.save).toHaveBeenCalledTimes(context.restore.mock.calls.length);
  });
});
