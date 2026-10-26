import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { MarketCandlesResult } from "../marketDataRouter.js";

const now = Math.floor(Date.now() / 60_000) * 60_000;
const bar = (time: number) => ({ time: new Date(time).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 0 });
const before = new Date(now - 5 * 60_000).toISOString();
let sourceMode = "deriv_public";
let cacheReads = 0;
let routeReads = 0;
let afterCacheRead: (() => void) | null = null;
let pageBars = [bar(now - 10 * 60_000), bar(now - 9 * 60_000)];
let routed: MarketCandlesResult;

function resetRouted() {
  routed = {
    ok: true, symbol: "V75", timeframe: "M1", assetClass: "synthetic", primaryProvider: "deriv_public",
    candles: [bar(now - 2 * 60_000), bar(now - 60_000)],
    provenance: { providerId: "deriv_public", subProviderId: null, sourceId: "deriv_public:V75:M1",
      bridgeConnectionId: null, userId: null, brokerSymbol: null, environment: "unknown", source: "DERIVED", delayed: false },
    userMessage: "fixture", attempts: [],
  } as unknown as MarketCandlesResult;
}
mock.module("../marketDataRouter.js", { namedExports: {
  classifySymbol: () => "synthetic",
  routeCandles: async () => { routeReads++; return routed; },
} });
mock.module("../providers/derivFeedClient.js", { namedExports: { derivMarketDataSource: () => sourceMode } });
mock.module("../providers/derivProvider.js", { namedExports: {
  getDerivCandles: async () => { throw new Error("Unexpected provider request in cached fixture"); },
} });
mock.module("../candleCache.js", { namedExports: {
  readCachedCandles: async () => {
    cacheReads++; afterCacheRead?.();
    return { candles: pageBars, count: pageBars.length, oldest: pageBars[0]?.time ?? null,
      newest: pageBars.at(-1)?.time ?? null, hasOlderInCache: true };
  },
  getCacheCoverage: async () => ({ oldest: pageBars[0]?.time ?? null, newest: pageBars.at(-1)?.time ?? null }),
  listCachedSources: async () => [],
  upsertCandles: async () => { throw new Error("Unexpected write in explicit-source history fixture"); },
  isValidCacheOhlc: (bar: { open: number; high: number; low: number; close: number }) =>
    [bar.open, bar.high, bar.low, bar.close].every(n => Number.isFinite(n) && n > 0)
      && bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close),
} });
const { getCandleHistory } = await import("../candleHistoryService.js");
const { scannerSourceIdentity } = await import("../../scannerInputIntegrity.js");
const request = () => ({ symbol: "V75", timeframe: "M1", source: "deriv_public", before, limit: 2,
  expectedSourceIdentity: scannerSourceIdentity(routed) });
beforeEach(() => {
  sourceMode = "deriv_public"; cacheReads = 0; routeReads = 0; afterCacheRead = null;
  pageBars = [bar(now - 10 * 60_000), bar(now - 9 * 60_000)]; resetRouted();
});

test("public provider history returns actual matching source evidence and remains historical", async () => {
  const input = request();
  const result = await getCandleHistory(input);
  assert.equal(result.ok, true); assert.equal(result.status, "historical_only");
  assert.equal(result.candles.length, 2); assert.equal(cacheReads, 1); assert.equal(routeReads, 1);
  assert.deepEqual(result.historyEvidence, { symbol: "V75", timeframe: "M1", source: "deriv_public",
    sourceIdentity: input.expectedSourceIdentity, lastClosedCandleAt: new Date(now - 8 * 60_000).toISOString(), scope: "public_provider" });
  assert.equal(JSON.stringify(result.historyEvidence).includes("accountNumber"), false);
});

test("a client-chosen digest cannot attest public cache rows", async () => {
  const result = await getCandleHistory({ ...request(), expectedSourceIdentity: "0".repeat(64) });
  assert.equal(result.ok, false); assert.equal(result.candles.length, 0); assert.equal(cacheReads, 0);
});

