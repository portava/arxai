import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { bindScannerSource, scannerSourceIdentity } from "../../scannerInputIntegrity.js";
import type { SeriesProvenance } from "../../data/types.js";
import type { ScannerOpportunity } from "../../marketScanner.js";

let inFlight = 0, peak = 0, calls = 0;
let scans = 0, scanPeak = 0;
let quoteAgeMs = 0;
let missingQuote = false;
let lateProvider = "mt5_broker";
let stopLoss = 1.09;
let changedIdentity: Partial<SeriesProvenance> = {};
function provenance(symbol: string, timeframe: string): SeriesProvenance {
  return { providerId: "mt5_broker", subProviderId: null, sourceId: `mt5_broker:${symbol}:${timeframe}`, source: "DERIVED", brokerCode: "mt5", bridgeConnectionId: 101, userId: 42, brokerSymbol: symbol, environment: "demo", receivedAt: new Date().toISOString(), delayed: false };
}
async function leaf() {
  calls++; inFlight++; peak = Math.max(peak, inFlight);
  await new Promise((resolve) => setTimeout(resolve, 1));
  inFlight--;
}
const router = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    ...router,
    routeCandles: async (symbol: string) => {
      await leaf();
      return { ok: true, symbol, primaryProvider: lateProvider, provenance: { ...provenance(symbol, "M5"), ...changedIdentity }, assetClass: "forex", candles: [{ time: new Date(Date.now() - 600_000).toISOString(), open: 1.1, high: 1.11, low: 1.09, close: 1.1 }] };
    },
    routeQuote: async (symbol: string) => {
      await leaf();
      return { ok: !missingQuote, symbol, primaryProvider: lateProvider, provenance: { ...provenance(symbol, "M5"), ...changedIdentity, source: "LIVE_TICK", sourceId: `mt5_broker:${symbol}` }, quote: missingQuote ? null : { symbol, last: 1.1, bid: 1.0999, ask: 1.1001, timestamp: new Date(Date.now() - quoteAgeMs).toISOString() } };
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
      return bindScannerSource({
        symbol, timeframe, dataSource: "LIVE_FEED", dataStatus: "live", feedProvider: "mt5_broker",
        recommendedAction: "BUY", bias: "bullish", entry: 1.1, stopLoss, takeProfit: 1.12,
        entrySniperScore: 70, confidenceScore: 70, riskRewardRatio: 2,
        setupType: "Trend continuation", opportunity: { score: 70 },
      } as ScannerOpportunity, scannerSourceIdentity({ primaryProvider: "mt5_broker", provenance: provenance(symbol, timeframe) }));
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


test("lateness cannot switch the setup feed or accept reversed stop geometry", async () => {
  const fresh = await buildOpportunityMapCore({ universe: "forex", timeframe: "M5" });
  assert.ok(fresh.map.categories.READY_NOW.length > 0);
  lateProvider = "assistant_real:twelve_data";
  const switched = await buildOpportunityMapCore({ universe: "forex", timeframe: "M5" });
  assert.equal(switched.map.categories.READY_NOW.length, 0);
  assert.ok(Object.values(switched.map.best).every((pick) => pick === null));
  lateProvider = "mt5_broker"; stopLoss = 1.115;
  const reversed = await buildOpportunityMapCore({ universe: "forex", timeframe: "M5" });
  assert.equal(reversed.map.categories.READY_NOW.length, 0);
  stopLoss = 1.09;
});


test("same-provider bridge/account/environment/native-symbol switches withhold lateness readiness", async () => {
  for (const change of [{ bridgeConnectionId: 202 }, { userId: 84 }, { environment: "live" as const }, { brokerSymbol: "EURUSD.other" }]) {
    changedIdentity = change;
    const switched = await buildOpportunityMapCore({ universe: "forex", timeframe: "M5" });
    assert.equal(switched.map.categories.READY_NOW.length, 0, JSON.stringify(change));
    assert.ok(Object.values(switched.map.best).every((pick) => pick === null));
  }
  changedIdentity = {};
  assert.ok((await buildOpportunityMapCore({ universe: "forex", timeframe: "M5" })).map.categories.READY_NOW.length > 0);
});
