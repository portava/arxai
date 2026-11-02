import { expect, it } from "vitest";
import { drawingStrokes, drawingHandles, hitTestDrawings } from "./chartDrawingCanvas";
import { moveDrawing, type DrawingProjection } from "./chartDrawingEditor";
import { validateDrawings, type ChartDrawing } from "./chartWorkspace";

const fork = { id:"fork", kind:"pitchfork", start:{time:100,price:20}, end:{time:200,price:50}, offset:{time:300,price:30}, color:"#ffffff", extendRight:true } as ChartDrawing;
const project = (a: {time:number;price:number}) => ({x:a.time,y:100-a.price});

it("round-trips the three anchors and extensions without adding foreign midpoint flags", () => {
  expect(validateDrawings([fork])).toEqual([fork]);
  expect(validateDrawings([{...fork,extendLeft:true,middleLine:true}])).toEqual([{...fork,extendLeft:true}]);
  for (const patch of [{offset:null},{offset:{time:100,price:30}},{offset:fork.end},{offset:{time:300,price:NaN}},{extendRight:"yes"}]) {
    expect(validateDrawings([{...fork,...patch}])).toEqual([]);
  }
});

it("draws the median through the projected B/C midpoint and parallel tines through B and C", () => {
  const lines=drawingStrokes([fork],project,500,200);
  expect(lines).toHaveLength(3);
  expect(lines[0]!.start).toEqual({x:100,y:80});
  const slope=(line:typeof lines[number])=>(line.end.y-line.start.y)/(line.end.x-line.start.x);
  expect(slope(lines[0]!)).toBeCloseTo(-20/150);
  expect(lines[1]!.start).toEqual(project(fork.end!));
  expect(lines[2]!.start).toEqual(project(fork.offset!));
  for(const line of lines){expect(line.end.x).toBe(500);expect(slope(line)).toBeCloseTo(-20/150);}
  expect(drawingHandles(fork,project,500,200).map(h=>h.part)).toEqual(["start","end","offset"]);
  expect(hitTestDrawings([fork],"fork",project,500,200,project(fork.offset!))?.part).toBe("offset");
});

it.each([false,true])("uses displayed geometry on log scales (inverted=%s), without requiring a fabricated midpoint candle", inverted => {
  const times=new Map([[100,10],[200,50],[300,90]]);
  const p=(a:{time:number;price:number})=>times.has(a.time)?{x:times.get(a.time)!,y:(inverted?1:-1)*Math.log(a.price)+100}:null;
  const lines=drawingStrokes([fork],p,200,200);
  expect(lines).toHaveLength(3);
  const a=p(fork.start)!,b=p(fork.end!)!,c=p(fork.offset!)!;
  const expected=((b.y+c.y)/2-a.y)/((b.x+c.x)/2-a.x);
  for(const line of lines)expect((line.end.y-line.start.y)/(line.end.x-line.start.x)).toBeCloseTo(expected);
});

it("extends both directions, preserves hidden state and withholds missing anchor geometry",()=>{
  const lines=drawingStrokes([{...fork,extendLeft:true}],project,500,200);
  expect(lines).toHaveLength(3);
  for(const line of lines){expect(line.start.x).toBe(0);expect(line.end.x).toBe(500);}
  expect(drawingStrokes([{...fork,hidden:true}],project,500,200)).toEqual([]);
  expect(drawingStrokes([fork],a=>a.time===300?null:project(a),500,200)).toEqual([]);
  const finite=drawingStrokes([{...fork,extendRight:false}],project,500,200);
  expect(finite.map(line=>[line.start.x,line.end.x])).toEqual([[100,250],[200,350],[300,450]]);
});

it("moves all three anchors by real bar indices across gaps and rejects crossing the origin",()=>{
  const times=[100,200,300,1000,1100];
  const projection:DrawingProjection={candles:()=>times.map(time=>({time,open:10,high:100,low:1,close:20})),project:a=>({x:times.indexOf(a.time)*10,y:100-a.price}),anchor:p=>times[Math.round(p.x/10)]?{time:times[Math.round(p.x/10)]!,price:100-p.y}:null,price:y=>100-y,size:()=>({width:40,height:100})};
  expect(moveDrawing(fork,"body",{x:0,y:80},{x:10,y:70},projection,false)).toEqual({...fork,start:{time:200,price:30},end:{time:300,price:60},offset:{time:1000,price:40}});
  expect(moveDrawing(fork,"offset",{x:20,y:70},{x:0,y:70},projection,false)).toBeNull();
});
