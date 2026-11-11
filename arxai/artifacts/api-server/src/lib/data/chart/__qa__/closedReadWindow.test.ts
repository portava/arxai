import assert from "node:assert/strict";
import { test } from "node:test";
import { recordStateCandleWindow, closedCandlesOfState, copyStateCandleWindow } from "../stateCandleWindow.js";
import type { ChartIntelligenceState } from "../chartIntelligence.js";
import type { NormalizedChartCandle } from "../candleNormalization.js";
const stamp = "2026-11-05T08:01:00.000Z";
const state = () => ({symbol:"V75",timeframe:"M1",latestClosedCandle:{closeTime:stamp}} as ChartIntelligenceState);
const bar = (change:Partial<NormalizedChartCandle> = {}) => ({symbol:"V75",timeframe:"M1",openTime:"2026-11-05T08:00:00.000Z",closeTime:stamp,open:100,high:102,low:99,close:101,isComplete:true,isFinal:true,isForming:false,volume:0,...change} as NormalizedChartCandle);
test("closed reads exclude a reversing forming tip and remain immutable after provider updates", () => {
 const s=state(),closed=bar();
 recordStateCandleWindow(s,[closed,bar({openTime:stamp,closeTime:"2026-11-05T08:02:00.000Z",close:80,low:79,isComplete:false,isFinal:false,isForming:true})]);
 closed.close=70;
 assert.deepEqual(closedCandlesOfState(s).map(b=>b.close),[101]);
});
test("unbound states, wrong symbol, wrong interval, future and nonfinal bars cannot enter a closed read", () => {
 const s=state();assert.deepEqual(closedCandlesOfState(s),[]);
 recordStateCandleWindow(s,[bar({symbol:"V25_1S"}),bar({timeframe:"M5"}),bar({closeTime:"2026-11-05T08:03:00Z"}),bar({isFinal:false}),bar({isForming:true})]);
 assert.deepEqual(closedCandlesOfState(s),[]);
});
test("per-user alignment enrichment retains the original window and HTF cannot look past the read stamp", () => {
 const s=state(),enriched=state();recordStateCandleWindow(s,[bar()]);copyStateCandleWindow(s,enriched);
 assert.equal(closedCandlesOfState(enriched).length,1);
 assert.deepEqual(closedCandlesOfState(enriched,"2026-11-05T08:00:00Z"),[]);
});
