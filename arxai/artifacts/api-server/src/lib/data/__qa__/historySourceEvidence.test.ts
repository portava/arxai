import { beforeEach, mock, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { MarketCandlesResult } from "../marketDataRouter.js";
import { db, brokerCandlesTable, brokerCandleBackfillStatusTable } from "@workspace/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as connections from "../../brokerHub/connections.js";
import { fixedFeedScope, runWithFeedScope } from "../feedScope.js";
import { brokerHistoryIdentity } from "../brokerHistoryPolicy.js";

const now = Math.floor(Date.now() / 60_000) * 60_000;
const bar = (time: number) => ({ time: new Date(time).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 0 });
const before = new Date(now - 5 * 60_000).toISOString();
let sourceMode = "deriv_public";
let cacheReads = 0;
let routeReads = 0;
const routeLimits: number[] = [];
let afterCacheRead: (() => void) | null = null;
let pageBars = [bar(now - 10 * 60_000), bar(now - 9 * 60_000)];
const cacheRequests: Array<{ symbol: string; timeframe: string; source: string; before?: string | null; limit: number }> = [];
let hasOlderInCache = true;
let fetchProducer: string | null | undefined = undefined;
let permitProviderFetch = false;
const writtenSources: string[] = [];
let routed: MarketCandlesResult;
const OWNER = 73, BRIDGE = 27;
const nativeIdentity = brokerHistoryIdentity({ userId: OWNER, bridgeConnectionId: BRIDGE,
  accountNumber: "offline-history-account", serverName: "offline-history-server", clockBasis: "broker_server" });
const connectionReads: Array<[number, number]> = [];
mock.module("../../brokerHub/connections.js", { namedExports: { ...connections,
  getUserConnection: async (userId: number, bridge: number) => {
    connectionReads.push([userId, bridge]);
    return userId === OWNER && bridge === BRIDGE
      ? { accountNumber: "offline-history-account", serverName: "offline-history-server" } : null;
  },
} });

function nativeReadFixture(context: TestContext, complete: boolean) {
  const queries: Array<{ table: unknown; params: unknown[]; sql: string; limit: number }> = [];
  context.mock.method(db, "select", (() => ({
    from: (table: unknown) => ({ where: (condition: SQL) => {
      const compiled = new PgDialect().sqlToQuery(condition);
      const finish = (limit: number) => {
        queries.push({ table, ...compiled, limit });
        if (table === brokerCandleBackfillStatusTable) return Promise.resolve([{
          brokerSymbol: "Volatility 75 Index", status: complete ? "COMPLETE" : "BUILDING",
          statusReason: complete ? "all_available_native_pages_verified" : "backfill_pending",
          barsStored: 200, coverageDays: 10, oldestStoredAt: new Date(pageBars[0]!.time), boundaryRaw: null,
        }]);
        assert.equal(table, brokerCandlesTable);
        const bars = complete ? pageBars : [bar(now - 11 * 60_000), ...pageBars];
        return Promise.resolve(bars.slice().reverse().map(c => ({
          rawOpenTime: new Date(c.time), openTimeUtc: new Date(c.time), brokerSymbol: "Volatility 75 Index",
          open: c.open, high: c.high, low: c.low, close: c.close, tickVolume: 0, tickVolumeObserved: false,
          historyIdentity: nativeIdentity, clockBasis: "broker_server", source: "mt5_ea",
        })));
      };
      return { limit: finish, orderBy: () => ({ limit: finish }) };
    } }),
  })) as unknown as typeof db.select);
  return queries;
}

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
  routeCandles: async (_symbol: string, _timeframe: string, limit: number) => { routeReads++; routeLimits.push(limit); return routed; },
} });
mock.module("../providers/derivFeedClient.js", { namedExports: { derivMarketDataSource: () => sourceMode } });
mock.module("../providers/derivProvider.js", { namedExports: {
  isDerivSyntheticSymbol: (symbol: string) => symbol === "V75",
  resolveDerivFeedSymbol: (symbol: string) => symbol === "V75" ? { symbol: "V75", derivId: "R_75" } : null,
  getDerivCandles: async () => {
    assert.equal(permitProviderFetch, true, "Unexpected provider request in cached fixture");
    sourceMode = "deriv";
    await Promise.resolve();
    sourceMode = "deriv_public"; // Same final mode must not attest the response.
    return { ok: true, reason: null, source: fetchProducer,
      candles: [bar(now - 10 * 60_000), bar(now - 9 * 60_000)].map(c => ({ ...c, epoch: Date.parse(c.time) / 1000 })) };
  },
} });
mock.module("../candleCache.js", { namedExports: {
  readCachedCandles: async (args: { symbol: string; timeframe: string; source: string; before?: string | null; limit: number }) => {
    cacheRequests.push(args);
    cacheReads++; afterCacheRead?.();
    return { candles: pageBars, count: pageBars.length, oldest: pageBars[0]?.time ?? null,
      newest: pageBars.at(-1)?.time ?? null, hasOlderInCache };
  },
  getCacheCoverage: async () => ({ oldest: pageBars[0]?.time ?? null, newest: pageBars.at(-1)?.time ?? null }),
  listCachedSources: async () => [],
  upsertCandles: async (_symbol: string, _tf: string, source: string, bars: typeof pageBars) => {
    assert.equal(permitProviderFetch, true, "Unexpected write in cached fixture");
    writtenSources.push(source); pageBars = bars; hasOlderInCache = true;
  },
  isValidCacheOhlc: (bar: { open: number; high: number; low: number; close: number }) =>
    [bar.open, bar.high, bar.low, bar.close].every(n => Number.isFinite(n) && n > 0)
      && bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close),
} });
const { getCandleHistory } = await import("../candleHistoryService.js");
const { scannerSourceIdentity } = await import("../../scannerInputIntegrity.js");
const request = () => ({ symbol: "V75", timeframe: "M1", source: "deriv_public", before, limit: 2,
  expectedSourceIdentity: scannerSourceIdentity(routed) });
