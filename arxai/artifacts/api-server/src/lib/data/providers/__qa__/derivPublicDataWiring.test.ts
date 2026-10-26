// Executes the real public client → provider → router → feed resolver → ENTRY
// gate. Only socket I/O and the durable candle store are replaced offline.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

process.env.DATABASE_URL = "postgresql://offline@localhost/offline?host=%2Fprivate%2Ftmp%2Farx-no-db";
process.env.ARX_DERIV_PUBLIC_DATA_ENABLED = "true";
delete process.env.DERIV_APP_ID;
delete process.env.DERIV_API_TOKEN;
const sent: Record<string, any>[] = [];
let now = Date.now();
let tickEpoch = Math.floor(now / 1000);
class Socket extends EventEmitter {
  constructor(readonly url: string) { super(); queueMicrotask(() => this.emit("open")); }
  send(raw: string) {
    const r = JSON.parse(raw); sent.push(r);
    const reply = (body: unknown) => this.emit("message", JSON.stringify({ req_id: r.req_id, ...body as object }));
    if (r.active_symbols) reply({ active_symbols: [{ underlying_symbol: "R_75", underlying_symbol_name: "Volatility 75 Index", exchange_is_open: 1, is_trading_suspended: 0 }] });
    if (r.ticks) reply({ tick: { symbol: r.ticks, epoch: tickEpoch, quote: 123 }, subscription: { id: "r75" } });
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
const { getDerivFeedStatus, getDerivSymbolFeedStatus } = await import("../derivProvider.js");
const { routeCandles, routeQuote, getRouterDiagnostics } = await import("../../marketDataRouter.js");
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
