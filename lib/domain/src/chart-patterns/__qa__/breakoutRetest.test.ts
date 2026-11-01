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
  const p=pattern([...base.slice(0,26),row([99,99.2,98.8,99]),row([102,102.4,102,102.2])]);
  assert.ok(p);assert.equal(p.status,"forming");
  assert.ok(!p.keyPoints.some(p=>p.role==="retest"));assert.match(p.rationale[0]!,/has not retested/);
 });
}
