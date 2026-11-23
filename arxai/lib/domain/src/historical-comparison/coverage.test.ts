import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeHistoricalComparison } from "./index.js";

const now = Date.UTC(2026, 10, 23, 13, 45, 30);
const yesterday = Math.floor(now / 60000) * 60000 - 86400000;
function read(times: number[], timeframe = "M1", asOf = now) {
  const candles = times.map((timestamp, index) => ({
    timestamp, open: 100 + index, high: 101 + index, low: 100 + index, close: 101 + index,
  }));
  return analyzeHistoricalComparison({ symbol: "V75", timeframe, now: asOf, candles });
}
test("a prior-minute gap cannot stand in for yesterday's same-time candle", () => {
  assert.equal(read([yesterday - 60000, yesterday + 60000]).bias.label, "INSUFFICIENT_DATA");
  assert.equal(read([yesterday, yesterday + 60000]).bias.label, "BULLISH");
});
test("the successor must be consecutive and fully closed by the observation cutoff", () => {
  assert.equal(read([yesterday, yesterday + 180000]).bias.sampleSize, 0);
  const monday = Date.UTC(2026, 10, 23), sunday = monday - 86400000;
  assert.equal(read([sunday, monday], "D1", monday + 60000).bias.sampleSize, 0);
});
test("monthly comparisons respect the actual calendar boundary in a short month", () => {
  const start = Date.UTC(2026, 1, 1), next = Date.UTC(2026, 2, 1), finish = Date.UTC(2026, 3, 1);
  assert.equal(read([start,next], "MN1", Date.UTC(2026, 2, 31)).bias.sampleSize, 0);
  assert.equal(read([start,next,finish], "MN1", Date.UTC(2027, 1, 16)).bias.sampleSize, 1);
});
