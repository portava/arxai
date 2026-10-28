import { describe,it,expect } from "vitest";
import { analyzeSmartChart,bindSmartChartBars } from "./smartChartAnalysis";
import { CANDLE_FIXTURES, mirror } from "../../../../../lib/domain/src/chart-patterns/__qa__/candlestickFixtures";
const context={symbol:"EURUSD",timeframe:"M5",source:"mt5_broker",sourceIdentity:"a".repeat(64)};
const input=(bars:typeof CANDLE_FIXTURES[number]["bars"])=>({...context,bars,asOfMs:bars.at(-1)!.closeTime*1000,dataState:"current" as const});
describe("source-aware catalogue integration",()=>{
 for(const fixture of CANDLE_FIXTURES)it(`${fixture.id} reaches the chart as an observed, causal shape`,()=>{
  const result=analyzeSmartChart(input(fixture.bars));
  const found=result.allFindings.find(f=>f.id===`${fixture.id}:${fixture.bars.at(-1)!.time}`);
  expect(result.status).toBe("ready");expect(found).toBeDefined();expect(found!.status).toBe("observed");
  expect(found!.confirmedAt).toBeUndefined();expect(found!.asOf).toBe(fixture.bars.at(-1)!.closeTime);
  expect(found!.anchors.every(a=>a.time<=fixture.bars.at(-1)!.time)).toBe(true);
 });
 it("keeps basic anatomy out of summary and related Doji variants in one slot",()=>{
  const bars=CANDLE_FIXTURES.find(f=>f.id==="rickshaw_man")!.bars;
  const result=analyzeSmartChart(input(bars));
  expect(result.allFindings.some(f=>f.id.startsWith("rickshaw_man:"))).toBe(true);
  expect(result.findings.filter(f=>(f.family??f.id.split(":")[0])==="doji")).toHaveLength(1);
  expect(result.findings.every(f=>f.summaryEligible!==false)).toBe(true);
  expect(result.catalogue).toMatchObject({definedVariants:62,geometryFamilies:16});
  expect(result.catalogue!.note).toContain("not independent confirmations");
 });
 it("never reuses another owner/source context or contradictory finality for catalogue observations",()=>{
  const bars=CANDLE_FIXTURES.find(f=>f.id==="hammer")!.bars;
  const bound=bindSmartChartBars(context,[{evidence:{...context,sourceIdentity:"b".repeat(64)},bars}]);
  expect(bound.status).toBe("unavailable");
  const broken=bars.map((b,i)=>i===bars.length-1?{...b,isFinal:false}:b);
  expect(analyzeSmartChart(input(broken)).allFindings).toEqual([]);
 });
 it("future replay additions cannot create a morning-star reading early",()=>{
  const bars=CANDLE_FIXTURES.find(f=>f.id==="morning_star")!.bars;
  const cutoff=bars.at(-2)!.closeTime;
  const whole=analyzeSmartChart({...input(bars),replayCutoff:cutoff});
  const prefix=analyzeSmartChart({...input(bars.slice(0,-1)),asOfMs:input(bars).asOfMs,replayCutoff:cutoff});
  expect(whole).toEqual(prefix);expect(whole.allFindings.some(f=>f.id.startsWith("morning_star:"))).toBe(false);
 });
 it("shares the catalogue's exact Doji threshold at tiny and large price scales",()=>{
  const fixture=CANDLE_FIXTURES.find(f=>f.id==="doji")!.bars;
  for(const scale of [1e-9,1,10000]){
   const bars=fixture.map((b,i)=>i===fixture.length-1?{...b,open:102*scale,high:104*scale,low:100*scale,close:102.4*scale}:({...b,open:b.open*scale,high:b.high*scale,low:b.low*scale,close:b.close*scale}));
   expect(analyzeSmartChart(input(bars)).allFindings.some(f=>f.id===`doji:${bars.at(-1)!.time}`)).toBe(true);
  }
 });
 for(const [id,family] of [["hammer","long_shadow"],["takuri_line","doji"]])it(`does not present legacy pin-bar and ${id} geometry as independent summary families`,()=>{
  const tail=CANDLE_FIXTURES.find(f=>f.id===id)!.bars;
  const first=tail[0]!;
  const prefix=Array.from({length:20},(_,i)=>({...first,time:first.time-(20-i)*300,closeTime:first.time-(19-i)*300}));
  const bars=[...prefix,...tail],result=analyzeSmartChart(input(bars));
  expect(result.allFindings.some(f=>f.id.startsWith("bullish_pin_bar:"))).toBe(true);
  expect(result.allFindings.find(f=>f.id.startsWith("bullish_pin_bar:"))!.family).toBe(family);
  expect(result.allFindings.some(f=>f.id.startsWith(`${id}:`))).toBe(true);
  expect(result.findings.filter(f=>(f.family??f.id.split(":")[0])===family)).toHaveLength(1);
  expect(result.findings.filter(f=>f.id.startsWith("bullish_pin_bar:")||f.id.startsWith(`${id}:`)).length).toBeLessThanOrEqual(1);
 });
 it("keeps the dedicated Shooting Star lifecycle and legacy bearish pin bar in one summary family",()=>{
  const tail=mirror(CANDLE_FIXTURES.find(f=>f.id==="hammer")!.bars),first=tail[0]!;
  const prefix=Array.from({length:20},(_,i)=>({...first,time:first.time-(20-i)*300,closeTime:first.time-(19-i)*300}));
  const result=analyzeSmartChart(input([...prefix,...tail]));
  expect(result.allFindings.find(f=>f.id.startsWith("bearish_pin_bar:"))!.family).toBe("long_shadow");
  const star=result.allFindings.find(f=>f.id.startsWith("shooting_star:"));
  expect(star).toMatchObject({family:"long_shadow",status:"developing"});
  expect(result.findings.filter(f=>f.family==="long_shadow")).toHaveLength(1);
 });
 it("groups Three Outside with its already-observed Engulfing stage",()=>{
  const bars=CANDLE_FIXTURES.find(f=>f.id==="three_outside_up")!.bars,result=analyzeSmartChart(input(bars));
  expect(result.allFindings.some(f=>f.id.startsWith("bullish_engulfing:"))).toBe(true);
  expect(result.allFindings.find(f=>f.id.startsWith("three_outside_up:"))).toMatchObject({family:"engulfing",status:"observed",asOf:bars.at(-1)!.closeTime});
  expect(result.findings.filter(f=>f.family==="engulfing")).toHaveLength(1);
 });
 it("groups the more specific Abandoned Baby with its Morning Doji Star geometry",()=>{
  const bars=CANDLE_FIXTURES.find(f=>f.id==="bullish_abandoned_baby")!.bars,result=analyzeSmartChart(input(bars));
  expect(result.allFindings.some(f=>f.id.startsWith("morning_doji_star:"))).toBe(true);
  expect(result.allFindings.some(f=>f.id.startsWith("bullish_abandoned_baby:"))).toBe(true);
  expect(result.findings.filter(f=>f.family==="stars")).toHaveLength(1);
 });
 it("groups Tri-Star and Kicking length subtypes with their observed underlying geometry",()=>{
  for(const [id,family,underlying] of [["bullish_tri_star","doji","doji"],["kicking_by_length","marubozu","bullish_kicking"]]){
   const bars=CANDLE_FIXTURES.find(f=>f.id===id)!.bars,result=analyzeSmartChart(input(bars));
   expect(result.allFindings.some(f=>f.id.startsWith(`${id}:`))).toBe(true);
   expect(result.allFindings.some(f=>f.id.startsWith(`${underlying}:`))).toBe(true);
   expect(result.findings.filter(f=>f.family===family).length).toBeLessThanOrEqual(1);
  }
 });
 it("does not invent directional lifecycle confirmation from Kicking body-length classification",()=>{
  const bars=CANDLE_FIXTURES.find(f=>f.id==="kicking_by_length")!.bars;
  const finding=analyzeSmartChart(input(bars)).allFindings.find(f=>f.id.startsWith("kicking_by_length:"))!;
  expect(finding.status).toBe("observed");expect(finding.confirmedAt).toBeUndefined();
  expect(finding.explanation).toContain("not a forecast");
 });

});
