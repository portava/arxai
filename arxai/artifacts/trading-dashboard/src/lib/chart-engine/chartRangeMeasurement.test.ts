import { describe,it,expect } from "vitest";
import { measurementLabels,rangeMeasurement } from "./chartRangeMeasurement";
import { validateDrawings,type ChartDrawing } from "./chartWorkspace";
import { drawingStrokes,drawingHandles,hitTestDrawings } from "./chartDrawingPrimitive";

const ruler:ChartDrawing={id:"measure",kind:"measure",start:{time:100,price:100},end:{time:172900,price:110},color:"#ffffff"};
describe("price and calendar-time ruler",()=>{
  it("measures direction from the first anchor without inventing bars across closed sessions",()=>{
    expect(rangeMeasurement(ruler.start,ruler.end!)).toEqual({priceChange:10,percentChange:10,elapsedSeconds:172800,backwards:false});
    expect(measurementLabels(ruler.start,ruler.end!)).toEqual(["Price +10 (+10%)","2d elapsed"]);
    expect(rangeMeasurement(ruler.end!,ruler.start)?.percentChange).toBeCloseTo(-9.09090909);
    expect(measurementLabels(ruler.end!,ruler.start)[1]).toBe("2d elapsed · earlier");
  });
  it("supports a vertical same-candle range and zero price change",()=>{
    const vertical={...ruler,end:{time:100,price:90}};
    expect(validateDrawings([vertical])).toEqual([vertical]);
    expect(measurementLabels(vertical.start,vertical.end)).toEqual(["Price -10 (-10%)","0s elapsed"]);
    expect(measurementLabels(ruler.start,{time:160,price:100})).toEqual(["Price 0 (0%)","1m elapsed"]);
    expect(validateDrawings([{...vertical,kind:"trend"}])).toEqual([]);
  });
  it("retains small price moves and refuses uncomputable percentages",()=>{
    expect(measurementLabels({time:100,price:1.0001},{time:100.5,price:1.0002})[0]).toContain("+0.0001");
    expect(measurementLabels({time:100,price:Number.MIN_VALUE},{time:101,price:1})[0]).toContain("percentage unavailable");
    for(const bad of [0,-1,Infinity,NaN]) expect(rangeMeasurement({time:100,price:bad},ruler.end!)).toBeNull();
  });
  it("does not transform its values when projected on log or inverted scales",()=>{
    for(const scale of [(p:number)=>p,(p:number)=>Math.log(p),(p:number)=>-p]) {
      const lines=drawingStrokes([ruler],a=>({x:a.time/1000,y:scale(a.price)}),400,300);
      expect(lines).toHaveLength(3);expect(lines[0].measurement).toEqual(["Price +10 (+10%)","2d elapsed"]);
      expect(lines[0].end.y).toBe(scale(110));
    }
  });
  it("holds unprojectable anchors and respects hidden drawings",()=>{
    expect(drawingStrokes([ruler],()=>null,400,300)).toEqual([]);
    expect(drawingStrokes([{...ruler,hidden:true}],a=>({x:a.time,y:a.price}),400,300)).toEqual([]);
    expect(validateDrawings([{...ruler,end:undefined}])).toEqual([]);
  });
  it("keeps editable endpoints and hits the measurement line",()=>{
    const d={...ruler,end:{time:200,price:150}},project=(a:{time:number;price:number})=>({x:a.time,y:a.price});
    expect(drawingHandles(d,project,400,300)).toHaveLength(2);
    expect(hitTestDrawings([d],null,project,400,300,{x:150,y:125})).toEqual({id:"measure",part:"body"});
  });
});