for (const source of ["mt5_broker", "deriv", "assistant_real:vendor"]) {
  test(`unverified ${source} history cannot borrow current account identity`, async () => {
    const result = await getCandleHistory({ ...request(), source });
    assert.equal(result.ok, false); assert.equal(result.historyEvidence, null);
    assert.match(result.limitationReason!, /identity cannot be verified/);
    assert.equal(cacheReads, 0); assert.equal(routeReads, 0);
  });
}

test("provider-only legacy callers remain unattested rather than gaining fabricated evidence", async () => {
  const { expectedSourceIdentity: _, ...input } = request();
  const result = await getCandleHistory({ ...input, source: "mt5_broker" });
  assert.equal(result.ok, true); assert.equal(result.historyEvidence, undefined); assert.equal(routeReads, 0);
});

for (const key of ["bridgeConnectionId", "userId", "brokerSymbol", "subProviderId", "environment"] as const) {
  test(`an apparently public source carrying ${key} attribution is not public evidence`, async () => {
    (routed.provenance as unknown as Record<string, unknown>)[key] = key.endsWith("Id") && key !== "subProviderId" ? 123 : "changed";
    // Even a caller that knows the changed digest cannot confer authority.
    const result = await getCandleHistory(request());
    assert.equal(result.ok, false); assert.equal(cacheReads, 0);
  });
}

test("same provider label with changed source identity is withheld", async () => {
  const input = request(); routed.provenance!.bridgeConnectionId = 27;
  const result = await getCandleHistory(input);
  assert.equal(result.ok, false); assert.equal(cacheReads, 0);
});

test("public-to-private transport switch while cache read is pending withholds the completed page", async () => {
  afterCacheRead = () => { sourceMode = "deriv"; };
  const result = await getCandleHistory(request());
  assert.equal(result.ok, false); assert.equal(result.candles.length, 0); assert.equal(result.historyEvidence, null);
  assert.match(result.limitationReason!, /changed while/);
});

for (const mutate of [
  () => { pageBars.reverse(); },
  () => { pageBars[1] = { ...pageBars[0]! }; },
  () => { pageBars[1] = bar(Date.parse(before)); },
  () => { pageBars[1] = bar(Date.parse(before) - 30_000); },
  () => { pageBars[1] = bar(now + 60_000); },
  () => { pageBars[0]!.close = 0; },
]) {
  test("malformed, out-of-window or nonchronological cache rows never receive source evidence", async () => {
    mutate(); const result = await getCandleHistory(request());
    assert.equal(result.ok, false); assert.equal(result.candles.length, 0); assert.equal(result.historyEvidence, null);
  });
}

test("bound history refuses an invalid identity or absent cursor without touching data sources", async () => {
  for (const input of [{ ...request(), expectedSourceIdentity: "forged" }, { ...request(), before: null }]) {
    const result = await getCandleHistory(input); assert.equal(result.ok, false);
  }
  assert.equal(cacheReads, 0); assert.equal(routeReads, 0);
});

if (process.env.ARX_HISTORY_BENCHMARK === "1") {
  test("record isolated cached-history processing overhead without claiming provider latency", async (context) => {
    pageBars = Array.from({ length: 500 }, (_, index) => bar(now - (510 - index) * 60_000));
    const strict = { ...request(), limit: 500 };
    const { expectedSourceIdentity: _identity, ...legacy } = strict;
    const results: Record<string, unknown> = {};
    for (const [name, input] of [["legacy_unattested", legacy], ["source_bound", strict]] as const) {
      for (let warmup = 0; warmup < 50; warmup++) await getCandleHistory(input);
      const samples: number[] = [];
      routeReads = 0; cacheReads = 0;
      for (let index = 0; index < 500; index++) {
        const start = performance.now();
        const result = await getCandleHistory(input);
        samples.push(performance.now() - start);
        assert.equal(result.candles.length, 500);
        assert.equal(result.status, "historical_only");
      }
      samples.sort((a, b) => a - b);
      const percentile = (p: number) => samples[Math.ceil(samples.length * p) - 1];
      results[name] = { samples: samples.length, barsPerPage: 500,
        medianMs: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
        routeReads, cacheReads };
    }
    context.diagnostic("HISTORY_BENCHMARK " + JSON.stringify({ scope: "Local service processing; source and storage IO mocked; no network, database or competitor latency measurement", results }));
  });
}
