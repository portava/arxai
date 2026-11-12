// Executes the real public client → provider → router → feed resolver → ENTRY
// gate. Only socket I/O and the durable candle store are replaced offline.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.DATABASE_URL = "postgresql://offline@localhost/offline?host=%2Fprivate%2Ftmp%2Farx-no-db";
process.env.ARX_DERIV_PUBLIC_DATA_ENABLED = "true";
delete process.env.DERIV_APP_ID;
delete process.env.DERIV_API_TOKEN;
const nonSynthetic = {
  EURUSD: "frxEURUSD", GBPUSD: "frxGBPUSD", USDJPY: "frxUSDJPY", USDCHF: "frxUSDCHF", USDCAD: "frxUSDCAD",
  AUDUSD: "frxAUDUSD", NZDUSD: "frxNZDUSD", EURJPY: "frxEURJPY", EURGBP: "frxEURGBP", EURAUD: "frxEURAUD",
  EURCAD: "frxEURCAD", GBPJPY: "frxGBPJPY", GBPAUD: "frxGBPAUD", GBPCAD: "frxGBPCAD", AUDJPY: "frxAUDJPY",
  XAUUSD: "frxXAUUSD", XAGUSD: "frxXAGUSD", BTCUSD: "cryBTCUSD", ETHUSD: "cryETHUSD", SPX500: "OTC_SPC", US30: "OTC_DJI", GER30: "OTC_GDAXI",
};
const sent: Record<string, any>[] = [];
let now = Date.now();
let tickEpoch = Math.floor(now / 1000);
const failedTicks = new Set<string>();
class Socket extends EventEmitter {
  constructor(readonly url: string) { super(); queueMicrotask(() => this.emit("open")); }
  send(raw: string) {
    const r = JSON.parse(raw); sent.push(r);
    const reply = (body: unknown) => this.emit("message", JSON.stringify({ req_id: r.req_id, ...body as object }));
    if (r.active_symbols) reply({ active_symbols: ["R_75", ...Object.values(nonSynthetic)].map(underlying_symbol => ({ underlying_symbol, underlying_symbol_name: underlying_symbol, exchange_is_open: 1, is_trading_suspended: 0 })) });
    if (r.ticks && failedTicks.has(r.ticks)) { reply({ error: { code: "TickUnavailable", message: "No tick" } }); return; }
    if (r.ticks) reply({ tick: { symbol: r.ticks, epoch: tickEpoch, quote: 123 }, subscription: { id: r.ticks } });
    if (r.ticks_history) reply({ echo_req: r, candles: Array.from({ length: 30 }, (_, i) => ({ epoch: Math.floor(now / 60_000) * 60 - (29 - i) * 60, open: 120, high: 125, low: 119, close: 123 })) });
    if (r.forget) reply({ forget: 1 });
    if (r.ping) reply({ ping: "pong" });
  }
  terminate() { this.emit("close"); }
}
mock.module("ws", { defaultExport: Socket });
const cacheWrites: { source: string }[] = [];
mock.module("../../candleCache.js", { namedExports: {
  isValidCacheOhlc: () => true,
  readCachedCandles: async () => ({ count: 0, candles: [], newest: null, oldest: null, hasOlderInCache: false }),
  getCacheCoverage: async () => ({ oldest: null, newest: null }),
  listCachedSources: async () => [],
  upsertCandles: async (_symbol: string, _tf: string, source: string) => { cacheWrites.push({ source }); },
} });

const { getDerivFeedClient } = await import("../derivFeedClient.js");
const { getDerivFeedStatus, getDerivSymbolFeedStatus, resolveDerivFeedSymbol, isDerivSyntheticSymbol } = await import("../derivProvider.js");
const { routeCandles, routeCandlesForDecision, routeQuote, quotePinForSeries, getRouterDiagnostics } = await import("../../marketDataRouter.js");
const { resolveBrokerConfirmedFeed, evaluateLiveEntryFeedGate } = await import("../../brokerConfirmedFeed.js");
const { normalizeCandles } = await import("../../chart/candleNormalization.js");
const { sourceSupportsDeepCursor } = await import("../../providerRoutingMap.js");
const { getCandleHistory } = await import("../../candleHistoryService.js");
after(() => { const client = getDerivFeedClient(); if ("stop" in client) client.stop(); });

