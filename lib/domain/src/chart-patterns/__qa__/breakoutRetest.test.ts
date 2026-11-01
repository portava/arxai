import { test } from "node:test";
import assert from "node:assert/strict";
import { detectChartPatterns } from "../patternEngine.js";
import type { ChartPatternCandle } from "../types.js";
const row = ([open, high, low, close]: number[]): ChartPatternCandle => ({open:open!,high:high!,low:low!,close:close!,isComplete:true,isForming:false});
const base = [...Array.from({length:16},()=>row([100,100.3,99.7,100])), ...[
 [100,100.2,99.8,100.1],[100.1,100.4,100,100.3],[100.3,101,100.2,100.6],
 [100.4,100.5,100,100.2],[100.2,100.4,99.9,100.1],[100.1,100.6,100,100.4],
 [100.4,101,100.3,100.6],[100.6,100.7,100.1,100.3],[100.3,100.6,100,100.2],
 [100.2,102.2,100.1,102],[102,102.1,100.9,101.3],[101.3,101.7,101,101.5]
].map(row)];
const mirror = (bars: ChartPatternCandle[]) => bars.map(c=>({...c,open:220-c.open,high:220-c.low,low:220-c.high,close:220-c.close}));
for(const down of [false,true]) {
 const pattern=(bars:ChartPatternCandle[])=>detectChartPatterns(down?mirror(bars):bars).patterns.find(p=>p.id===(down?"breakout_retest_down":"breakout_retest_up"));
 test(`${down?"bearish":"bullish"}: absent retest has no retest anchor`,()=>{
  const p=pattern([...base.slice(0,26),row([102,103,102,102.8]),row([102.8,104,102.8,103.8])]);
  assert.ok(p);assert.equal(p.status,"forming");assert.match(p.rationale[0]!,/has not retested/);
  assert.deepEqual(p.keyPoints.map(p=>p.role),["broken_level"]);
 });
 test(`${down?"bearish":"bullish"}: retest stays on the actual earlier touching candle`,()=>{
  const bars=[...base,row([101.5,103,101.5,102.8])],p=pattern(bars);
  assert.ok(p);assert.match(p.rationale[0]!,/broke and retested/);
  const touch=p.keyPoints.find(p=>p.role==="retest");assert.ok(touch);
  assert.equal(touch.index,26);assert.equal(touch.price,down?119:101);
  const candle=(down?mirror(bars):bars)[touch.index]!;
  assert.ok(touch.price>=candle.low&&touch.price<=candle.high);
 });
 test(`${down?"bearish":"bullish"}: a candle wholly beyond the wrong side is not a retest`,()=>{
  const p=pattern([...base.slice(0,26),row([99,99.2,98.8,99]),row([100.9,101.1,100.7,101.05])]);
  assert.ok(p);assert.equal(p.status,"failed");
  assert.ok(!p.keyPoints.some(p=>p.role==="retest"));
 });
 test(`${down?"bearish":"bullish"}: appended volatility cannot erase or rewrite the earlier break`,()=>{
  const prefix=base.slice(0,26),a=pattern(prefix),b=pattern([...prefix,row([102,150,50,102])]);
  assert.ok(a);assert.ok(b,"Future volatility must not erase an observed break");
  assert.deepEqual(b.levels,a.levels);assert.deepEqual(b.breakoutLifecycle?.formationIndexes,a.breakoutLifecycle?.formationIndexes);
  assert.ok(a.breakoutLifecycle);assert.equal(b.breakoutLifecycle?.frozenAtr,a.breakoutLifecycle.frozenAtr);assert.equal(b.breakoutLifecycle?.breakIndex,25);
 });
 test(`${down?"bearish":"bullish"}: breakout-candle volatility does not set its own trigger`,()=>{
  const prefix=base.slice(0,25),p=pattern([...prefix,row([100.2,150,100.1,102])]);
  assert.ok(p,"Trigger volatility must end before the break candle");assert.equal(p.breakoutLifecycle?.breakIndex,25);
 });
 test(`${down?"bearish":"bullish"}: a later confirmed swing cannot invent a prior tested level`,()=>{
  const bars=base.slice(0,26);bars[22]=row([100.4,100.6,100.3,100.5]);
  const before=pattern(bars);assert.equal(before,undefined);
  const after=pattern([...bars,...[[100.7,100.8,100.5,100.7],[100.7,100.9,100.6,100.8],[100.8,101,100.5,100.7],[100.7,100.8,100.5,100.7],[100.7,100.75,100.5,100.6]].map(row)]);
  assert.equal(after,undefined,"Second level touch was unknown at the earlier crossing");
 });
 test(`${down?"bearish":"bullish"}: already-beyond closes do not become new breaks as the discovery window moves`,()=>{
  assert.equal(pattern([...base.slice(0,26),...Array.from({length:15},()=>row([102,102.2,101.8,102]))]),undefined);
 });
 test(`${down?"bearish":"bullish"}: failure before confirmation is sticky without a new decisive crossing`,()=>{
  const p=pattern([...base.slice(0,26),row([99,99.2,98.8,99]),row([100.9,101.1,100.7,101.05])]);
  assert.ok(p);assert.equal(p.status,"failed");assert.equal(p.breakoutLifecycle?.failedIndex,26);assert.equal(p.breakoutLifecycle?.confirmedIndex,null);assert.equal(p.breakoutLifecycle?.retestIndex,null);
 });
 test(`${down?"bearish":"bullish"}: a distinct fresh crossing after failure receives a new event identity`,()=>{
  const p=pattern([...base.slice(0,26),row([99,99.2,98.8,99]),row([99,102.3,98.9,102]),row([102,102.1,100.9,101.4])]);
  assert.ok(p);assert.equal(p.breakoutLifecycle?.breakIndex,27);assert.equal(p.breakoutLifecycle?.failedIndex,null);assert.equal(p.breakoutLifecycle?.retestIndex,28);assert.equal(p.breakoutLifecycle?.confirmedIndex,28);
 });
 test(`${down?"bearish":"bullish"}: first touch and later confirmation keep their separate actual indexes`,()=>{
  const p=pattern([...base.slice(0,26),row([102,102.1,100.9,100.95]),row([100.95,101.6,100.9,101.5])]);
  assert.ok(p);assert.equal(p.breakoutLifecycle?.retestIndex,26);assert.equal(p.breakoutLifecycle?.confirmedIndex,27);
  assert.ok(p.breakoutLifecycle!.levelKnownAtIndex<p.breakoutLifecycle!.breakIndex);
  assert.deepEqual(p.breakoutLifecycle!.formationIndexes,[18,22]);
  // Prior14 true ranges total8.2; the crossing/retest ranges are excluded.
  assert.ok(Math.abs(p.breakoutLifecycle!.frozenAtr-8.2/14)<1e-12);
 });
 test(`${down?"bearish":"bullish"}: every appended prefix retains the frozen identity and first confirmation`,()=>{
  const bars=[...base,...[[101.5,125,90,101.6],[101.6,104,101.5,102.1],[102.1,103,101.8,102.3],[102.3,127,91,102.4]].map(row)];
  const origin=pattern(bars.slice(0,26))!;assert.ok(origin.breakoutLifecycle);
  for(let length=27;length<=bars.length;length++){
   const p=pattern(bars.slice(0,length));assert.ok(p);
   assert.deepEqual(p.levels,origin.levels);
   const life=p.breakoutLifecycle!;assert.equal(life.breakIndex,origin.breakoutLifecycle.breakIndex);assert.equal(life.referenceLevel,origin.breakoutLifecycle.referenceLevel);assert.equal(life.frozenAtr,origin.breakoutLifecycle.frozenAtr);assert.deepEqual(life.formationIndexes,origin.breakoutLifecycle.formationIndexes);
   assert.equal(life.retestIndex,26);assert.equal(life.confirmedIndex,26);assert.equal(life.failedIndex,null);
   for(const index of life.formationIndexes)assert.ok(index+2<life.breakIndex);
  }
 });
 test(`${down?"bearish":"bullish"}: confirmation is retained as historical evidence after later failure`,()=>{
  const p=pattern([...base,row([101.5,101.6,98.9,99]),row([99,100.9,98.9,100.8])]);assert.ok(p);
  assert.equal(p.status,"failed");assert.equal(p.breakoutLifecycle?.confirmedIndex,26);assert.equal(p.breakoutLifecycle?.failedIndex,28);assert.equal(p.breakoutLifecycle?.retestIndex,26);assert.equal(p.breakoutLifecycle?.breakIndex,25);
 });
 test(`${down?"bearish":"bullish"}: an OHLC retest that closes beyond failure cannot also confirm`,()=>{
  const p=pattern([...base.slice(0,26),row([102,102.1,98.9,99])]);assert.ok(p);
  assert.equal(p.status,"failed");assert.equal(p.breakoutLifecycle?.retestIndex,26);assert.equal(p.breakoutLifecycle?.failedIndex,26);assert.equal(p.breakoutLifecycle?.confirmedIndex,null);
 });
}

test("breakout discovery still requires at least24 closed observations and ignores an appended forming bar",()=>{
 const short=detectChartPatterns(base.slice(0,23)).patterns;assert.ok(!short.some(p=>p.category==="breakout_retest"));
 const prefix=base.slice(0,26),a=detectChartPatterns(prefix).patterns.find(p=>p.id==="breakout_retest_up");
 const b=detectChartPatterns([...prefix,{...row([102,180,20,90]),isComplete:false,isForming:true}]).patterns.find(p=>p.id==="breakout_retest_up");assert.deepEqual(b,a);
});
