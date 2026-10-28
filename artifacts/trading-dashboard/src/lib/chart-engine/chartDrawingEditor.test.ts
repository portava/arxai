import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartDrawingEditor, moveDrawing, type DrawingProjection } from "./chartDrawingEditor";
import { drawingStrokes, hitTestDrawings } from "./chartDrawingPrimitive";
import { validateDrawings, type ChartDrawing } from "./chartWorkspace";

// Deliberately irregular dates: movement must preserve bar distance, not invent weekend timestamps.
const candles = [100, 160, 220, 1000, 1060, 1120].map(time => ({time,open:10,high:20,low:5,close:15}));
const trend: ChartDrawing = {id:"trend",kind:"trend",start:{time:160,price:10},end:{time:1000,price:20},color:"#ffffff"};
const projection: DrawingProjection = {
  candles:()=>candles,
  project:(anchor,priceOnly)=>{const i=candles.findIndex(c=>c.time===anchor.time);return i<0&&!priceOnly ? null : {x:priceOnly?0:i*50,y:100-anchor.price};},
  anchor:(point,snap)=>{const bar=candles[Math.round(point.x/50)];return bar?{time:bar.time,price:snap?bar.close:100-point.y}:null;},
  price:y=>100-y,
  size:()=>({width:250,height:100}),
};
const editors: ChartDrawingEditor[]=[];
afterEach(()=>{editors.splice(0).forEach(editor=>editor.destroy());document.body.innerHTML="";});
function fixture(drawings=[trend]) {
  const container=document.createElement("div"),canvas=document.createElement("canvas");container.append(canvas);document.body.append(container);
  const render=vi.fn(),select=vi.fn(),freeze=vi.fn(),onSelect=vi.fn(),onCommit=vi.fn();
  const editor=new ChartDrawingEditor(container,{...projection,render,select,freeze});editors.push(editor);
  editor.setDrawings(drawings);editor.configure({selectedId:"trend",snap:false,onSelect,onCommit});
  const pointer=(kind:string,x:number,y:number,id=1,target:EventTarget=canvas)=>{
    const event=new MouseEvent(kind,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0});
    Object.defineProperty(event,"pointerId",{value:id});target.dispatchEvent(event);
  };
  return {editor,render,select,freeze,onSelect,onCommit,pointer,canvas,container};
}
describe("analysis-only drawing editing",()=>{
  it("moves a text card by its real anchor even when the pointer begins over whitespace",()=>{
    const note:ChartDrawing={id:"note",kind:"text",start:{time:160,price:10},color:"#ffffff",text:"My observation"};
    const moved=moveDrawing(note,"body",{x:310,y:65},{x:360,y:55},projection,true)!;
    expect(moved).toEqual({...note,start:{time:220,price:20}});
    expect(moveDrawing(note,"start",{x:50,y:90},{x:200,y:82},projection,true)?.start).toEqual({time:1060,price:15});
    expect(moveDrawing(note,"body",{x:310,y:65},{x:610,y:55},projection,false)).toBeNull();
    expect(moveDrawing({...note,start:{time:1,price:10}},"body",{x:50,y:90},{x:100,y:80},projection,false)).toBeNull();
  });
  it("commits a note drag once and keeps a locked note selected without moving it",()=>{
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({measureText:(text:string)=>({width:text.length*6})} as any);
    const note:ChartDrawing={id:"note",kind:"text",start:{time:160,price:10},color:"#ffffff",text:"My observation"};
    const f=fixture([note]);
    f.editor.configure({selectedId:null,snap:false,onSelect:f.onSelect,onCommit:f.onCommit});
    f.pointer("pointerdown",70,65);f.pointer("pointermove",120,55);f.pointer("pointerup",120,55);
    expect(f.onSelect).toHaveBeenLastCalledWith("note");
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith([{...note,start:{time:220,price:20}}]);
    f.editor.setDrawings([{...note,locked:true}]);f.onCommit.mockClear();
    f.pointer("pointerdown",70,65);f.pointer("pointermove",120,55);f.pointer("pointerup",120,55);
    expect(f.onSelect).toHaveBeenLastCalledWith("note");
    expect(f.onCommit).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("moves both anchors by candle indices and clamps the object inside loaded history",()=>{
    const moved=moveDrawing(trend,"body",{x:100,y:85},{x:150,y:75},projection,false)!;
    expect(moved.start).toEqual({time:220,price:20});expect(moved.end).toEqual({time:1060,price:30});
    const clamped=moveDrawing(trend,"body",{x:100,y:85},{x:250,y:85},projection,false)!;
    expect(clamped.start.time).toBe(1000);expect(clamped.end!.time).toBe(1120);
    expect(moveDrawing(trend,"end",{x:150,y:80},{x:50,y:70},projection,false)).toBeNull();
  });
  it("translates logarithmic prices in screen space and snaps only handles",()=>{
    const log={...projection,project:(a:any)=>({x:candles.findIndex(c=>c.time===a.time)*50,y:Math.log(a.price)*10}),price:(y:number)=>Math.exp(y/10)};
    const moved=moveDrawing(trend,"body",{x:100,y:25},{x:100,y:35},log,true)!;
    expect(moved.start.price/trend.start.price).toBeCloseTo(Math.E);
    expect(moved.end!.price/trend.end!.price).toBeCloseTo(Math.E);
    expect(moveDrawing(trend,"end",{x:150,y:80},{x:200,y:82},projection,true)?.end).toEqual({time:1060,price:15});
  });
  it("keeps price-only levels usable when their original time has rolled off",()=>{
    const level:ChartDrawing={...trend,kind:"horizontal",start:{time:1,price:10},end:undefined};
    expect(moveDrawing(level,"body",{x:50,y:90},{x:100,y:70},projection,false)?.start).toEqual({time:1,price:30});
    expect(moveDrawing({...trend,kind:"vertical",end:undefined},"body",{x:50,y:90},{x:100,y:60},projection,false)?.start).toEqual({time:220,price:10});
  });
  it("selects topmost geometry and gives selected handles precedence",()=>{
    expect(hitTestDrawings([trend,{...trend,id:"top"}],null,projection.project,250,100,{x:100,y:85})?.id).toBe("top");
    expect(hitTestDrawings([trend,{...trend,id:"top"}],"trend",projection.project,250,100,{x:50,y:90})).toEqual({id:"trend",part:"start"});
    expect(hitTestDrawings([{...trend,locked:true}],"trend",projection.project,250,100,{x:50,y:90})?.part).toBe("body");
    expect(hitTestDrawings([trend],null,projection.project,250,100,{x:100,y:20})).toBeNull();
  });
  it("projects rays, extended lines, verticals and rectangles without adding market points",()=>{
    const shapes=(["ray","extended","vertical","rectangle"] as const).map((kind,i)=>({...trend,id:String(i),kind,...(kind==="vertical"?{end:undefined}:{})}));
    const strokes=drawingStrokes(shapes,projection.project,250,100);
    expect(strokes).toHaveLength(7);
    expect(strokes[0]).toMatchObject({start:{x:50,y:90},end:{x:250,y:70}});
    expect(strokes[1]).toMatchObject({start:{x:0,y:95},end:{x:250,y:70}});
    expect(strokes[2]).toMatchObject({start:{x:50,y:0},end:{x:50,y:100}});
    expect(validateDrawings(shapes)).toHaveLength(4);
    expect(validateDrawings([{...trend,width:9},{...trend,locked:"true"}])).toEqual([]);
  });
  it("commits one drag after many previews, and restores pan/scale handling",()=>{
    const f=fixture();f.pointer("pointerdown",100,85);
    for(let y=80;y>=65;y-=5)f.pointer("pointermove",150,y);
    expect(f.onCommit).not.toHaveBeenCalled();
    f.pointer("pointerup",150,65);
    expect(f.onCommit).toHaveBeenCalledTimes(1);
    expect(f.onCommit.mock.calls[0]![0][0].start).toEqual({time:220,price:30});
    expect(f.freeze.mock.calls).toEqual([[true],[false]]);
  });
  it("cancels pointer loss, Escape, blur and replacement snapshots without persisting previews",()=>{
    for(const exit of ["pointercancel","Escape","blur","replace"]) {
      const f=fixture();f.pointer("pointerdown",100,85);f.pointer("pointermove",150,70);
      if(exit==="pointercancel")f.pointer(exit,150,70);
      else if(exit==="Escape")window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}));
      else if(exit==="blur")window.dispatchEvent(new Event("blur"));
      else f.editor.setDrawings([]);
      expect(f.render).toHaveBeenLastCalledWith([trend]);expect(f.onCommit).not.toHaveBeenCalled();
      expect(f.freeze).toHaveBeenLastCalledWith(false);f.editor.destroy();
    }
  });
  it("locks geometry, ignores foreign pointers and leaves empty-space pan available",()=>{
    const f=fixture([{...trend,locked:true}]);f.pointer("pointerdown",100,85);f.pointer("pointermove",150,65);f.pointer("pointerup",150,65);
    expect(f.onSelect).toHaveBeenCalledWith("trend");expect(f.freeze).not.toHaveBeenCalled();expect(f.onCommit).not.toHaveBeenCalled();
    f.editor.setDrawings([trend]);f.pointer("pointerdown",100,85);f.pointer("pointermove",150,65,2);f.pointer("pointerup",150,65,2);
    expect(f.onCommit).not.toHaveBeenCalled();f.pointer("pointercancel",100,85);
    const event=new MouseEvent("pointerdown",{bubbles:true,cancelable:true,clientX:100,clientY:20});f.canvas.dispatchEvent(event);expect(event.defaultPrevented).toBe(false);
  });
  it("places only tapped loaded candles, and releases all listeners on destroy",()=>{
    const f=fixture(),place=vi.fn();f.editor.setPlacement(place);
    f.pointer("pointerdown",100,85);f.pointer("pointerup",100,85);expect(place).toHaveBeenCalledWith({time:220,price:15});
    f.pointer("pointerdown",100,85);f.pointer("pointerup",150,85);expect(place).toHaveBeenCalledTimes(1);
    f.pointer("pointerdown",100,120);f.pointer("pointerup",100,120);expect(place).toHaveBeenCalledTimes(1);
    f.editor.destroy();f.pointer("pointerdown",100,85);f.pointer("pointerup",100,85);expect(place).toHaveBeenCalledTimes(1);
  });
});