test("public data is configured without credentials and fresh per-symbol quotes are not account authorization", async () => {
  const quote = await routeQuote("V75");
  assert.equal(quote.primaryProvider, "deriv_public"); assert.equal(quote.provenance?.providerId, "deriv_public");
  assert.equal(quote.provenance?.sourceId, "deriv_public:V75");
  assert.equal(quote.provenance?.bridgeConnectionId, null);
  assert.equal(quote.quote?.bid, undefined); assert.equal(quote.quote?.ask, undefined); assert.equal(quote.quote?.spread, undefined);
  const status = getDerivFeedStatus();
  assert.equal(status.configured, true); assert.equal(status.mode, "public"); assert.equal(status.authorized, false);
  assert.equal(status.appIdConfigured, false); assert.equal(status.apiTokenConfigured, false);
  assert.equal(status.feedReadinessState, "LIVE_FEED");
  assert.equal(getDerivSymbolFeedStatus("V75").hasRecentTick, true);
  assert.equal(getDerivSymbolFeedStatus("V75_1S").hasRecentTick, false);
  assert.equal(getDerivSymbolFeedStatus("V75_1S").feedReadinessState, "CONNECTED_AWAITING_FEED");
  assert.equal(getRouterDiagnostics().deriv.authorized, false);
});

test("real routed public candles remain analysis-live but the dispatch ENTRY gate refuses their actual returned fields", async () => {
  await routeQuote("V75");
  const routed = await routeCandles("V75", "M1", 30);
  assert.equal(routed.ok, true); assert.equal(routed.primaryProvider, "deriv_public");
  assert.equal(routed.provenance?.providerId, "deriv_public");
  assert.equal(routed.provenance?.sourceId, "deriv_public:V75:M1");
  const feed = await resolveBrokerConfirmedFeed("V75", "1m");
  assert.equal(feed.feedSource, "deriv_public"); assert.equal(feed.derivBacked, true);
  assert.equal(feed.verdict, "LIVE"); assert.equal(feed.hasRecentTick, true); assert.equal(feed.feedConfirmed, false);
  const args = { verdict: feed.verdict, source: feed.feedSource, derivBacked: feed.derivBacked };
  const entry = evaluateLiveEntryFeedGate({ ...args, intent: "ENTRY" });
  assert.equal(entry.allowed, false); assert.equal(entry.refusalCode, "BROKER_FEED_NOT_CONFIRMED");
  for (const intent of ["CLOSE", "REDUCE", "MODIFY"] as const) assert.equal(evaluateLiveEntryFeedGate({ ...args, intent }).allowed, true);
});

test("public OHLC retains open-time synthetic semantics and zero volume never becomes a ghost", async () => {
  const routed = await routeCandles("V75", "M1", 30);
  const normalized = normalizeCandles(routed.candles, { symbol: "V75", displaySymbol: "V75", timeframe: "M1", source: routed.primaryProvider, now });
  assert.equal(normalized.candles.length, 30);
  for (const candle of normalized.candles) {
    assert.equal(candle.sourceMode, "live"); assert.equal(candle.priceBasis, "SYNTHETIC");
    assert.equal(candle.qualityFlags.includes("ZERO_VOLUME_GHOST"), false);
  }
  assert.equal(sourceSupportsDeepCursor("deriv_public"), true);
});

test("a legacy history continuation cannot write public candles under its prior source", async () => {
  const before = sent.filter(r => r.ticks_history).length;
  const page = await getCandleHistory({ symbol: "V75", timeframe: "M1", source: "deriv", limit: 30, before: new Date(now - 60_000).toISOString() });
  assert.equal(page.source, "deriv"); assert.equal(page.providerLimitReached, true);
  assert.match(page.providerMessage ?? "", /original Deriv data connection/);
  assert.equal(sent.filter(r => r.ticks_history).length, before); assert.equal(cacheWrites.length, 0);
});