beforeEach(() => {
  sourceMode = "deriv_public"; cacheReads = 0; routeReads = 0; routeLimits.length = 0; afterCacheRead = null; cacheRequests.length = 0;
  hasOlderInCache = true; fetchProducer = undefined; permitProviderFetch = false; writtenSources.length = 0; connectionReads.length = 0;
  pageBars = [bar(now - 10 * 60_000), bar(now - 9 * 60_000)]; resetRouted();
});

test("public provider history returns actual matching source evidence and remains historical", async () => {
  const input = request();
  const result = await getCandleHistory(input);
  assert.equal(result.ok, true); assert.equal(result.status, "historical_only");
  assert.equal(result.candles.length, 2); assert.equal(cacheReads, 1); assert.equal(routeReads, 1);
  assert.deepEqual(routeLimits, [2], "the two-bar request is only a source-identity check");
  assert.deepEqual(writtenSources, [], "the identity check does not write to the shared candle cache");
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
    assert.match(result.limitationReason!, source === "mt5_broker" ? /Sign in with the chart's broker connection/ : /identity cannot be verified/);
    assert.equal(cacheReads, 0); assert.equal(routeReads, 0); assert.deepEqual(routeLimits, []);
  });
}

test("native MT5 history remains pageable within its owner and immutable account era, without UTC evidence", async (context) => {
  const queries = nativeReadFixture(context, false);
  const { expectedSourceIdentity: _, ...input } = request();
  const result = await runWithFeedScope(fixedFeedScope(BRIDGE, OWNER), () =>
    getCandleHistory({ ...input, userId: OWNER, source: "mt5_broker" }));
  assert.equal(result.ok, true);
  assert.equal(result.status, "historical_only");
  assert.equal(result.source, "mt5_broker");
  assert.deepEqual(result.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })),
    pageBars.map(({ volume: _, ...c }) => c));
  assert.equal(result.returnedCount, pageBars.length);
  assert.equal(result.hasMoreHistory, true);
  assert.equal(result.nextBefore, pageBars[0]!.time);
  assert.equal(result.historyEvidence, null, "native source clock never becomes public-provider UTC evidence");
  assert.equal(result.nativeHistoryEvidence?.sourceIdentity, nativeIdentity);
  assert.equal(result.nativeHistoryEvidence?.clockBasis, "broker_server");
  assert.equal(result.providerLimitReached, false, "an import in progress is not proof of the broker's oldest available bar");
  assert.equal(routeReads, 0);
  assert.deepEqual(writtenSources, []);
  assert.deepEqual(cacheRequests, [], "native history never reads the mixed legacy cache");
  assert.deepEqual(connectionReads, [[OWNER, BRIDGE]]);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.deepEqual(query.params.slice(0, 3), [OWNER, BRIDGE, nativeIdentity]);
    assert.match(query.sql, /"user_id" = .*"bridge_connection_id" = .*"history_identity" = /);
  }
  assert.equal(queries[1]!.limit, 3, "one extra row establishes whether another page exists");
  assert.deepEqual(queries[1]!.params.slice(3), ["Volatility 75 Index", "M1", true, before]);
});

