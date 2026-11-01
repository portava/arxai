import { describe, expect, it } from "vitest";
import { createNativePriceFrame, prepareNativePriceSeries } from "./nativePriceRenderer";
import { nativePlotLayout, nativePriceTicks, nativeTimeTicks, paintNativeAxes } from "./nativeChartAxes";
import type { ChartScaleMode } from "./chartWorkspace";

const bars = Array.from({ length: 200 }, (_, i) => ({ time: 1_730_613_600 + i * 60, open: 100 + i / 10, close: 100.04 + i / 10, high: 101 + i / 10, low: 99 + i / 10 }));
function make(scale: ChartScaleMode = "linear", inverted = false, input = bars) {
  const result = createNativePriceFrame(prepareNativePriceSeries(input), { plot: nativePlotLayout(900, 400)!, range: { from: -2, to: input.length + 1 }, style: "candles", scale, inverted, referencePrice: 100 });
  if (!result.ok) throw new Error(result.reason);
  return result.frame;
}

it("leaves a real plot and separate axes at mobile and desktop CSS widths", () => {
  for (const width of [240, 390, 900]) {
    const plot = nativePlotLayout(width, 400)!;
    expect(plot.width).toBe(width - 96);
    expect(plot.left + plot.width).toBe(width - 88);
    expect(plot.top + plot.height).toBe(368);
  }
});
it.each([[0,400],[900,0],[100,400],[900,40],[NaN,400],[Infinity,400]])("holds invalid/too-small geometry %s × %s", (w,h) => expect(nativePlotLayout(w,h)).toBeNull());

describe.each(["linear", "log", "percent", "indexed"] as const)("%s axis", scale => {
  it.each([false, true])("ticks use the actual price transform, inversion=%s", inverted => {
    const frame = make(scale, inverted), ticks = nativePriceTicks(frame, { priceDigits: 3 });
    expect(ticks.length).toBeGreaterThan(1);
    for (let i = 0; i < ticks.length; i++) {
      const tick = ticks[i]!;
      expect(frame.priceToY(tick.price)).toBeCloseTo(tick.y, 6);
      expect(frame.axisValue(tick.price)).toBeCloseTo(tick.value, 8);
      expect(tick.y).toBeGreaterThanOrEqual(frame.plot.top);
      expect(tick.y).toBeLessThanOrEqual(frame.plot.top + frame.plot.height);
      expect(tick.label.endsWith("%")).toBe(scale === "percent");
      if (i) expect(tick.y - ticks[i-1]!.y).toBeGreaterThanOrEqual(48);
    }
    expect(new Set(ticks.map(t => t.label)).size).toBe(ticks.length);
    expect(ticks[0]!.price > ticks.at(-1)!.price).toBe(!inverted);
  });
});

it("tiny positive ticks never become a misleading zero label", () => {
  const frame = make("linear", false, bars.map(b => ({...b,open:b.open*1e-14,close:b.close*1e-14,high:b.high*1e-14,low:b.low*1e-14})));
  const ticks = nativePriceTicks(frame);
  expect(ticks.length).toBeGreaterThan(1);
  expect(ticks.every(t=>t.label.includes("e-") && Number(t.label)>0)).toBe(true);
});
it("extreme finite magnitudes stay finite and show explicit scientific notation", () => {
  const input = [{ time: 100, open: -1e300, close: 1e300, high: 1e300, low: -1e300 }];
  const ticks = nativePriceTicks(make("linear",false,input));
  expect(ticks.length).toBeGreaterThan(1);
  expect(ticks.every(t=>Number.isFinite(t.y) && Number.isFinite(Number(t.label)))).toBe(true);
});
it("wide logarithmic ranges have useful tick coverage at the correct nonlinear coordinates", () => {
  const ticks = nativePriceTicks(make("log",false,[{time:100,open:1e-100,low:1e-100,close:1e100,high:1e100}]));
  expect(ticks.length).toBeGreaterThan(3);
  expect(ticks.at(-1)!.y - ticks[0]!.y).toBeGreaterThan(200);
});
it("time ticks refer only to loaded observations across a real history gap", () => {
  const input=bars.map((b,i)=>({...b,time:b.time+(i>=100?86400:0)}));
  const frame=make("linear",false,input), ticks=nativeTimeTicks(frame);
  expect(ticks.length).toBeGreaterThan(1);
  for(const tick of ticks){expect(input.some(b=>b.time===tick.time)).toBe(true);expect(frame.timeToX(tick.time)).toBe(tick.x);expect(tick.label).toContain("UTC");}
});
it("display timezone changes labels, never anchor timestamps or coordinates", () => {
  const frame=make(), utc=nativeTimeTicks(frame), ny=nativeTimeTicks(frame,{timeZone:"America/New_York"});
  expect(ny.map(({time,x})=>({time,x}))).toEqual(utc.map(({time,x})=>({time,x})));
  expect(ny.map(t=>t.label)).not.toEqual(utc.map(t=>t.label));
});
it("rejects unrepresentable dates rather than throwing from the painter", () => {
  const frame=make("linear",false,[{...bars[0]!,time:9e12}]);
  expect(nativeTimeTicks(frame)).toEqual([]);
});
it("axes restore canvas state and avoid overlapping/clipped time text", () => {
  const frame=make(), labels:Array<{label:string;x:number;y:number}>=[]; let saves=0,restores=0;
  const ctx={save(){saves++;},restore(){restores++;},beginPath(){},moveTo(){},lineTo(){},stroke(){},measureText(t:string){return {width:t.length*7};},fillText(label:string,x:number,y:number){labels.push({label,x,y});}} as unknown as CanvasRenderingContext2D;
  paintNativeAxes(ctx,frame);
  const times=labels.filter(t=>t.label.includes("UTC"));
  expect(saves).toBe(1);expect(restores).toBe(1);expect(times.length).toBeGreaterThan(1);
  for(let i=0;i<times.length;i++){expect(times[i]!.x).toBeGreaterThanOrEqual(frame.plot.left);expect(times[i]!.x+times[i]!.label.length*7).toBeLessThanOrEqual(frame.plot.left+frame.plot.width);if(i)expect(times[i]!.x).toBeGreaterThan(times[i-1]!.x+times[i-1]!.label.length*7);}
});

it("a valid narrow mobile plot retains a real time label", () => {
  const result=createNativePriceFrame(prepareNativePriceSeries(bars),{plot:nativePlotLayout(240,400)!,range:{from:0,to:199},style:"candles"});
  if(!result.ok)throw Error(result.reason);
  const labels:Array<{label:string;y:number}>=[];
  const ctx={save(){},restore(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},measureText(t:string){return{width:t.length*7};},fillText(label:string,_x:number,y:number){labels.push({label,y});}} as unknown as CanvasRenderingContext2D;
  paintNativeAxes(ctx,result.frame);
  expect(labels.some(t=>t.y>result.frame.plot.top+result.frame.plot.height)).toBe(true);
});
it("rejects a price gutter narrower than its supported label geometry",()=>expect(nativePlotLayout(400,300,32)).toBeNull());
it("keeps adjacent tick labels distinct in a tight high-magnitude range",()=>{
  const input=bars.map(b=>({...b,open:939791+(b.open-100)/1000,high:939791+(b.high-100)/1000,low:939791+(b.low-100)/1000,close:939791+(b.close-100)/1000}));
  const ticks=nativePriceTicks(make("linear",false,input),{priceDigits:6});
  expect(ticks.length).toBeGreaterThan(3);
  for(const tick of ticks)expect(Math.abs(Number(tick.label)-tick.value)).toBeLessThan(0.000001);
});
