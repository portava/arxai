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
