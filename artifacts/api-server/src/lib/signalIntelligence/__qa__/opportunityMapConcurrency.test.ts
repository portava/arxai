import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { ScannerOpportunity } from "../../marketScanner.js";

let inFlight = 0, peak = 0, calls = 0;
let scans = 0, scanPeak = 0;
let quoteAgeMs = 0;
let missingQuote = false;
async function leaf() {
  calls++; inFlight++; peak = Math.max(peak, inFlight);
  await new Promise((resolve) => setTimeout(resolve, 1));
  inFlight--;
}
const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    ...router,
    routeCandles: async () => {
      await leaf();
      return { ok: true, candles: [{ time: new Date().toISOString(), open: 1.1, high: 1.11, low: 1.09, close: 1.1 }] };
    },
    routeQuote: async () => {
      await leaf();
      return { ok: !missingQuote, quote: missingQuote ? null : { last: 1.1, bid: 1.0999, ask: 1.1001, timestamp: new Date(Date.now() - quoteAgeMs).toISOString() } };
    },
  },
});
const scanner = await import("../../marketScanner.js");
const identity = async (rows: ScannerOpportunity[]) => rows;
mock.module("../../marketScanner.js", {
  namedExports: {
    ...scanner,
    scanSymbolTimeframe: async (symbol: string, timeframe: string) => {
      scans++; scanPeak = Math.max(scanPeak, scans);
      await new Promise((resolve) => setTimeout(resolve, 1));
      scans--;
      return {
        symbol, timeframe, dataSource: "LIVE_FEED", dataStatus: "live",
        recommendedAction: "BUY", bias: "bullish", entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
        entrySniperScore: 70, confidenceScore: 70, riskRewardRatio: 2,
        setupType: "Trend continuation", opportunity: { score: 70 },
      } as ScannerOpportunity;
    },
    decorateOpportunitiesWithHistory: identity,
    decorateOpportunitiesWithNewsRisk: identity,
    decorateOpportunitiesWithFinalRead: (rows: ScannerOpportunity[]) => rows,
  },
});
const { buildOpportunityMapCore } = await import("../opportunityMapService.js");

test("full opportunity map bounds scans and lateness I/O across the real orchestration", async () => {
  const map = await buildOpportunityMapCore({ universe: "full", timeframe: "M5" });
  assert.equal(map.map.scannedCount + map.skippedSymbols.length, map.universeCount);
  assert.ok(map.universeCount > scanner.ENRICHMENT_CONCURRENCY);
  assert.ok(scanPeak > 1 && scanPeak <= scanner.ENRICHMENT_CONCURRENCY);
  assert.equal(calls, map.universeCount * 2, "every live directional row checks candles and quote");
  assert.ok(peak > 1 && peak <= scanner.ENRICHMENT_CONCURRENCY,
    `lateness leaf I/O peak ${peak} exceeds shared budget ${scanner.ENRICHMENT_CONCURRENCY}`);
  assert.equal(inFlight, 0);
});

test("map lateness shares the same budget with other scanner work", async () => {
  peak = 0; scanPeak = 0;
  await Promise.all([
    buildOpportunityMapCore({ universe: "full", timeframe: "M5" }),
    ...Array.from({ length: 60 }, () => scanner.runWithScannerBudget(leaf)),
  ]);
  assert.ok(peak <= scanner.ENRICHMENT_CONCURRENCY, `combined peak was ${peak}`);
  assert.equal(inFlight, 0);
});


test("stale, future or missing quotes cannot manufacture ready-now or best-pick claims", async () => {
  for (const age of [60_000, -60_000]) {
    quoteAgeMs = age;
    const core = await buildOpportunityMapCore({ universe: "forex", timeframe: "M5" });
    assert.equal(core.map.categories.READY_NOW.length, 0);
    assert.ok(core.map.rows.every((row) => row.direction === "NEUTRAL" && row.recommendedAction === "WAIT"));
    assert.ok(Object.values(core.map.best).every((pick) => pick === null));
    assert.match(core.map.rows[0]!.reason!, /fresh quote/);
  }
  quoteAgeMs = 0; missingQuote = true;
  const core = await buildOpportunityMapCore({ universe: "forex", timeframe: "M5" });
  assert.equal(core.map.categories.READY_NOW.length, 0, "a candle close must not replace the missing quote");
  missingQuote = false;
});
