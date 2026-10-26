import { describe, expect, it, vi } from "vitest";
import { SmartChartAnnotationPrimitive, type SmartChartAnnotation } from "./smartChartAnnotation";
const candles=Array.from({length:8},(_,i)=>({time:100+i*90,open:10,high:20,low:9,close:15}));
const annotation:SmartChartAnnotation={id:"pattern",anchors:candles.map(c=>({time:c.time,price:15,label:"Observed pivot"})),color:"#38bdf8",dashed:false};
function fixture(){
  const timeToCoordinate=vi.fn((time:number)=>time),priceToCoordinate=vi.fn((price:number)=>100-price);
  const requestUpdate=vi.fn(),primitive=new SmartChartAnnotationPrimitive();
  primitive.attached({chart:{timeScale:()=>({timeToCoordinate})},series:{priceToCoordinate},requestUpdate} as any);
  const context={save:vi.fn(),restore:vi.fn(),beginPath:vi.fn(),rect:vi.fn(),clip:vi.fn(),setLineDash:vi.fn(),moveTo:vi.fn(),lineTo:vi.fn(),stroke:vi.fn(),arc:vi.fn(),fill:vi.fn(),fillRect:vi.fn(),fillText:vi.fn(),measureText:vi.fn(()=>({width:50}))};
  const draw=()=>primitive.paneViews()[0]!.renderer().draw({useMediaCoordinateSpace:(fn:any)=>fn({context,mediaSize:{width:800,height:400}})} as any);
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
