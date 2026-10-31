import { describe, expect, it, vi } from "vitest";
import { ChartDrawingPrimitive, drawingStrokes } from "./chartDrawingPrimitive";
import type { ChartDrawing } from "./chartWorkspace";

const drawings: ChartDrawing[] = [
  { id: "fib", kind: "fibonacci", start: { time: 100, price: 20 }, end: { time: 200, price: 10 }, color: "#ffffff" },
  { id: "trend", kind: "trend", start: { time: 100, price: 10 }, end: { time: 200, price: 20 }, color: "#ff0000" },
];
const candles = [100, 200].map(time => ({ time, open: 10, high: 20, low: 10, close: 15 }));
function fixture(width = 800, height = 400) {
  const timeToCoordinate = vi.fn((time: number) => time);
  const priceToCoordinate = vi.fn((price: number) => 100 - price);
  const requestUpdate = vi.fn();
  const primitive = new ChartDrawingPrimitive();
  primitive.attached({ chart: { timeScale: () => ({ timeToCoordinate, width: () => width }) }, series: { getPane: () => ({getHeight: () => height}), priceToCoordinate, priceFormatter: () => ({ format: String }) }, requestUpdate } as any);
  const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), setLineDash: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillRect:vi.fn(),strokeRect:vi.fn() };
  const draw = () => primitive.paneViews()[0]!.renderer()!.draw({ useMediaCoordinateSpace: (callback: any) => callback({ context, mediaSize: { width, height } }) } as any);
  return { primitive, draw, context, requestUpdate, timeToCoordinate, priceToCoordinate };
}
describe("shared drawing canvas", () => {
  it("draws user text literally on the shared canvas without price-axis data and hides unloaded notes",()=>{
    const measure=vi.fn((text:string)=>({width:text.length*6}));
    const spy=vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({measureText:measure} as any);
    const {primitive,draw,context,timeToCoordinate}=fixture(800,100);
    const note:ChartDrawing={id:"note",kind:"text",start:{time:100,price:10},color:"#ffffff",text:"<b>My observation</b>"};
    primitive.setData([note],candles);draw();
    expect(context.fillText).toHaveBeenCalledWith("Your note",expect.any(Number),expect.any(Number),expect.any(Number));
    expect(context.fillText).toHaveBeenCalledWith(note.text,expect.any(Number),expect.any(Number),expect.any(Number));
    expect(primitive.priceAxisViews()).toEqual([]);
    measure.mockClear();timeToCoordinate.mockClear();
    for(let i=0;i<20;i++){primitive.updateAllViews();draw();}
    expect(timeToCoordinate).toHaveBeenCalledTimes(20);
    expect(measure).not.toHaveBeenCalled();
    const forty=Array.from({length:40},(_,i)=>({...note,id:`note-${i}`,text:`User observation ${i}`}));
    primitive.setData(forty,candles);draw();
    expect(measure).toHaveBeenCalledTimes(40); // one measurement per short note, not per character
    measure.mockClear();timeToCoordinate.mockClear();
    for(let i=0;i<60;i++){primitive.updateAllViews();draw();}
    expect(timeToCoordinate).toHaveBeenCalledTimes(40*60);
    expect(measure).not.toHaveBeenCalled(); // no text remeasurement over unchanged viewport redraws
    primitive.setData([{...note,text:"a".repeat(240)}],candles);draw();
    expect(context.fillText).toHaveBeenCalledWith("More in Objects",expect.any(Number),expect.any(Number),expect.any(Number));
    context.fillText.mockClear();
    primitive.setData([note],candles.filter(c=>c.time!==100));draw();
    expect(context.fillText).not.toHaveBeenCalled();
    primitive.detached();expect(primitive.priceAxisViews()).toEqual([]);
    spy.mockRestore();
  });
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
  it("does not invalidate geometry or request a repaint when the same drawing remains selected", () => {
    const { primitive, draw, requestUpdate, timeToCoordinate } = fixture();
    primitive.setData(drawings, candles); primitive.setSelection("trend"); draw();
    requestUpdate.mockClear(); timeToCoordinate.mockClear();
    for (let i = 0; i < 20; i++) primitive.setSelection("trend");
    draw();
    expect(requestUpdate).not.toHaveBeenCalled();
    expect(timeToCoordinate).not.toHaveBeenCalled();
  });
  it("repaints a changed or cleared selection and still invalidates independently for viewport and data changes", () => {
    const { primitive, draw, requestUpdate, timeToCoordinate, context } = fixture();
    primitive.setData(drawings, candles); draw(); requestUpdate.mockClear();
    primitive.setSelection("trend"); draw();
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(context.arc).toHaveBeenCalled();
    primitive.setSelection("fib"); draw();
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    primitive.setSelection(null); draw();
    expect(requestUpdate).toHaveBeenCalledTimes(3);
    requestUpdate.mockClear(); timeToCoordinate.mockClear();
    primitive.updateAllViews(); primitive.setSelection(null); draw();
    expect(timeToCoordinate).toHaveBeenCalled();
    timeToCoordinate.mockClear();
    primitive.setData([{ ...drawings[1]!, end: { time: 200, price: 25 } }], candles);
    draw();
    expect(requestUpdate).toHaveBeenCalled();
    expect(timeToCoordinate).toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenLastCalledWith(200, 75);
  });
});