for (const [symbol, native] of Object.entries(nonSynthetic)) {
  test(`${symbol}: real public route serves exact instrument with independent tick freshness and honest price/volume basis`, async () => {
    assert.equal(resolveDerivFeedSymbol(symbol)?.derivId, native);
    assert.equal(isDerivSyntheticSymbol(symbol), false);
    const candles = await routeCandles(symbol, "M1", 30);
    assert.equal(candles.primaryProvider, "deriv_public");
    assert.equal(getDerivSymbolFeedStatus(symbol).hasRecentTick, true, "chart-only read must establish its own tick stream before any quote consumer");
    const quote = await routeQuote(symbol, quotePinForSeries(candles));
    assert.equal(quote.primaryProvider, "deriv_public");
    assert.equal(quote.quote?.last, 123);
    assert.equal(getDerivSymbolFeedStatus(symbol).hasRecentTick, true);
    assert.ok(sent.some(r => r.ticks_history === native));
    assert.ok(sent.some(r => r.ticks === native));
    const normalized = normalizeCandles(candles.candles, { symbol, displaySymbol: symbol, timeframe: "M1", source: candles.primaryProvider, now, priceBasisOverride: "MID" });
    assert.equal(normalized.candles.length, 30);
    for (const candle of normalized.candles) {
      assert.equal(candle.priceBasis, "UNKNOWN");
      assert.equal(candle.providerSymbol, native);
      assert.equal(candle.volumeEvidence?.kind, "unavailable");
      assert.equal(candle.qualityFlags.includes("ZERO_VOLUME_GHOST"), false);
    }
    const cached = normalizeCandles(candles.candles.map(c => ({ ...c, volume: 0 })), { symbol, displaySymbol: symbol, timeframe: "M1", source: candles.primaryProvider, now });
    assert.ok(cached.candles.every(c => c.volumeEvidence?.kind === "unavailable" && !c.qualityFlags.includes("ZERO_VOLUME_GHOST")), "legacy cache placeholders must not become observed volume");
    const before = sent.length;
    const decision = await routeCandlesForDecision(symbol, "M1", { intendedVenue: "deriv" });
    assert.equal(decision.verdict, "WAIT");
    assert.equal(decision.reason, "DERIV_EXECUTION_VENUE_REQUIRES_SYNTHETIC");
    assert.equal(sent.length, before);
    const mt5 = await routeCandlesForDecision(symbol, "M1", { intendedVenue: "mt5" });
    assert.equal(mt5.verdict, "WAIT");
    assert.equal(sent.length, before, "MT5 decision must never borrow the public feed");
    const feed = await resolveBrokerConfirmedFeed(symbol, "1m");
    assert.equal(feed.feedSource, "deriv_public");
    assert.equal(evaluateLiveEntryFeedGate({ verdict: feed.verdict, source: feed.feedSource, derivBacked: feed.derivBacked, intent: "ENTRY" }).allowed, false);
  });
}
test("missing crosses and different baskets/indices are never silently substituted", async () => {
  for (const symbol of ["CADJPY", "CHFJPY", "DXY", "WLDUSD", "WLDXAU"]) assert.equal(resolveDerivFeedSymbol(symbol), null);
  const before = sent.length;
  const client = getDerivFeedClient();
  await assert.rejects(() => client.getCandles("frxCADJPY", 60, 30), /UNKNOWN_SYMBOL/);
  await assert.rejects(() => client.getCandles("WLDUSD", 60, 30), /UNKNOWN_SYMBOL/);
  assert.equal(sent.length, before);
});

test("Germany 40 uses the existing approved ARX legacy key, not a guessed index substitution", async () => {
  const { resolveArxMarket } = await import("@workspace/domain/market");
  assert.equal(resolveArxMarket("GER40")?.canonicalSymbol, "GER30");
  assert.match(resolveArxMarket("GER30")?.displayName ?? "", /Germany 40/);
  assert.equal(resolveDerivFeedSymbol("GER40")?.symbol, "GER30");
  assert.equal(resolveDerivFeedSymbol("GER30")?.derivId, "OTC_GDAXI");
});

test("history cursor fetches do not create new live subscriptions", async () => {
  const client = getDerivFeedClient();
  await client.unsubscribeTicks("frxEURUSD");
  const before = sent.filter(r => r.ticks === "frxEURUSD").length;
  const { getDerivCandles } = await import("../derivProvider.js");
  const history = await getDerivCandles("EURUSD", "M1", 30, Math.floor(now / 1000) - 3600);
  assert.equal(history.ok, true);
  assert.equal(sent.filter(r => r.ticks === "frxEURUSD").length, before);
  const current = await getDerivCandles("EURUSD", "M1", 30);
  assert.equal(current.ok, true);
  assert.equal(sent.filter(r => r.ticks === "frxEURUSD").length, before + 1);
});

test("failed live subscription preserves real history without inventing tick freshness", async () => {
  const client = getDerivFeedClient();
  await client.unsubscribeTicks("frxEURUSD");
  failedTicks.add("frxEURUSD");
  try {
    const { getDerivCandles } = await import("../derivProvider.js");
    const result = await getDerivCandles("EURUSD", "M1", 30);
    assert.equal(result.ok, true);
    assert.equal(result.candles.length, 30);
    assert.equal(getDerivSymbolFeedStatus("EURUSD").hasRecentTick, false);
  } finally { failedTicks.delete("frxEURUSD"); }
});
