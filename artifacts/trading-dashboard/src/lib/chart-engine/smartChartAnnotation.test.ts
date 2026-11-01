import { describe, expect, it, vi } from "vitest";
import { SmartChartAnnotationPrimitive, type SmartChartAnnotation } from "./smartChartAnnotation";
const candles=Array.from({length:8},(_,i)=>({time:100+i*90,open:10,high:20,low:9,close:15}));
const annotation:SmartChartAnnotation={id:"pattern",anchors:candles.map(c=>({time:c.time,price:15,label:"Observed pivot"})),color:"#38bdf8",dashed:false};
function fixture(){
  const timeToCoordinate=vi.fn((time:number)=>time),priceToCoordinate=vi.fn((price:number)=>100-price);
  const requestUpdate=vi.fn(),primitive=new SmartChartAnnotationPrimitive();
  primitive.attached({chart:{timeScale:()=>({timeToCoordinate})},series:{priceToCoordinate},requestUpdate} as any);
  const context={save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),setLineDash:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),arc:vi.fn(),fill:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),measureText:vi.fn((_text:string)=>({width:50}))};
  const draw=(width=800,height=400)=>primitive.paneViews()[0]!.renderer().draw({useMediaCoordinateSpace:(fn:any)=>fn({context,mediaSize:{width,height}})} as any);
  return {primitive,context,draw,timeToCoordinate,priceToCoordinate,requestUpdate};
}
describe("one focused automatic annotation",()=>{
  it("draws only real candle geometry with at most three nonoverlapping labels",()=>{
    const f=fixture();f.primitive.setData(annotation,candles);f.draw();
    expect(f.context.fillText).toHaveBeenCalledTimes(3);expect(f.context.arc).toHaveBeenCalledTimes(8);
    expect(f.context.moveTo).toHaveBeenCalledWith(100,85);expect(f.context.lineTo).toHaveBeenLastCalledWith(730,85);
    expect(f.primitive).not.toHaveProperty("autoscaleInfo");expect(f.primitive).not.toHaveProperty("hitTest");
    expect(f.context.save).toHaveBeenCalledTimes(f.context.restore.mock.calls.length);
  });
  it("never snaps a missing anchor to a different candle",()=>{
    const f=fixture();f.primitive.setData(annotation,candles.slice(1));f.draw();
    expect(f.context.stroke).not.toHaveBeenCalled();expect(f.timeToCoordinate).not.toHaveBeenCalledWith(100);
  });
  it("draws a sloped neckline between its observed times and prices",()=>{
    const f=fixture();f.primitive.setData({...annotation,guide:{from:{time:190,price:10},to:{time:460,price:14}}},candles);f.draw();
    expect(f.context.moveTo).toHaveBeenLastCalledWith(190,90);expect(f.context.lineTo).toHaveBeenLastCalledWith(460,86);
  });
  it("clears on null, invalid geometry, or detachment",()=>{
    const f=fixture();f.primitive.setData(annotation,candles);f.primitive.setData(null,candles);f.draw();
    f.primitive.setData({...annotation,anchors:[{time:100,price:Infinity,label:"Bad"}]},candles);f.draw();
    f.primitive.setData(annotation,candles);f.primitive.detached();f.draw();
    expect(f.context.stroke).not.toHaveBeenCalled();
  });
});

it("keeps event anchors and reference levels without inventing a diagonal connecting path",()=>{
 const f=fixture();f.primitive.setData({...annotation,connectAnchors:false,anchors:[{time:100,price:15,label:"broken level"},{time:280,price:14,label:"retest"}],level:{price:15,label:"Broken level"}},candles);f.draw();
 expect(f.context.arc).toHaveBeenCalledTimes(2);expect(f.context.fillText).toHaveBeenCalledTimes(2);
 expect(f.context.lineTo.mock.calls).toEqual([[280,85]]);
 expect(f.context.stroke).toHaveBeenCalledTimes(1);
});
it("refuses malformed connection semantics instead of guessing",()=>{
 const f=fixture();f.primitive.setData({...annotation,connectAnchors:"false" as any},candles);f.draw();
 expect(f.context.stroke).not.toHaveBeenCalled();
});

const rectanglesOverlap=(a:number[],b:number[])=>a[0]!<b[0]!+b[2]!&&a[0]!+a[2]!>b[0]!&&a[1]!<b[1]!+b[3]!&&a[1]!+a[3]!>b[1]!;
it("packs nearby selected-finding labels on available sides without moving candle anchors",()=>{
 const f=fixture();f.timeToCoordinate.mockImplementation(time=>time===100?100:110);
 f.primitive.setData({...annotation,connectAnchors:false,anchors:[{time:100,price:15,label:"First event"},{time:190,price:15,label:"Second event"}]},candles);f.draw();
 expect(f.context.arc.mock.calls.map(c=>c.slice(0,2))).toEqual([[100,85],[110,85]]);
 expect(f.context.fillText).toHaveBeenCalledTimes(2);
 const boxes=f.context.fillRect.mock.calls as number[][];expect(rectanglesOverlap(boxes[0]!,boxes[1]!)).toBe(false);
 for(const box of boxes)for(const [x,y] of [[100,85],[110,85]])expect(rectanglesOverlap(box,[x!-4,y!-4,8,8])).toBe(false);
});
it("keeps labels inside narrow plot boundaries with measured ellipsis rather than clipping or shrinking the font",()=>{
 const f=fixture();f.context.measureText.mockImplementation((text:string)=>({width:text.length*7}));
 f.timeToCoordinate.mockReturnValue(55);f.priceToCoordinate.mockReturnValue(1);
 f.primitive.setData({...annotation,connectAnchors:false,anchors:[{time:100,price:15,label:"A long descriptive observed event"}]},candles);f.draw(60,100);
 expect(f.context.arc).toHaveBeenCalledWith(55,1,3,0,Math.PI*2);
 expect(f.context.fillText).toHaveBeenCalledTimes(1);
 const [x,y,width,height]=f.context.fillRect.mock.calls[0]!;expect(x).toBeGreaterThanOrEqual(4);expect(y).toBeGreaterThanOrEqual(4);expect(x+width).toBeLessThanOrEqual(56);expect(y+height).toBeLessThanOrEqual(96);
 expect(f.context.fillText.mock.calls[0]![0]).toMatch(/…$/);
});
it("omits text when the plot cannot fit it but retains the exact observed point",()=>{
 const f=fixture();f.timeToCoordinate.mockReturnValue(8);f.priceToCoordinate.mockReturnValue(8);
 f.primitive.setData({...annotation,connectAnchors:false,anchors:[{time:100,price:15,label:"Event"}]},candles);f.draw(16,16);
 expect(f.context.arc).toHaveBeenCalledWith(8,8,3,0,Math.PI*2);expect(f.context.fillText).not.toHaveBeenCalled();expect(f.context.fillRect).not.toHaveBeenCalled();
});

it("uses explicit left/alphabetic text alignment regardless of inherited canvas state",()=>{
 const f=fixture(),context=f.context as typeof f.context&{textAlign:string;textBaseline:string};
 context.textAlign="right";context.textBaseline="middle";
 const states:{align:string;baseline:string}[]=[];
 context.fillText.mockImplementation(()=>{states.push({align:context.textAlign,baseline:context.textBaseline});});
 f.primitive.setData(annotation,candles);f.draw();
 expect(states).toHaveLength(3);expect(states.every(s=>s.align==="left"&&s.baseline==="alphabetic")).toBe(true);
});
