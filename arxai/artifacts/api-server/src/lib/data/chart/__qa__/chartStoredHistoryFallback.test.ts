// PR #112 adapted to the Replit chartDataService, without the PR #108 layer.
// All cache/router/session reads are fixtures; no app DB or provider requests.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

type Bar = { time: string; open: number; high: number; low: number; close: number; volume: number };
const stored = new Map<string, Bar[]>();
const reads: Array<{ symbol: string; timeframe: string; source: string; limit: number }> = [];
let failRead = false;
let liveBars: Bar[] = [];
const key = (s: string, tf: string, src: string) => `${s.trim().toUpperCase()}|${tf}|${src}`;
const asset = (s: string) => s === "R_75" ? "synthetic" : s === "XAUUSD" || s === "XAGUSD" ? "metals"
  : s === "BTCUSD" ? "crypto" : s === "US30" ? "indices" : s === "AAPL" ? "stocks" : "forex";
const empty = (s: string) => ({
  ok: false, symbol: s, assetClass: asset(s), candles: [],
  primaryProvider: null, attempts: [], userMessage: "No live feed", adminDetail: "offline fixture",
});
mock.method(globalThis, "fetch", async () => { throw new Error("External traffic forbidden in stored-history tests"); });
const realCache = await import("../../candleCache.js");
mock.module("../../candleCache.js", { namedExports: {
  ...realCache,
  async listCachedSources(symbol: string, timeframe: string) {
    if (failRead) throw new Error("fixture read failure");
    return [...stored].flatMap(([k, v]) => {
      const [sym, tf, source] = k.split("|");
      return sym === symbol.trim().toUpperCase() && tf === timeframe && v.length
        ? [{ source, count: v.length, oldest: v[0]!.time, newest: v.at(-1)!.time }] : [];
    });
  },
  async readCachedCandles(args: typeof reads[number]) {
    reads.push(args);
    const all = stored.get(key(args.symbol, args.timeframe, args.source)) ?? [];
    const page = all.slice(-args.limit);
    return { candles: page, count: page.length, oldest: page[0]?.time ?? null, newest: page.at(-1)?.time ?? null, hasOlderInCache: all.length > page.length };
  },
} });
const session = await import("../sessionProfile.js");
mock.module("../sessionProfile.js", { namedExports: { ...session, getSessionProfile: async () => null } });
mock.module("../../marketDataRouter.js", { namedExports: {
  classifySymbol: asset,
  routeCandles: async (s: string) => liveBars.length ? {
    ...empty(s), ok: true, candles: liveBars, primaryProvider: "mt5_broker",
  } : empty(s),
} });
// A matching live tick must not get attached to the stored series.
const composer = await import("../formingBarComposer.js");
mock.module("../formingBarComposer.js", { namedExports: {
  ...composer,
  isFormingTickSource: () => true,
  getFormingBar: () => ({ openMs: Math.floor(Date.now() / 1_800_000) * 1_800_000 + 1_800_000, open: 1, high: 2, low: 1, close: 2, tickCount: 5 }),
  getFormingTickAgeMs: () => 0,
} });
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
const { routeStoredCandleHistory, isNonMarketSource } = await import("../../storedCandleHistory.js");
const M30 = 1_800_000;
function bars(base: number, newest: number, n = 80): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(newest - (n - 1 - i) * M30).toISOString(),
    open: base + i * .5, high: base + i * .5 + 1,
    low: base + i * .5 - 1, close: base + i * .5 + .3, volume: 5,
  }));
}
beforeEach(() => { stored.clear(); bridgeStored.clear(); reads.length = 0; failRead = false; liveBars = []; });
test("gold: no feed displays exactly the stored bars, not live or AI-usable, with no forming tip or evidence", async () => {
  const newest = Math.floor(Date.now() / M30) * M30 - 10 * M30;
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(2400, newest));
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.candles.length, 80);
  assert.equal(out.candles.at(-1)!.openTime, new Date(newest).toISOString());
  assert.equal(out.source, "mt5_broker");
  assert.equal(out.feedStatus.isLive, false);
  assert.equal(out.aiUsable, false);
  assert.equal(out.feedStatus.aiUsable, false);
  assert.equal(out.feedStatus.notLiveReason, "stored_history");
  assert.match(out.feedStatus.message, /Showing stored .*candles for XAUUSD up to the last bar \(opened .*UTC, .*ago\)/);
  assert.match(out.feedStatus.message, /history, not live data/);
  assert.equal(out.warning, out.feedStatus.message);
  assert.equal(out.marketEvidence, null);
  assert.ok(out.candles.every(c => !c.isForming));
  assert.match(out.truthResult!.sourceDocumentation.dataMode, /^HISTORICAL/);
});
for (const symbol of ["EURUSD", "US30", "BTCUSD", "AAPL", "R_75"]) test(`${symbol}: same display-only fallback across asset classes`, async () => {
  stored.set(key(symbol, "M30", "assistant_real:twelve_data"), bars(100, Date.now() - 4 * M30, 40));
  const out = await getChartCandles(symbol, "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.candles.length, 40);
  assert.equal(out.feedStatus.isLive, false);
  assert.equal(out.aiUsable, false);
  assert.equal(out.feedStatus.notLiveReason, "stored_history");
});
test("MT5 store wins over a newer provider within the preference window; one read, no blending, no bridge attribution", async () => {
  // Bars are on one UTC clock (convert-at-ingest), so the mirror is preferred
  // while its newest bar is within MT5_MIRROR_PREFERENCE_INTERVALS of the newest.
  stored.set(key("XAUUSD", "M30", "assistant_real:twelve_data"), bars(9000, Date.now(), 120));
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(2400, Date.now() - 2 * M30, 50));
  const out = await routeStoredCandleHistory("XAUUSD", "30m", 30, empty("XAUUSD") as never);
  assert.equal(out.primaryProvider, "mt5_broker");
  assert.equal(out.candles.length, 30);
  assert.ok(out.candles.every(c => c.close < 9000));
  assert.equal(reads.length, 1);
  assert.equal(out.provenance?.delayed, null);
  assert.equal(out.provenance?.bridgeConnectionId, null);
  assert.equal(out.provenance?.userId, null);
  assert.equal(out.provenance?.subProviderId, "stored_history");
});
test("without MT5 select most recent bar, not biggest stored source", async () => {
  stored.set(key("XAUUSD", "M30", "old_provider"), bars(2400, Date.now() - 10 * M30, 100));
  stored.set(key("XAUUSD", "M30", "new_provider"), bars(2500, Date.now() - 4 * M30, 20));
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.source, "new_provider"); assert.equal(out.candles.length, 20);
  assert.equal(reads.length, 1);
});
test("mock and developer sources refused, including uppercase and delimited variants", async () => {
  for (const src of ["mock", "DEV", "dev_feed", "provider_test", "twelveData_mock_shim"]) {
    assert.equal(isNonMarketSource(src), true);
    stored.set(key("XAUUSD", "M30", src), bars(2400, Date.now()));
  }
  const out = await getChartCandles("XAUUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.candles.length, 0); assert.equal(reads.length, 0);
});
test("without opt-in analysis and feed-status remain empty; cache is not consulted", async () => {
  stored.set(key("XAUUSD", "M30", "mt5_broker"), bars(2400, Date.now()));
  assert.equal((await getChartCandles("XAUUSD", "M30", 300)).candles.length, 0);
  // The feed status always carries notLiveReason (null when no not-live
  // reason applies), so absence of stored history is an explicit null.
  assert.equal((await getChartFeedStatus("XAUUSD", "M30")).notLiveReason, null);
  assert.equal(reads.length, 0);
});
test("feed status agrees with canvas, even when newest stored bar is recent", async () => {
  stored.set(key("GBPUSD", "M30", "mt5_broker"), bars(100, Math.floor(Date.now() / M30) * M30 - M30));
  const data = await getChartCandles("GBPUSD", "M30", 300, true, { storedHistoryFallback: true });
  const status = await getChartFeedStatus("GBPUSD", "M30", true, { storedHistoryFallback: true });
  assert.equal(status.source, data.source); assert.equal(status.lastCandleTime, data.feedStatus.lastCandleTime);
  assert.equal(status.isLive, false); assert.equal(status.aiUsable, false);
  assert.equal(status.notLiveReason, "stored_history"); assert.equal(data.candles.length, 80);
});
test("nothing stored: honest empty state", async () => {
  const out = await getChartCandles("XAGUSD", "M30", 300, true, { storedHistoryFallback: true });
  assert.equal(out.candles.length, 0); assert.equal(out.feedStatus.isLive, false);
  assert.equal(out.feedStatus.notLiveReason, null);
});
test("missing/read-failed store returns original empty router result unchanged", async () => {
  const prior = empty("XAUUSD") as never;
  assert.equal(await routeStoredCandleHistory("XAUUSD", "M30", 300, prior), prior);
  failRead = true;
  assert.equal(await routeStoredCandleHistory("XAUUSD", "M30", 300, prior), prior);
});
test("a live router result is never replaced by stored history", async () => {
  liveBars = bars(100, Date.now() - M30);
  const out = await getChartCandles("EURUSD", "M30", 300, false, { storedHistoryFallback: true });
  assert.equal(out.feedStatus.notLiveReason, null); assert.equal(reads.length, 0);
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
