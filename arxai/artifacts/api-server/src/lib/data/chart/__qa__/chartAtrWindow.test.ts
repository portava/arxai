import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStats } from "../chartIntelligence.js";
import type { NormalizedChartCandle } from "../candleNormalization.js";
test("ATR14 uses fourteen true ranges, excluding the preceding context bar's large range", () => {
 const bars = Array.from({length:15},(_,i)=>({open:100,close:100,high:i===0?150:101,low:i===0?50:99}) as NormalizedChartCandle);
 assert.equal(computeStats(bars).atr,2);
 assert.equal(computeStats(bars.slice(0,1)).atr,100);
 assert.equal(computeStats([]).atr,null);
});

test("next candle momentum threshold matches its rolling 20-bar range test", () => {
  const bar = (range: number) => ({ open: 900, close: 900, low: 900, high: 900 + range }) as NormalizedChartCandle;
  const history = [bar(400), ...Array.from({ length: 19 }, () => bar(37))];
  const threshold = computeStats(history).nextMomentumRangeAbove;
  assert.equal(threshold, 57);
  assert.equal(computeStats(history.slice(1)).nextMomentumRangeAbove, threshold);
  assert.equal(computeStats(history.slice(2)).nextMomentumRangeAbove, undefined);
  for (const range of [56.99, 57, 57.01]) {
    const actual = computeStats([...history, bar(range)]);
    assert.equal(actual.range! > 1.5 * actual.avgRange!, range > threshold!);
  }
});
