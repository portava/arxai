import { describe,it,expect } from "vitest";
import { describeSmartChartWindow,windowQuantile } from "./chartDescriptiveAnalysis";
import { StudyCalculator } from "./chartStudies";
import { selectSmartChartWindow,type SmartChartAnalysisBar,type SmartChartAnalysisInput } from "./smartChartAnalysis";
const context={symbol:"EURUSD",timeframe:"M5",source:"mt5_broker",sourceIdentity:"a".repeat(64)};
const START=1_700_000_000;
function bars(values:number[]):SmartChartAnalysisBar[]{return values.map((close,i)=>({time:START+i*300,closeTime:START+(i+1)*300,open:close,high:close*1.01,low:close*.99,close,isComplete:true,isFinal:true,isForming:false}));}
const input=(values:number[]|SmartChartAnalysisBar[]):SmartChartAnalysisInput=>{const rows=typeof values[0]==="number"?bars(values as number[]):values as SmartChartAnalysisBar[];return {...context,bars:rows,asOfMs:(rows.at(-1)?.closeTime??START)*1000,dataState:"current"};};
const series=(returns:number[])=>returns.reduce((values,r)=>[...values,values.at(-1)!*(1+r/100)],[100]);
const prior=Array.from({length:20},(_,i)=>[1,-1,.5,-.5][i%4]!);
describe("source-bound descriptive window",()=>{
 it("shortens narrative precision without changing measured evidence or tiny-move direction",()=>{
  const regular=describeSmartChartWindow(input([100,100.123456]));
  expect(regular.summary).toContain("price rose 0.12%");
  expect(regular.basics!.changePercent).toBeCloseTo(.123456,10);
  const tiny=describeSmartChartWindow(input([100,100.000001]));
  expect(tiny.summary).toContain("price rose less than 0.01%");
  const falling=describeSmartChartWindow(input([100,99.999999]));
  expect(falling.summary).toContain("price fell less than 0.01%");
  expect(falling.basics!.changePercent).toBeLessThan(0);
  expect(describeSmartChartWindow(input([100,100])).summary).toContain("price stayed level;");
 });
 it("uses explicit type7 quartiles and tied midrank rather than probability",()=>{
  expect(windowQuantile([1,2,3,4],.25)).toBe(1.75);expect(windowQuantile([1,2,3,4],.75)).toBe(3.25);
  const r=describeSmartChartWindow(input([10,20,20,30,20]));
  expect(r.distribution.value).toEqual({q1:20,median:20,q3:20,iqr:0,method:"type7-linear"});
  expect(r.latestCloseMidrankPercent.value).toBe(50);
  expect(r.summary).toContain("5 closed candles");expect(r.summary).toContain("around the middle");
  for(const xs of [[],[NaN],[2,1],[1,,3] as number[]])expect(windowQuantile(xs,.5)).toBeNull();
  expect(windowQuantile([1,2],2)).toBeNull();
 });
 it("fits actual elapsed time, uses clear interval units and never extrapolates",()=>{
  const data=bars([10,12,14,18]);data[3]!.time+=300;data[3]!.closeTime+=300;
  const r=describeSmartChartWindow(input(data));
  expect(r.trend.status).toBe("available");expect(r.trend.value!.slopePerInterval).toBeCloseTo(2,12);
  expect(r.trend.value!.fittedChangePercent).toBeCloseTo(80,10);expect(r.trend.value!.rSquared).toBeCloseTo(1,12);
  expect(r.trend.value!.elapsedIntervals).toBe(4);
  expect(r.cadence).toEqual({irregularSteps:1,elapsedGaps:1,largestSeconds:600});
  expect(r.distribution.status).toBe("available");expect(r.rsi14.status).toBe("unavailable");
 });
 it("does not infer a rising fit just because the endpoints rise",()=>{
  const r=describeSmartChartWindow(input([10,20,18,16,14,12,11]));
  expect(r.basics!.change).toBeGreaterThan(0);expect(r.trend.value!.slopePerInterval).toBeLessThan(0);
  expect(r.trend.value!.rSquared).toBeLessThan(.5);
 });
 it("treats constant closes and insufficient samples explicitly",()=>{
  for(const count of [3,20,599]){
   const r=describeSmartChartWindow(input(Array(count).fill(100)));
   expect(r.trend.value).toMatchObject({slopePerInterval:0,fittedChangePercent:0,rSquared:null});
   expect(r.latestCloseMidrankPercent.value).toBe(50);expect(r.returnStdDevPercent.value).toBe(0);
  }
  const one=describeSmartChartWindow(input([100]));expect(one.trend.status).toBe("unavailable");expect(one.distribution.status).toBe("unavailable");expect(one.returnStdDevPercent.status).toBe("unavailable");
 });
 it("matches actual StudyCalculator Wilder RSI and ATR with visible-only warmup",()=>{
  const data=bars(Array.from({length:60},(_,i)=>100+Math.sin(i)*3+i*.1)),r=describeSmartChartWindow(input(data));
  for(const kind of ["rsi","atr"] as const){const expected=new StudyCalculator({kind,period:14,color:"#000",source:"close",method:"smma"}).calculate(data).at(-1)!.values[0];expect(kind==="rsi"?r.rsi14.value:r.atr14.value).toBe(expected);}
  const fourteen=describeSmartChartWindow(input(data.slice(0,14)));expect(fourteen.rsi14.status).toBe("unavailable");expect(fourteen.atr14.status).toBe("available");expect(fourteen.roc14Percent.status).toBe("unavailable");
  const fifteen=describeSmartChartWindow(input(data.slice(0,15)));expect(fifteen.rsi14.status).toBe("available");expect(fifteen.roc14Percent.value).toBeCloseTo((data[14]!.close/data[0]!.close-1)*100,12);
  const flat=describeSmartChartWindow(input(Array(15).fill(100)));expect(flat.rsi14.value).toBe(50);expect(flat.atr14.value).toBeCloseTo(2,12);
 });
 it("does not borrow hidden warmup bars and discloses the 600-candle cap",()=>{
  const full=input(Array.from({length:700},(_,i)=>100+i*.1));
  const small=describeSmartChartWindow({...full,visibleRange:{from:full.bars[690]!.time,to:full.bars[699]!.time}});
  expect(small.basics!.count).toBe(10);expect(small.rsi14.status).toBe("unavailable");expect(small.atr14.status).toBe("unavailable");
  const capped=describeSmartChartWindow(full);expect(capped.coverage).toMatchObject({available:700,analyzed:600,truncated:true});expect(capped.basics!.first).toBe(110);
 });
 it("requires20 prior returns excluding latest:21 closes fail and22 succeed",()=>{
  const enough=describeSmartChartWindow(input(series([...prior,10])));
  expect(enough.unusualMove.status).toBe("available");expect(enough.unusualMove.value).toMatchObject({priorReturns:20,position:"above"});
  expect(enough.unusualMove.value!.latestReturnPercent).toBeCloseTo(10,10);
  const short=describeSmartChartWindow(input(series([...prior.slice(1),10])));expect(short.unusualMove.status).toBe("unavailable");
 });
 it("the latest huge move cannot shift its own prior-return fence",()=>{
  const a=describeSmartChartWindow(input(series([...prior,1]))).unusualMove.value!;
  const b=describeSmartChartWindow(input(series([...prior,1000]))).unusualMove.value!;
  expect([a.q1,a.q3,a.lowerFence,a.upperFence]).toEqual([b.q1,b.q3,b.lowerFence,b.upperFence]);
  expect(a.position).toBe("inside");expect(b.position).toBe("above");
 });
 it("caps the prior return baseline at120 and does not label past events with future information",()=>{
  const returns=[50,...Array.from({length:120},(_,i)=>prior[i%20]!),10],full=describeSmartChartWindow(input(series(returns)));
  const short=describeSmartChartWindow(input(series(returns.slice(1))));
  expect(full.unusualMove.value!.priorReturns).toBe(120);expect(full.unusualMove.value!.lowerFence).toBeCloseTo(short.unusualMove.value!.lowerFence,10);
  expect(full.unusualMove.value!.upperFence).toBeCloseTo(short.unusualMove.value!.upperFence,10);
  expect(Object.keys(full.unusualMove.value!)).not.toContain("events");
 });
 it("zero prior IQR yields unavailable rather than a fabricated unusual-move threshold",()=>{
  const r=describeSmartChartWindow(input([...Array(21).fill(100),200]));
  expect(r.unusualMove.status).toBe("unavailable");expect(r.unusualMove.reason).toContain("IQR is zero");
 });
 it("withholds cadence metrics across either missing or overlapping intervals",()=>{
  for(const offset of [300,-150]){
   const data=bars(series([...prior,10]));for(let i=10;i<data.length;i++){data[i]!.time+=offset;data[i]!.closeTime+=offset;}
   const r=describeSmartChartWindow(input(data));expect(r.status).toBe("ready");expect(r.trend.status).toBe("available");expect(r.distribution.status).toBe("available");
   for(const name of ["rsi14","roc14Percent","atr14","atr14PercentOfClose","returnStdDevPercent","unusualMove"] as const)expect(r[name].status).toBe("unavailable");
  }
 });
 it("population return deviation uses actual adjacent return count without annualization",()=>{
  const r=describeSmartChartWindow(input(series([1,-1,1,-1])));expect(r.returnStdDevPercent.value).toBeCloseTo(1,10);
 });
 it("price scaling preserves dimensionless descriptors and scales price-valued measures",()=>{
  const full=input(series([...prior,10])),expected=describeSmartChartWindow(full);
  for(const scale of [1e-9,.01,1e6]){
   const r=describeSmartChartWindow({...full,bars:full.bars.map(b=>({...b,open:b.open*scale,high:b.high*scale,low:b.low*scale,close:b.close*scale}))});
   expect(r.status).toBe("ready");expect(r.rsi14.value).toBeCloseTo(expected.rsi14.value!,8);
   expect(r.trend.value!.rSquared).toBeCloseTo(expected.trend.value!.rSquared!,10);
   expect(r.trend.value!.slopePerInterval/scale).toBeCloseTo(expected.trend.value!.slopePerInterval,10);
   expect(r.atr14.value!/scale).toBeCloseTo(expected.atr14.value!,10);expect(r.unusualMove.value!.position).toBe(expected.unusualMove.value!.position);
  }
 });
 it("replay full future and exact prefix produce identical descriptive outputs",()=>{
  const full=input(series([...prior,10,-20,300])),cut=full.bars.at(-3)!.closeTime;
  expect(describeSmartChartWindow({...full,replayCutoff:cut})).toEqual(describeSmartChartWindow({...full,bars:full.bars.slice(0,-2),replayCutoff:cut}));
 });
 for(const bad of [{sourceIdentity:null},{source:"unknown"},{timeframe:"INVALID"},{asOfMs:NaN},{visibleRange:{from:9,to:1}}])it(`refuses context ${JSON.stringify(bad)}`,()=>{expect(describeSmartChartWindow({...input([100,101]),...bad}).status).toBe("unavailable");});
 it("rejects malformed/future/finality/ordering evidence without publishing numerical metrics",()=>{
  const initial=input([100,101,102]);
  for(const change of [{isFinal:false},{close:NaN},{high:Infinity},{low:0},{closeTime:START+99999}]){
   const data={...initial,bars:initial.bars.map((b,i)=>i===2?{...b,...change}:b)};
   const r=describeSmartChartWindow(data);expect(r.status).toBe("unavailable");expect(r.basics).toBeNull();expect(r.rsi14.value).toBeNull();
  }
  expect(describeSmartChartWindow({...initial,bars:[...initial.bars].reverse()}).status).toBe("unavailable");
  expect(describeSmartChartWindow({...initial,asOfMs:initial.bars.at(-1)!.time*1000+1}).status).toBe("unavailable");
  expect(describeSmartChartWindow(input([1e308,1])).status).toBe("unavailable");
  expect(selectSmartChartWindow(initial).bars).toEqual(initial.bars);
 });
});
