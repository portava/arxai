import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Candle } from "../../types.js";

const now = Date.UTC(2026, 10, 21, 10, 15, 15);
const minute = 60_000;
const bars: Candle[] = Array.from({ length: 61 }, (_, i) => ({
  time: new Date(now - 15_000 - (60 - i) * minute).toISOString(),
  open: 100, high: 104, low: 99, close: 103,
}));
let online = true;
let writes = 0;
const storage = new Map<string, Candle[]>();
const realRouter = await import("../../marketDataRouter.js");
mock.module("../../marketDataRouter.js", { namedExports: { ...realRouter,
  routeCandles: async (symbol: string) => ({
    ok: online, symbol, assetClass: "synthetic", candles: online ? bars : [],
    primaryProvider: online ? "deriv_public" : null, attempts: [], provenance: null,
  }),
} });
const cache = await import("../../candleCache.js");
mock.module("../../candleCache.js", { namedExports: { ...cache,
  upsertCandles: async (symbol: string, tf: string, source: string, candles: Candle[]) => {
    writes++;
    assert.equal(source, "deriv_public");
    storage.set(symbol + tf, candles);
    return { written: candles.length, rejected: 0 };
  },
  listCachedSources: async (symbol: string, tf: string) => {
    const candles = storage.get(symbol + tf) ?? [];
    return candles.length ? [{ source: "deriv_public", newest: candles.at(-1)!.time, count: candles.length }] : [];
  },
  readCachedCandles: async ({symbol, timeframe}: {symbol: string; timeframe: string}) => {
    const candles = storage.get(symbol + timeframe) ?? [];
    return { candles, count: candles.length };
  },
} });
const { getChartCandles } = await import("../chartDataService.js");

test("public chart retains closed bars across an outage and resumes on recovery", async () => {
  mock.timers.enable({ apis: ["Date"], now });
  const display = (symbol = "V75", tf: "M1" | "M5" = "M1") =>
    getChartCandles(symbol, tf, 61, true, { storedHistoryFallback: true });
  try {
    await display();
    await display();
    assert.equal(writes, 1);
    assert.equal(storage.get("V75M1")?.length, 60);
    online = false;
    const stored = await display();
    assert.equal(stored.candleCount, 60);
    assert.equal(stored.feedStatus.notLiveReason, "stored_history");
    assert.equal(stored.aiUsable, false);
    assert.equal(stored.marketEvidence, null);
    assert.equal((await display("V100")).candleCount, 0);
    assert.equal((await display("V75", "M5")).candleCount, 0);
    assert.equal((await getChartCandles("V75", "M1", 61)).candleCount, 0);
    online = true;
    bars[59] = { ...bars[59]!, close: 101 };
    const fresh = await display();
    assert.notEqual(fresh.feedStatus.notLiveReason, "stored_history");
    assert.equal(storage.get("V75M1")?.at(-1)?.close, 101);
    assert.equal(writes, 2);
  } finally { mock.timers.reset(); }
});
