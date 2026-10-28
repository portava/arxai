import { describe, expect, it } from "vitest";
import { captureChartReplay, replayPrefix, replayCountAtClose, replayCount, replayDrawingKey, replayExitUrl } from "./chartReplay";
import { DEFAULT_PREFERENCES } from "./chartWorkspace";
import { StudyCalculator, STUDY_CATALOG } from "./chartStudies";
import { NOW, replayResponse } from "@/components/chart-replay/replayFixture";
const capture=(data=replayResponse())=>captureChartReplay(data,7,DEFAULT_PREFERENCES,NOW);
describe("source-bound historical replay snapshot",()=>{
 it("freezes only closed source-identified bars independently of mutable query data",()=>{
  const data=replayResponse();const result=capture(data);expect(result.error).toBeUndefined();const snapshot=result.snapshot!;
  data.candles[0]!.close=999;data.marketEvidence!.sourceIdentity="b".repeat(64);
  expect(snapshot.bars[0]!.close).toBe(101);expect(snapshot.sourceIdentity).toBe("a".repeat(64));
  expect(Object.isFrozen(snapshot.bars)).toBe(true);expect(Object.isFrozen(snapshot.bars[0])).toBe(true);
  expect(replayDrawingKey(snapshot)).toContain(`:7:${snapshot.id}`);
 });
 it("keeps the view's display zone with its frozen preferences",()=>{
  const snapshot=captureChartReplay(replayResponse(),7,{...DEFAULT_PREFERENCES,timeZone:"Asia/Tokyo"},NOW).snapshot!;
  expect(snapshot.preferences.timeZone).toBe("Asia/Tokyo");expect(Object.isFrozen(snapshot.preferences)).toBe(true);
  expect(Object.hasOwn(capture().snapshot!.preferences,"timeZone")).toBe(false);
 });
 it("does not promote a forming tick when the clock advances",()=>{
  const data=replayResponse();const c=data.candles.at(-1)!;data.candles.push({...c,openTime:c.closeTime,closeTime:new Date(NOW+900_000).toISOString(),isComplete:false,isFinal:false,isForming:true});
  const result=captureChartReplay(data,7,DEFAULT_PREFERENCES,NOW+1_800_000);expect(result.snapshot?.bars.length).toBe(200);
 });
 it.each([
  ["contradictory final flags",(d:any)=>{d.candles[0].isFinal=false;}],
  ["missing closed flags",(d:any)=>{delete d.candles[0].isComplete;}],
  ["forming bar inside history",(d:any)=>{Object.assign(d.candles[2],{isComplete:false,isFinal:false,isForming:true});}],
  ["absent source evidence",(d:any)=>{d.marketEvidence=null;}],
  ["different source",(d:any)=>{d.feedStatus.source="deriv";}],
  ["missing source identity",(d:any)=>{d.marketEvidence.sourceIdentity="";}],
  ["different actor",(d:any)=>{d.marketEvidence.userId=8;}],
  ["mismatched symbol",(d:any)=>{d.candles[0].symbol="V50";}],
  ["mismatched timeframe",(d:any)=>{d.candles[0].timeframe="M5";}],
  ["mismatched candle source",(d:any)=>{d.candles[0].source="mt5_broker";}],
  ["old evidence",(d:any)=>{d.marketEvidence.lastClosedCandleAt=new Date(NOW-900_000).toISOString();}],
  ["future closed candle",(d:any)=>{d.candles.at(-1).openTime=new Date(NOW).toISOString();d.candles.at(-1).closeTime=new Date(NOW+900_000).toISOString();}],
  ["invalid OHLC",(d:any)=>{d.candles[0].high=1;}],
  ["nonfinite price",(d:any)=>{d.candles[0].close=Infinity;}],
  ["duplicate candle",(d:any)=>{d.candles[1]=d.candles[0];}],
  ["mock flag",(d:any)=>{d.candles[0].qualityFlags=["MOCK_DATA"];}],
 ] as const)("refuses %s",(_name,mutate)=>{const data=replayResponse();mutate(data);expect(capture(data).snapshot).toBeUndefined();});
 it("counts genuine gaps without synthesizing or shifting bars",()=>{
  const data=replayResponse();data.candles.splice(10,2);const snapshot=capture(data).snapshot!;
  expect(snapshot.gaps).toBe(1);expect(snapshot.bars).toHaveLength(198);
  const missing=Date.parse(replayResponse().candles[10]!.closeTime)/1000;
  expect(replayCountAtClose(snapshot,missing)).toBe(10);
 });
 it("keeps a prior source window private and immutable; replacement evidence gets a new session",()=>{
  const a=capture().snapshot!;const response=replayResponse();response.marketEvidence!.sourceIdentity="b".repeat(64);const b=capture(response).snapshot!;
  expect(a.id).not.toBe(b.id);expect(replayDrawingKey(a)).not.toBe(replayDrawingKey(b));expect(a.sourceIdentity).not.toBe(b.sourceIdentity);
 });
 it("refuses a response from a different selected chart context",()=>{expect(captureChartReplay(replayResponse(),7,DEFAULT_PREFERENCES,NOW,{symbol:"EURUSD",timeframe:"M15"}).snapshot).toBeUndefined();});
 it("bounds seeks to available closes and never reveals a future bar",()=>{
  const snapshot=capture().snapshot!;const prefix=replayPrefix(snapshot,50);
  expect(prefix).toHaveLength(50);expect(replayCountAtClose(snapshot,prefix.at(-1)!.closeTime-1)).toBe(49);
  expect(replayCountAtClose(snapshot,snapshot.bars[0]!.closeTime-1)).toBeNull();expect(replayCountAtClose(snapshot,snapshot.lastClosedAt+1)).toBeNull();
  expect(replayCount(NaN,200)).toBe(1);expect(replayCount(999,200)).toBe(200);
 });
 it.each(STUDY_CATALOG)("$name cannot see adversarial future bars during forward/backward seek",definition=>{
  const snapshot=capture().snapshot!;const calculator=new StudyCalculator(definition.defaults);
  calculator.calculate(replayPrefix(snapshot,160));calculator.calculate(replayPrefix(snapshot,70),0);
  const expected=new StudyCalculator(definition.defaults).calculate(replayPrefix(snapshot,70));
  expect(calculator.points).toEqual(expected);
  const changed=replayPrefix(snapshot,200).map((bar,i)=>i>=70?{...bar,open:10000+i,high:20000+i,low:9000+i,close:15000+i}:bar);
  expect(new StudyCalculator(definition.defaults).calculate(changed).slice(0,70)).toEqual(expected);
  calculator.calculate(replayPrefix(snapshot,71),69);
  expect(calculator.points).toEqual(new StudyCalculator(definition.defaults).calculate(replayPrefix(snapshot,71)));
 });
});

describe("same-origin replay exit",()=>{
 it.each(["//outside.example/path", "/\\outside.example/path", "https://outside.example", "javascript:alert(1)"])("withholds origin-changing %s",path=>{
  expect(replayExitUrl(path,"","https://arx.example")).toBe("https://arx.example/live-chart");
 });
 it("keeps same-origin routes and the configured application base",()=>{
  expect(replayExitUrl("/market-scanner?symbol=V75","/arx","https://arx.example")).toBe("https://arx.example/arx/market-scanner?symbol=V75");
 });
});
