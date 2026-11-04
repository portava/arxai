// Closed market / down feed (2026-11-04): the chart DISPLAY keeps showing the
// market up to its last stored bar instead of an empty canvas, for every
// market on the platform. The bars are labelled stored history: never live,
// never AI-usable, no Truth market evidence. Analysis callers (no opt-in) are
// unchanged and still get the honest empty result.
// Drives the real router and chart feed with market_candles reads mocked.
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx \
//        --experimental-test-module-mocks --test \
//        src/lib/data/chart/__qa__/chartStoredHistoryFallback.test.ts

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Bar = { time: string; open: number; high: number; low: number; close: number; volume?: number };
const stored = new Map<string, Bar[]>(); // key symbol|tf|source

function key(symbol: string, tf: string, source: string) {
  return `${symbol.trim().toUpperCase()}|${tf}|${source}`;
}

const realCache = await import("../../candleCache.js");
mock.module("../../candleCache.js", {
  namedExports: {
    ...realCache,
    async listCachedSources(symbol: string, timeframe: string) {
      const out: Array<{ source: string; count: number; oldest: string | null; newest: string | null }> = [];
      for (const [k, v] of stored) {
        const [s, tf, source] = k.split("|");
        if (s === symbol.trim().toUpperCase() && tf === timeframe && v.length > 0) {
          out.push({ source: source!, count: v.length, oldest: v[0]!.time, newest: v.at(-1)!.time });
        }
      }
      return out.sort((a, b) => b.count - a.count);
    },
    async readCachedCandles(args: { symbol: string; timeframe: string; source: string; limit: number }) {
      const all = stored.get(key(args.symbol, args.timeframe, args.source)) ?? [];
      const page = all.slice(-args.limit);
      return { candles: page, count: page.length, oldest: page[0]?.time ?? null, newest: page.at(-1)?.time ?? null, hasOlderInCache: all.length > page.length };
    },
  },
});

// broker_candles (bridge-scoped) rows, keyed bridge|symbol|tf.
const bridgeStored = new Map<string, Bar[]>();
mock.module("../../bridgeStoredCandles.js", {
  namedExports: {
    async readBridgeStoredCandles(bridgeId: number, symbol: string, tf: string, limit: number) {
      const all = bridgeStored.get(`${bridgeId}|${symbol.trim().toUpperCase()}|${tf}`) ?? [];
      const page = all.slice(-limit);
      if (page.length === 0) return null;
      return { candles: page, brokerSymbol: symbol, userId: 1, newest: page.at(-1)!.time };
    },
  },
});

const { getChartCandles, getChartFeedStatus } = await import("../chartDataService.js");
const { routeCandles } = await import("../../marketDataRouter.js");
const { __resetMt5ProviderStore } = await import("../../providers/mt5Provider.js");

const M30 = 30 * 60_000;

function bars(base: number, newestOpenMs: number, n = 80): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const t = newestOpenMs - (n - 1 - i) * M30;
    const p = base + i * 0.5;
    return { time: new Date(t).toISOString(), open: p, high: p + 1, low: p - 1, close: p + 0.3, volume: 5 };
  });
}

beforeEach(() => {
  stored.clear();
  bridgeStored.clear();
  __resetMt5ProviderStore();
});

test("no feed: gold shows its stored bars up to the last one, labelled stored history and not live", async () => {
  const newest = Math.floor(Date.now() / M30) * M30 - 10 * M30; // feed went down 5 h ago
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(2400, newest));
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.candles.length, 80);
  assert.equal(out.candles.at(-1)!.openTime, new Date(newest).toISOString(), "the last stored bar is the newest one shown");
  assert.equal(out.source, "mt5_broker");
  assert.equal(out.feedStatus.isLive, false);
  assert.equal(out.feedStatus.aiUsable, false);
  assert.equal(out.feedStatus.notLiveReason, "stored_history");
  assert.match(out.feedStatus.message, /stored .*candles for XAUUSD up to the last bar/);
  assert.match(out.feedStatus.message, /not live data/);
  assert.equal(out.marketEvidence ?? null, null, "stored bars never become Truth market evidence");
  assert.ok(out.candles.every((c) => c.isForming !== true), "no live forming tip on stored history");
});

