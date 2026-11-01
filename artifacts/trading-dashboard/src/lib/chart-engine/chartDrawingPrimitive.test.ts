import { describe, expect, it, vi } from "vitest";
import { ChartDrawingPrimitive, drawingStrokes, drawingHandles, hitTestDrawings } from "./chartDrawingPrimitive";
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


it("projects a channel with parallel boundaries in regular, logarithmic and inverted scales",()=>{
 const channel:ChartDrawing={id:"channel",kind:"channel",start:{time:100,price:10},end:{time:200,price:20},offset:{time:150,price:30},color:"#ffffff"};
 for(const y of [(p:number)=>p,(p:number)=>Math.log(p),(p:number)=>-Math.log(p)]){
  const project=(a:any)=>({x:a.time,y:y(a.price)});const lines=drawingStrokes([channel],project,800,400);
  expect(lines).toHaveLength(2);
  expect(lines[0].end.y-lines[0].start.y).toBeCloseTo(lines[1].end.y-lines[1].start.y);
  expect((lines[1].start.y+lines[1].end.y)/2).toBeCloseTo(y(30));
  expect(drawingHandles(channel,project,800,400).map(h=>h.part)).toEqual(["start","end","offset"]);
  expect(hitTestDrawings([channel],"channel",project,800,400,project(channel.offset!))?.part).toBe("offset");
  expect(drawingStrokes([channel],a=>a.time===150?null:project(a),800,400)).toEqual([]);
 }
 const backwards={...channel,start:channel.end!,end:channel.start};
 const lines=drawingStrokes([backwards],a=>({x:a.time,y:a.price}),800,400);expect(lines[1].start.y).toBe(35);expect(lines[1].end.y).toBe(25);
});

it("extends channel boundaries toward viewport left/right regardless of anchor order",()=>{
 const base={id:"channel",kind:"channel",start:{time:100,price:100},end:{time:200,price:110},offset:{time:150,price:130},color:"#ffffff"} as ChartDrawing;
 for(const reverse of [false,true]) for(const direction of ["left","right","both"]){
  const d={...base,...(reverse?{start:base.end!,end:base.start}:{}),extendLeft:direction!=="right",extendRight:direction!=="left"};
  const strokes=drawingStrokes([d],a=>({x:a.time,y:a.price}),800,400);
  const xs=[Math.min(strokes[0].start.x,strokes[0].end.x),Math.max(strokes[0].start.x,strokes[0].end.x)];
  expect(xs).toEqual([direction!=="right"?0:100,direction!=="left"?800:200]);
  expect(strokes[1].start.y-strokes[0].start.y).toBeCloseTo(25);
  expect(strokes[1].end.y-strokes[0].end.y).toBeCloseTo(25);
  expect(drawingHandles(d,a=>({x:a.time,y:a.price}),800,400).map(h=>h.point.x)).toEqual(reverse?[200,100,150]:[100,200,150]);
  if(direction!=="left")expect(hitTestDrawings([d],null,a=>({x:a.time,y:a.price}),800,400,{x:700,y:160})?.part).toBe("body");
 }
});

it("places a dashed midpoint halfway between projected channel rails including log/inverted scales",()=>{
 const d={id:"channel",kind:"channel",start:{time:100,price:10},end:{time:200,price:20},offset:{time:150,price:30},color:"#ffffff",middleLine:true,extendLeft:true,extendRight:true} as ChartDrawing;
 for(const y of [(p:number)=>p,(p:number)=>Math.log(p),(p:number)=>-Math.log(p)]){
  const strokes=drawingStrokes([d],a=>({x:a.time,y:y(a.price)}),800,400);
  expect(strokes).toHaveLength(3);expect(strokes[2].dashed).toBe(true);
  expect(strokes[2].start.y).toBeCloseTo((strokes[0].start.y+strokes[1].start.y)/2);
  expect(strokes[2].end.y).toBeCloseTo((strokes[0].end.y+strokes[1].end.y)/2);
 }
 expect(drawingStrokes([d],a=>a.time===150?null:{x:a.time,y:a.price},800,400)).toEqual([]);
});

it("hides strokes, notes, handles and price labels while retaining exact source objects",()=>{
 const {primitive,draw,context}=fixture();
 const objects:ChartDrawing[]=[...drawings,{id:"level",kind:"horizontal",start:{time:100,price:12},color:"#ffffff"},
 {id:"note",kind:"text",start:{time:100,price:10},color:"#ffffff",text:"Hidden note"}].map(d=>({...d,hidden:true}));
 const before=JSON.stringify(objects);primitive.setData(objects,candles);primitive.setSelection("fib");draw();
 expect(context.stroke).not.toHaveBeenCalled();expect(context.fillText).not.toHaveBeenCalled();expect(context.arc).not.toHaveBeenCalled();
 expect(primitive.priceAxisViews()).toEqual([]);expect(JSON.stringify(objects)).toBe(before);
 primitive.setData(objects.filter(d=>d.kind!=="text").map(d=>({...d,hidden:false})),candles);draw();
 expect(context.stroke).toHaveBeenCalled();expect(context.arc).toHaveBeenCalled();expect(primitive.priceAxisViews()).toHaveLength(1);
});
it('restores both measurement-card and outer Canvas state when text painting fails',()=>{
 const {primitive,draw,context}=fixture();
 primitive.setData([{id:'measure',kind:'measure',start:{time:100,price:10},end:{time:200,price:20},color:'#ffffff'}],candles);
 Object.assign(context,{measureText:vi.fn(()=>({width:100}))});context.fillText.mockImplementation(()=>{throw Error('canvas text failure');});
 expect(draw).toThrow('canvas text failure');expect(context.save.mock.calls.length).toBe(2);expect(context.restore.mock.calls.length).toBe(2);
});
