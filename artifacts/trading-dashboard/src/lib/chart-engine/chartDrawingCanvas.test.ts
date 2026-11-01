import {afterEach,describe,it,expect,vi} from 'vitest';
import * as canvas from './chartDrawingCanvas';
import {ChartDrawingPrimitive,drawingStrokes as compatibleStrokes,drawingNotes as compatibleNotes,hitTestDrawings as compatibleHitTest} from './chartDrawingPrimitive';
import type {ChartDrawing} from './chartWorkspace';
import {NOTE_FONT} from './chartTextNote';
const {paintChartDrawings,drawingStrokes,drawingNotes,drawingHandles,hitTestDrawings}=canvas;
function context(){
 const calls:{name:string;args:any[];color:string;width:number;dash:number[];font:string}[]=[],stack:any[]=[];
 const ctx:any={strokeStyle:'#old',fillStyle:'#old',lineWidth:9,font:'17px old',textBaseline:'middle',textAlign:'center',dash:[7],save:vi.fn(()=>stack.push({strokeStyle:ctx.strokeStyle,fillStyle:ctx.fillStyle,lineWidth:ctx.lineWidth,font:ctx.font,textBaseline:ctx.textBaseline,textAlign:ctx.textAlign,dash:[...ctx.dash]})),restore:vi.fn(()=>Object.assign(ctx,stack.pop())),setLineDash:vi.fn((dash:number[])=>{ctx.dash=dash;}),measureText:vi.fn((text:string)=>({width:text.length*6}))};
 for(const name of ['beginPath','rect','clip','moveTo','lineTo','stroke','fillText','arc','fill','fillRect','strokeRect'])ctx[name]=vi.fn((...args:any[])=>calls.push({name,args,color:name==='stroke'?ctx.strokeStyle:ctx.fillStyle,width:ctx.lineWidth,dash:[...ctx.dash],font:ctx.font}));
 return {ctx:ctx as CanvasRenderingContext2D,calls,stack};
}
const project=(anchor:{time:number;price:number})=>({x:anchor.time,y:100-anchor.price});
const stroke=(patch:Partial<canvas.DrawingStroke>={}):canvas.DrawingStroke=>({id:'line',start:{x:20,y:30},end:{x:150,y:80},color:'#123456',dashed:true,width:3,...patch});
afterEach(()=>vi.restoreAllMocks());
describe('shared vendor-independent ARX drawing painter',()=>{
 it('keeps compatibility exports on the same geometry and hit-test implementation',()=>{
  expect(compatibleStrokes).toBe(drawingStrokes);expect(compatibleNotes).toBe(drawingNotes);expect(compatibleHitTest).toBe(hitTestDrawings);
 });
 it('clips the plot, excludes wholly offscreen strokes and preserves crossing anchors/styles',()=>{
  const {ctx,calls,stack}=context();const input=[stroke(),stroke({id:'outside',start:{x:-100,y:20},end:{x:-1,y:40}}),stroke({id:'cross',start:{x:-40,y:50},end:{x:250,y:50},dashed:false,width:1})];const original=structuredClone(input);
  paintChartDrawings(ctx,{width:200,height:120},input,[],[]);
  expect(calls.find(call=>call.name==='rect')!.args).toEqual([0,0,200,120]);expect(calls.filter(call=>call.name==='stroke')).toHaveLength(2);
  expect(calls.find(call=>call.name==='stroke')).toMatchObject({color:'#123456',width:3,dash:[4,4]});expect(ctx.moveTo).toHaveBeenCalledWith(-40,50);expect(ctx.lineTo).toHaveBeenCalledWith(250,50);
  expect(input).toEqual(original);expect(stack).toEqual([]);expect(ctx.font).toBe('17px old');expect(ctx.textAlign).toBe('center');
 });
 it('measurement readout stays inside the plot and preserves the real price/time labels',()=>{
  const drawing:ChartDrawing={id:'m',kind:'measure',start:{time:60,price:10},end:{time:180,price:12},color:'#123456'};
  const strokes=drawingStrokes([drawing],project,200,120),{ctx,calls,stack}=context();paintChartDrawings(ctx,{width:200,height:120},strokes,[],[]);
  expect(strokes[0]!.measurement).toEqual(['Price +2 (+20%)','2m elapsed']);expect(ctx.fillText).toHaveBeenCalledWith('Price +2 (+20%)',expect.any(Number),expect.any(Number));
  const card=calls.find(call=>call.name==='fillRect')!.args;expect(card[0]).toBeGreaterThanOrEqual(4);expect(card[0]+card[2]).toBeLessThanOrEqual(196);expect(card[1]+card[3]).toBeLessThanOrEqual(116);expect(stack).toEqual([]);
 });
 it('narrow plots retain ruler strokes without cramped measurement text',()=>{
  const {ctx}=context();paintChartDrawings(ctx,{width:90,height:40},[stroke({measurement:['Price +2 (+20%)','2m elapsed']})],[],[]);expect(ctx.stroke).toHaveBeenCalledOnce();expect(ctx.fillText).not.toHaveBeenCalled();
 });
 it('paints literal user notes, continuation wording, anchor dot and selection handles last',()=>{
  const drawing:ChartDrawing={id:'n',kind:'text',start:{time:100,price:20},color:'#123456',text:'<b>User observation</b>\nSecond line\nThird line'};
  const notes=drawingNotes([drawing],project,220,72,text=>text.length*6),handles=drawingHandles(drawing,project,220,72).map(handle=>handle.point),{ctx,calls,stack}=context();
  // Anchor is outside72px; no pinned note is invented.
  expect(notes).toEqual([]);
  drawing.start.price=50;const visible=drawingNotes([drawing],project,220,72,text=>text.length*6);paintChartDrawings(ctx,{width:220,height:72},[],visible,handles);
  expect(ctx.fillText).toHaveBeenCalledWith('Your note',expect.any(Number),expect.any(Number),expect.any(Number));expect(ctx.fillText).toHaveBeenCalledWith('More in Objects',expect.any(Number),expect.any(Number),expect.any(Number));
  expect(calls.filter(call=>call.name==='fillText').every(call=>call.font===NOTE_FONT)).toBe(true);expect(calls.filter(call=>call.name==='arc').at(-1)!.args[2]).toBe(5);expect(stack).toEqual([]);
  const full=drawingNotes([drawing],project,260,150,text=>text.length*6);const other=context();paintChartDrawings(other.ctx,{width:260,height:150},[],full,[]);expect(other.ctx.fillText).toHaveBeenCalledWith('<b>User observation</b>',expect.any(Number),expect.any(Number),expect.any(Number));
 });
 it('keeps Fibonacci level labels and their stored geometry unchanged',()=>{
  const drawing:ChartDrawing={id:'fib',kind:'fibonacci',start:{time:60,price:20},end:{time:180,price:10},color:'#ffffff'},lines=drawingStrokes([drawing],project,250,120),{ctx,calls}=context();
  paintChartDrawings(ctx,{width:250,height:120},lines,[],[]);expect(calls.filter(call=>call.name==='fillText').map(call=>call.args[0])).toEqual(lines.map(line=>line.label));expect(lines).toHaveLength(7);
 });
 it('restores nested measurement state and propagates a drawing error',()=>{
  const {ctx,stack}=context();vi.mocked(ctx.fillText).mockImplementation(()=>{throw Error('paint failed');});
  expect(()=>paintChartDrawings(ctx,{width:200,height:120},[stroke({measurement:['A','B']})],[],[])).toThrow('paint failed');expect(stack).toEqual([]);expect(ctx.save).toHaveBeenCalledTimes(2);expect(ctx.restore).toHaveBeenCalledTimes(2);
 });
 it('existing primitive delegates to exactly the shared paint pass with projected geometry',()=>{
  const spy=vi.spyOn(canvas,'paintChartDrawings'),primitive=new ChartDrawingPrimitive(),{ctx}=context();
  primitive.attached({chart:{timeScale:()=>({timeToCoordinate:(time:number)=>time,width:()=>250})},series:{priceToCoordinate:(price:number)=>100-price,getPane:()=>({getHeight:()=>120}),priceFormatter:()=>({format:String})},requestUpdate:vi.fn()} as any);
  const drawing:ChartDrawing={id:'line',kind:'trend',start:{time:60,price:10},end:{time:180,price:20},color:'#123456'};
  primitive.setData([drawing],[60,180].map(time=>({time,open:10,high:20,low:10,close:15})));primitive.setSelection('line');
  primitive.paneViews()[0]!.renderer()!.draw({useMediaCoordinateSpace:(draw:any)=>draw({context:ctx,mediaSize:{width:250,height:120}})} as any);
  expect(spy).toHaveBeenCalledExactlyOnceWith(ctx,{width:250,height:120},drawingStrokes([drawing],project,250,120),[],drawingHandles(drawing,project,250,120).map(handle=>handle.point));
 });
});
