// A cached history window that is long enough can still be two segments with
// a hole between them. For a Deriv synthetic (a market that never closes) the
// newest window repairs that hole from the same producer; it never invents
// bars and never touches a hole the provider cannot fill.
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx \
//        --experimental-test-module-mocks --test src/lib/data/__qa__/historyHoleRepair.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

const M1 = 60_000;
const tip = Math.floor(Date.now() / M1) * M1 - M1; // newest closed bar
const bar = (t: number) => ({ time: new Date(t).toISOString(), open: 100, high: 102, low: 99, close: 101 });
let cache = new Map<number, ReturnType<typeof bar>>();
let fetches: number[] = [];
let providerHas: (t: number) => boolean = () => true;
let producer = "deriv_public";

mock.module("../marketDataRouter.js", { namedExports: {
  classifySymbol: () => "synthetic",
  routeCandles: async () => ({ ok: true, symbol: "V25_1S", assetClass: "synthetic", primaryProvider: "deriv_public",
    candles: [bar(tip)], provenance: null, userMessage: "", attempts: [] }),
} });
mock.module("../candleCache.js", { namedExports: {
  readCachedCandles: async ({ limit }: { limit: number }) => {
    const all = [...cache.keys()].sort((a, b) => a - b), page = all.slice(-limit).map(t => cache.get(t)!);
    return { candles: page, count: page.length, oldest: page[0]?.time ?? null, newest: page.at(-1)?.time ?? null, hasOlderInCache: all.length > limit };
  },
  getCacheCoverage: async () => ({ oldest: null, newest: null }),
  listCachedSources: async () => [],
  upsertCandles: async (_s: string, _tf: string, _source: string, bars: Array<ReturnType<typeof bar>>) => {
    for (const b of bars) cache.set(Date.parse(b.time), b);
    return { written: bars.length, rejected: 0 };
  },
  isValidCacheOhlc: () => true,
} });
// Other modules import more from these two; keep their real exports and
// replace only the producer identity and the candle fetch.
const realFeedClient = await import("../providers/derivFeedClient.js");
const realDerivProvider = await import("../providers/derivProvider.js");
mock.module("../providers/derivFeedClient.js", { namedExports: { ...realFeedClient, derivMarketDataSource: () => "deriv_public" } });
mock.module("../providers/derivProvider.js", { namedExports: { ...realDerivProvider,
  getDerivCandles: async (_s: string, _tf: string, count: number, endEpochSeconds: number) => {
    fetches.push(endEpochSeconds);
    const end = Math.floor((endEpochSeconds * 1000) / M1) * M1, candles = [];
    for (let t = end - (count - 1) * M1; t <= end; t += M1) if (providerHas(t)) candles.push({ epoch: t / 1000, open: 100, high: 102, low: 99, close: 101 });
    return { ok: candles.length > 0, source: producer, candles, reason: null };
  },
} });
const { getCandleHistory } = await import("../candleHistoryService.js");

const holes = (candles: Array<{ time: string }>) => candles.slice(1).filter((c, i) => Date.parse(c.time) - Date.parse(candles[i]!.time) !== M1).length;
/** 400 cached minutes ending at the tip, with minutes 150..249 (from the end) missing. */
function seedWithHole() {
  cache = new Map(); fetches = []; providerHas = () => true; producer = "deriv_public";
  for (let k = 0; k < 400; k++) if (k < 150 || k >= 250) cache.set(tip - k * M1, bar(tip - k * M1));
}
beforeEach(seedWithHole);

test("a hole inside the newest synthetic window is filled from the same producer", async () => {
  const out = await getCandleHistory({ symbol: "V25_1S", timeframe: "M1", limit: 300 });
  assert.equal(out.source, "deriv_public"); assert.equal(out.candles.length, 300);
  assert.equal(holes(out.candles), 0);
  // One fetch, ending just before the first bar after the hole.
  assert.deepEqual(fetches, [Math.floor((tip - 149 * M1) / 1000) - 1]);
  assert.equal(out.cacheHit, false);
});

test("a hole the provider cannot fill is left as it is, after a bounded number of fetches", async () => {
  providerHas = t => t > tip - 150 * M1 || t <= tip - 250 * M1; // provider has the same hole
  const out = await getCandleHistory({ symbol: "V25_1S", timeframe: "M1", limit: 300 });
  assert.equal(holes(out.candles), 1); assert.equal(fetches.length, 1);
  for (const c of out.candles) assert.ok(cache.has(Date.parse(c.time)), "served only stored bars");
});

test("a response from a different producer is not written into this series", async () => {
  producer = "deriv";
  const out = await getCandleHistory({ symbol: "V25_1S", timeframe: "M1", limit: 300 });
  assert.equal(holes(out.candles), 1); assert.equal(cache.size, 300);
});

test("a back page is not repaired; only the newest window is", async () => {
  const out = await getCandleHistory({ symbol: "V25_1S", timeframe: "M1", limit: 300, source: "deriv_public", before: new Date(tip + M1).toISOString() });
  assert.equal(out.ok, true); assert.deepEqual(fetches, []);
});
