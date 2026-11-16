import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { ScannerOpportunity } from "../marketScanner.js";

let requests = 0;
let fail = false;
mock.module("../news/newsIntelligenceService.js", {
  namedExports: {
    getNewsIntelligence: async () => {
      requests++;
      if (fail) throw new Error("offline fixture");
      return {
        riskLevel: "low", bias: "bullish", timing: "now", recommendation: "watch",
        dataSources: { headlines: { count: 3, connected: true } },
        upcomingEvent: null, warningSummary: "",
      };
    },
  },
});
const { decorateOpportunitiesWithNewsRisk } = await import("../marketScanner.js");

test("one shared symbol news fetch preserves opposite timeframe directions", async () => {
  const rows = [
    { symbol: "EURUSD", timeframe: "M5", recommendedAction: "BUY" },
    { symbol: "EURUSD", timeframe: "H4", recommendedAction: "SELL" },
    { symbol: "EURUSD", timeframe: "D1", recommendedAction: "WAIT" },
  ] as ScannerOpportunity[];
  const decorated = await decorateOpportunitiesWithNewsRisk(rows);
  assert.equal(requests, 1);
  assert.deepEqual(decorated.map((row) => row.newsContext?.alignsWithScanner), [true, false, null]);
  assert.ok(rows.every((row) => row.newsContext === undefined), "caller rows must not be mutated");
});

test("unavailable news never invents agreement with the scanner", async () => {
  fail = true;
  const decorated = await decorateOpportunitiesWithNewsRisk([
    { symbol: "GBPUSD", timeframe: "M5", recommendedAction: "BUY" },
  ] as ScannerOpportunity[]);
  assert.equal(decorated[0]?.newsContext?.alignsWithScanner, null);
  assert.equal(decorated[0]?.newsContext?.headlinesConnected, false);
});
