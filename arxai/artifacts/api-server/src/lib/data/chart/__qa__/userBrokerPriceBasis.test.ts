import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { computeBrokerPriceAlignment, hasMeasuredBrokerAlignment } from "../brokerPriceAlignment.js";
const now = Date.UTC(2026, 10, 5, 19), series = { providerId: "mt5_broker", subProviderId: null,
  userId: 70, bridgeConnectionId: 7, brokerSymbol: "XAGUSD.native", environment: "unknown" };
let basis: string | undefined = "BID", nativeSymbol = "XAGUSD.native";
const state = { assetClass: "metals", latestClosedCandle: { close: 100 } };
mock.module("../chartIntelligence.js", { namedExports: {
  getCachedIntelligenceContext: () => ({ state, truthResult: { priceBasis: basis }, feedStatus: {}, seriesAttribution: series }),
  enrichStateWithBrokerAlignment: (s: object, _truth: unknown, _feed: unknown, inputs: Parameters<typeof computeBrokerPriceAlignment>[0]) =>
    ({ ...s, brokerAlignment: computeBrokerPriceAlignment(inputs) }),
} });
mock.module("../../providers/mt5Provider.js", { namedExports: {
  readMt5Quote: () => ({ quote: { bid: 100, ask: 104, timestamp: new Date(now).toISOString(), brokerSymbol: nativeSymbol },
    userId: 70, bridgeConnectionId: 7, tickTimeObserved: true }),
} });
const realDb = await import("@workspace/db");
mock.module("@workspace/db", { namedExports: { ...realDb, db: {
  select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
} } });
const { enrichStateWithUserBrokerQuote } = await import("../userBrokerAlignment.js");
afterEach(() => { mock.timers.reset(); basis = "BID"; nativeSymbol = "XAGUSD.native"; });
async function run() {
  mock.timers.enable({ apis: ["Date"], now });
  // Deliberately stale caller copy: comparison must use the same cached state
  // as the cached series/truth result, not mix different snapshots.
  return enrichStateWithUserBrokerQuote({ ...state, latestClosedCandle: { close: 200 } } as any,
    { userId: 70, symbol: "XAGUSD", timeframe: "M15", limit: 200 });
}
test("native BID metadata overrides asset-class midpoint guess and binds the same cached candle", async () => {
  const result = await run(), a = result.brokerAlignment;
  assert.equal(a.chartPriceBasis, "BID"); assert.equal(a.chartPrice, 100);
  assert.equal(a.brokerMid, 102); assert.equal(a.deviationPct, 0);
  assert.equal(a.aligned, true); assert.equal(hasMeasuredBrokerAlignment(a), true);
});
test("native MID declaration is preserved and compares with midpoint", async () => {
  basis = "MID"; const a = (await run()).brokerAlignment;
  assert.equal(a.chartPriceBasis, "MID"); assert.equal(a.tolerance, "failed");
  assert.ok(a.deviationPct! > 0.019); assert.equal(hasMeasuredBrokerAlignment(a), true);
});
for (const unknown of [undefined, "UNKNOWN", "LAST", "SYNTHETIC"]) {
  test(`${unknown ?? "missing"} basis cannot earn a fabricated midpoint comparison`, async () => {
    basis = unknown; const a = (await run()).brokerAlignment;
    assert.equal(a.chartPriceBasis, unknown ?? "UNKNOWN");
    assert.equal(a.quoteBinding?.status, "BOUND"); assert.equal(a.brokerDataAvailable, true);
    assert.equal(a.aligned, false); assert.equal(a.tolerance, "unknown");
    assert.equal(a.deviationPct, null); assert.equal(hasMeasuredBrokerAlignment(a), false);
  });
}
test("native quote identity contradiction survives observation conversion", async () => {
  nativeSymbol = "XAGUSD.other"; const a = (await run()).brokerAlignment;
  assert.equal(a.quoteBinding?.status, "MISMATCH");
  assert.ok(a.quoteBinding?.reasons.includes("BROKER_SYMBOL_MISMATCH"));
  assert.equal(a.aligned, false); assert.equal(hasMeasuredBrokerAlignment(a), false);
});
