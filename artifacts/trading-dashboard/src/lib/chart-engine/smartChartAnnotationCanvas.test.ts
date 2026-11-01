import { describe,expect,it,vi } from "vitest";
import { cloneSmartChartAnnotation,paintSmartChartAnnotation,type SmartChartAnnotation } from "./smartChartAnnotationCanvas";
import { cloneSmartChartAnnotation as compatibilityClone,paintSmartChartAnnotation as compatibilityPaint } from "./smartChartAnnotation";
const example:SmartChartAnnotation={id:"evidence",anchors:[{time:100,price:10,label:"First"},{time:200,price:20,label:"Second"}],connectAnchors:false,segments:[{from:{time:100,price:10},to:{time:200,price:20}}],guide:{from:{time:100,price:12},to:{time:200,price:18}},level:{price:15,label:"Level"},color:"#38bdf8",dashed:true};
function fixture(){
 const ctx={save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),setLineDash:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),arc:vi.fn(),fill:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),measureText:vi.fn((text:string)=>({width:text.length*6}))};
 const project={timeToX:vi.fn((time:number):number|null=>[100,200].includes(time)?time:null),priceToY:vi.fn((price:number):number|null=>100-price)};
 const draw=(annotation:SmartChartAnnotation|null=example,size={width:300,height:200})=>paintSmartChartAnnotation(ctx as unknown as CanvasRenderingContext2D,size,annotation,project);
 return {ctx,project,draw};
}
describe("shared observed annotation Canvas",()=>{
 it("reexports the same implementation for the existing renderer",()=>{expect(compatibilityClone).toBe(cloneSmartChartAnnotation);expect(compatibilityPaint).toBe(paintSmartChartAnnotation);});
 it("copies every nested evidence value without freezing or retaining caller objects",()=>{
  const input=structuredClone(example),copy=cloneSmartChartAnnotation(input)!;expect(copy).toEqual(input);expect(Object.isFrozen(input)).toBe(false);
  input.anchors[0]!.price=90;input.segments![0]!.from.time=300;input.guide!.to.price=99;input.level!.price=999;
  expect(copy).toEqual(example);copy.anchors[1]!.price=777;expect(input.anchors[1]!.price).toBe(20);
 });
 it.each([null,{}, {anchors:null}, {anchors:[null]}, {anchors:[{time:100,price:10,label:4}]}, {segments:[{}]}, {guide:{from:{time:100,price:10}}}, {level:{price:12}}, {color:"red"}, {dashed:"false"}])("withholds malformed shape %j",patch=>{
  const input=patch===null?null:Object.keys(patch).length?{...example,...patch}:{};
  expect(()=>cloneSmartChartAnnotation(input as any)).not.toThrow();expect(cloneSmartChartAnnotation(input as any)).toBeNull();const f=fixture();expect(()=>f.draw(input as any)).not.toThrow();expect(f.ctx.save).not.toHaveBeenCalled();
 });
 it("preserves exact separate paths, reference level and guide without an invented connector",()=>{
  const f=fixture();f.draw();expect(f.ctx.moveTo.mock.calls).toEqual([[100,90],[100,85],[100,88]]);expect(f.ctx.lineTo.mock.calls).toEqual([[200,80],[200,85],[200,82]]);expect(f.ctx.stroke).toHaveBeenCalledTimes(3);expect(f.ctx.rect).toHaveBeenCalledWith(0,0,300,200);expect(f.ctx.save).toHaveBeenCalledOnce();expect(f.ctx.restore).toHaveBeenCalledOnce();
 });
 it.each(["anchor","segment"])("withholds rather than snapping absent %s timestamps",which=>{
  const f=fixture(),a=structuredClone(example);if(which==="anchor")a.anchors[0]!.time=101;else a.segments![0]!.from.time=101;
  f.draw(a);expect(f.ctx.stroke).not.toHaveBeenCalled();expect(f.ctx.arc).not.toHaveBeenCalled();
 });
 it("an unobserved optional guide is omitted while observed primary evidence remains",()=>{
  const f=fixture(),a=structuredClone(example);a.guide!.from.time=101;f.draw(a);expect(f.ctx.stroke).toHaveBeenCalledTimes(2);expect(f.ctx.arc).toHaveBeenCalledTimes(2);
 });
 it("rejects nonfinite mapped anchors and invalid plot dimensions",()=>{
  const f=fixture();f.project.priceToY.mockReturnValue(NaN);f.draw();expect(f.ctx.save).not.toHaveBeenCalled();f.project.priceToY.mockReturnValue(10);f.draw(example,{width:Infinity,height:100});f.draw(example,{width:100,height:0});expect(f.ctx.save).not.toHaveBeenCalled();
 });
 it("restores the host Canvas even if annotation text painting throws",()=>{
  const f=fixture();f.ctx.fillText.mockImplementation(()=>{throw new Error("text failed");});expect(()=>f.draw()).toThrow("text failed");expect(f.ctx.restore).toHaveBeenCalledOnce();
 });
 it("caps packed labels at three and leaves exact anchor coordinates unchanged",()=>{
  const f=fixture();f.project.timeToX.mockImplementation(time=>time);const a={...example,segments:undefined,guide:undefined,level:undefined,anchors:[30,100,170,240].map(time=>({time,price:10,label:"Observed"}))};
  f.draw(a);expect(f.ctx.arc.mock.calls.map(call=>call.slice(0,2))).toEqual([[30,90],[100,90],[170,90],[240,90]]);expect(f.ctx.fillText).toHaveBeenCalledTimes(3);
 });
});