test("every market, not only gold: forex, indices and crypto stored by a provider are shown the same way", async () => {
  const newest = Math.floor(Date.now() / M30) * M30 - 4 * M30;
  for (const sym of ["EURUSD", "US30", "BTCUSD"]) {
    stored.set(key(sym, "M30", "assistant_real:twelve_data"), bars(100, newest, 40));
    const out = await getChartCandles(sym, "M30", 300, true, { storedHistoryFallback: true });
    assert.equal(out.candles.length, 40, sym);
    assert.equal(out.source, "assistant_real:twelve_data", sym);
    assert.equal(out.feedStatus.isLive, false, sym);
    assert.equal(out.feedStatus.aiUsable, false, sym);
    assert.equal(out.feedStatus.notLiveReason, "stored_history", sym);
  }
});

test("one source only: the MT5 broker store wins over another stored provider, series are never blended", async () => {
  const newest = Math.floor(Date.now() / M30) * M30 - 6 * M30;
  stored.set(key("XAUUSD", "M30", "assistant_real:twelve_data"), bars(9000, newest + 2 * M30, 120));
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(2400, newest, 50));
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.source, "mt5_broker");
  assert.equal(out.candles.length, 50);
  assert.ok(out.candles.every((c) => c.source === "mt5_broker" && c.close < 9000));
});

test("mock or developer rows are never shown as market history", async () => {
  stored.set(key("XAUUSD", "M30", "twelveData_mock_shim"), bars(1, Date.now() - 3 * M30));
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.candles.length, 0);
});

test("without the display opt-in nothing changes: analysis reads and the router stay honest-empty", async () => {
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(2400, Date.now() - 10 * M30));
  const analysis = await getChartCandles("XAUUSD", "M30", 300, false);
  assert.equal(analysis.candles.length, 0);
  const routed = await routeCandles("XAUUSD", "M30", 300);
  assert.equal(routed.ok, false);
});

test("the feed-status badge agrees with the canvas", async () => {
  stored.set(key("GBPUSD", "M30", "mt5_broker"), bars(1.25, Math.floor(Date.now() / M30) * M30 - 8 * M30));
  const status = await getChartFeedStatus("GBPUSD", "M30", true, { storedHistoryFallback: true });
  assert.equal(status.isLive, false);
  assert.equal(status.aiUsable, false);
  assert.equal(status.notLiveReason, "stored_history");
});

test("nothing stored at all: still the honest empty state", async () => {
  const out = await getChartCandles("XAGUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.candles.length, 0);
  assert.equal(out.feedStatus.isLive, false);
});

test("stale mirror: an MT5 mirror months older than another stored source does not win", async () => {
  const newest = Math.floor(Date.now() / M30) * M30 - 4 * M30;
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(2400, newest - 90 * 24 * 2 * M30, 50));
  stored.set(key("XAUUSD", "M30", "assistant_real:twelve_data"), bars(2500, newest, 60));
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.source, "assistant_real:twelve_data");
  assert.ok(out.candles.every((c) => c.close > 2450), "the current provider series, not the months-old mirror");
});

test("pinned reader: their own bridge's stored broker bars are served, labelled own_bridge", async () => {
  const newest = Math.floor(Date.now() / M30) * M30 - 6 * M30;
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(9000, newest, 50)); // another broker's mirror
  bridgeStored.set("11|XAUUSD|M30", bars(2400, newest - M30, 40));
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true, bridgeConnectionId: 11 });
  assert.equal(out.candles.length, 40);
  assert.ok(out.candles.every((c) => c.close < 9000), "never the shared mirror's prices");
  assert.equal(out.feedStatus.notLiveReason, "stored_history");
  assert.equal(out.feedStatus.feedScope, "own_bridge");
  assert.equal(out.feedStatus.isLive, false);
});

test("pinned reader with no stored bars of their own: the shared mirror, labelled platform_shared", async () => {
  const newest = Math.floor(Date.now() / M30) * M30 - 6 * M30;
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(9000, newest, 50));
  bridgeStored.set("22|XAUUSD|M30", bars(2400, newest, 40));
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true, bridgeConnectionId: 11 });
  assert.equal(out.candles.length, 50);
  assert.equal(out.feedStatus.feedScope, "platform_shared");
});