test("native MT5 exhaustion requires a verified importer boundary within the owner scope", async (context) => {
  pageBars = [bar(now - 10 * 60_000)];
  nativeReadFixture(context, true);
  const { expectedSourceIdentity: _, ...input } = request();
  const result = await runWithFeedScope(fixedFeedScope(BRIDGE, OWNER), () =>
    getCandleHistory({ ...input, userId: OWNER, source: "mt5_broker", limit: 500 }));
  assert.equal(result.ok, true);
  assert.equal(result.providerLimitReached, true);
  assert.equal(result.hasMoreHistory, false);
  assert.equal(result.providerMessage, "All available native history imported.");
  assert.equal(result.nativeHistoryEvidence?.importStatus, "COMPLETE");
  assert.equal(result.historyEvidence, null);
  assert.deepEqual(cacheRequests, []);
  assert.equal(routeReads, 0);
});

test("legacy MT5 cache rows remain inaccessible without the authenticated owner and bridge", async () => {
  const { expectedSourceIdentity: _, ...input } = request();
  for (const [userId, bridge] of [[undefined, BRIDGE], [OWNER, null], [OWNER + 1, BRIDGE]] as const) {
    const result = await runWithFeedScope(fixedFeedScope(bridge, userId ?? null), () =>
      getCandleHistory({ ...input, userId, source: "mt5_broker" }));
    assert.equal(result.ok, false); assert.deepEqual(result.candles, []);
    assert.equal(result.historyEvidence, null); assert.equal(result.nativeHistoryEvidence, undefined);
  }
  assert.deepEqual(cacheRequests, []); assert.equal(routeReads, 0); assert.deepEqual(writtenSources, []);
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

for (const producer of ["deriv", null, undefined]) {
  test(`a returned ${producer} producer never pollutes the public namespace during a mode ABA`, async () => {
    pageBars = []; hasOlderInCache = false; permitProviderFetch = true; fetchProducer = producer;
    const result = await getCandleHistory(request());
    assert.equal(sourceMode, "deriv_public");
    assert.equal(result.ok, false); assert.equal(result.candles.length, 0);
    assert.equal(result.historyEvidence, null); assert.deepEqual(writtenSources, []);
    assert.match(result.providerMessage!, /original Deriv transport/);
  });
}

test("a captured public producer may backfill its own namespace despite an intervening mode flip", async () => {
  pageBars = []; hasOlderInCache = false; permitProviderFetch = true; fetchProducer = "deriv_public";
  const result = await getCandleHistory(request());
  assert.equal(result.ok, true); assert.equal(result.candles.length, 2);
  assert.equal(result.historyEvidence?.source, "deriv_public");
  assert.deepEqual(writtenSources, ["deriv_public"]);
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
