// The chart-history seed (legacy getCandleHistory initial page) stores only
// closed bars, and never writes a routed MT5 window into the broker mirror
// without the writing bridge's attribution (2026-11-04 feed sweep).
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx \
//        --experimental-test-module-mocks --test src/lib/data/__qa__/historyCacheSeed.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { MarketCandlesResult } from "../marketDataRouter.js";

const M5 = 5 * 60_000;
const bar = (t: number) => ({ time: new Date(t).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 1 });
let routed: MarketCandlesResult;
const writes: Array<{ source: string; times: string[]; bridgeConnectionId: number | null }> = [];

mock.module("../marketDataRouter.js", { namedExports: {
  classifySymbol: () => "forex",
  routeCandles: async () => routed,
} });
mock.module("../candleCache.js", { namedExports: {
  readCachedCandles: async () => ({ candles: [], count: 0, oldest: null, newest: null, hasOlderInCache: false }),
  getCacheCoverage: async () => ({ oldest: null, newest: null }),
  listCachedSources: async () => [],
  upsertCandles: async (_s: string, _tf: string, source: string, bars: Array<{ time: string }>, opts?: { bridgeConnectionId?: number | null }) => {
    writes.push({ source, times: bars.map((b) => b.time), bridgeConnectionId: opts?.bridgeConnectionId ?? null });
    return { written: bars.length, rejected: 0 };
  },
  isValidCacheOhlc: () => true,
} });
const { getCandleHistory } = await import("../candleHistoryService.js");

function route(provider: string, bridgeConnectionId: number | null) {
  const formingOpen = Math.floor(Date.now() / M5) * M5;
  routed = {
    ok: true, symbol: "EURUSD", assetClass: "forex", primaryProvider: provider,
    candles: [bar(formingOpen - 2 * M5), bar(formingOpen - M5), bar(formingOpen)],
    provenance: { providerId: provider, subProviderId: null, sourceId: `${provider}:EURUSD:M5`, bridgeConnectionId,
      userId: null, brokerSymbol: null, environment: "unknown", source: "DERIVED", delayed: false, receivedAt: new Date().toISOString() },
    userMessage: "", attempts: [],
  } as unknown as MarketCandlesResult;
  return formingOpen;
}

beforeEach(() => { writes.length = 0; });

test("a provider window is seeded without its forming bar", async () => {
  const formingOpen = route("assistant_real:twelve_data", null);
  await getCandleHistory({ symbol: "EURUSD", timeframe: "M5", limit: 50 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.times.length, 2);
  assert.equal(writes[0]!.times.includes(new Date(formingOpen).toISOString()), false);
});

test("an unattributed MT5 window is still seeded closed-only, with no bridge named", async () => {
  // The chart history page reads from the cache, so skipping the seed would
  // leave a live MT5 series with no history (candleDepthDiagnosticsTest).
  route("mt5_broker", null);
  await getCandleHistory({ symbol: "EURUSD", timeframe: "M5", limit: 50 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.bridgeConnectionId, null);
  assert.equal(writes[0]!.times.length, 2);
});

test("an attributed MT5 window is mirrored closed-only, naming its bridge", async () => {
  route("mt5_broker", 11);
  await getCandleHistory({ symbol: "EURUSD", timeframe: "M5", limit: 50 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.bridgeConnectionId, 11);
  assert.equal(writes[0]!.times.length, 2);
});
