// Truth regression: the live scanner's source labels must name the feed the
// scored candles actually came from. Candles come from the unified market-data
// router (mt5_broker / deriv / assistant_real); the result used to be labelled
// with the assistant adapter's name ("twelve_data") regardless. Each candidate
// must also say where its entry price came from and as of when, and an old or
// undated quote must read stale.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.now();

function candles(n: number, startMs: number, stepMs: number) {
  return Array.from({ length: n }, (_, i) => {
    const base = 1.1 + i * 0.001;
    return { time: new Date(startMs + i * stepMs).toISOString(), open: base, high: base + 0.0005, low: base - 0.0003, close: base + 0.0004, volume: 10 };
  });
}

let candleProvider = "mt5_broker";
let quoteResult: Record<string, unknown> | null = null;
const CONNECTED_ADAPTER = { name: "twelve_data", connected: true, features: { quotes: true, candles: true, news: false } };
let adapter: { name: string; connected: boolean; features: { quotes: boolean; candles: boolean; news: boolean } } = CONNECTED_ADAPTER;
let candlesOk = true;
let adapterStatus = { stale: false, staleAfterMs: 300_000, lastError: null as string | null };

const realProvider = await import("../marketProvider.js");
mock.module("../marketProvider.js", {
  namedExports: {
    ...realProvider,
    getMarketProvider: () => adapter,
    getMarketStatus: () => adapterStatus,
  },
});
const realRouter = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    routeCandles: async (symbol: string, tf: string) => (!candlesOk ? {
      ok: false, symbol, assetClass: "forex", candles: [],
      primaryProvider: null, attempts: [], userMessage: "No candle feed answered", adminDetail: "",
    } : {
      ok: true, symbol, assetClass: "forex",
      candles: candles(30, NOW - 30 * (tf === "H1" ? 3_600_000 : 900_000), tf === "H1" ? 3_600_000 : 900_000),
      primaryProvider: candleProvider, attempts: [], userMessage: "Live feed active", adminDetail: "",
      provenance: { providerId: candleProvider, subProviderId: null },
    }),
    routeQuote: async () => quoteResult,
  },
});

const { scoreLiveCandidates } = await import("../liveScanner.js");
const { QUOTE_STALE_AFTER_MS } = await import("../../data/freshness.js");

function quote(provider: string, timestamp: string, tickTimeObserved: boolean) {
  return {
    ok: true, symbol: "EURUSD", assetClass: "forex",
    quote: { symbol: "EURUSD", last: 1.13, bid: 1.1299, ask: 1.1301, timestamp },
    primaryProvider: provider, attempts: [], userMessage: "", adminDetail: "",
    provenance: { providerId: provider }, tickTimeObserved,
  };
}

test("result and candidates name the router feed that served the candles, not the assistant adapter", async () => {
  candleProvider = "mt5_broker";
  quoteResult = quote("mt5_broker", new Date(NOW - 2_000).toISOString(), true);
  const r = await scoreLiveCandidates(["EURUSD"], 10);
  assert.equal(r.reason, "SCANNER_OK");
  assert.equal(r.source, "mt5_broker");
  assert.notEqual(r.source, "twelve_data");
  assert.equal(r.gateProvider, "twelve_data");
  assert.doesNotMatch(r.reasonDetail, /provider 'twelve_data'/);
  assert.ok(r.candidates.length > 0);
  for (const c of r.candidates) {
    assert.equal(c.dataSource, "mt5_broker");
    assert.equal(c.entryBasis, "router_quote");
    assert.equal(c.quoteSource, "mt5_broker");
    assert.ok(c.entryObservedAt);
    assert.equal(c.entryStale, false);
    assert.ok(c.lastCandleAt);
  }
});

test("a quote past the budget marks the entry stale / last-known", async () => {
  candleProvider = "deriv";
  quoteResult = quote("deriv", new Date(NOW - QUOTE_STALE_AFTER_MS - 60_000).toISOString(), true);
  const r = await scoreLiveCandidates(["EURUSD"], 10);
  assert.equal(r.source, "deriv");
  for (const c of r.candidates) {
    assert.equal(c.entryStale, true);
    assert.match(String(c.entryNote), /last-known price, not a current one/);
  }
});

test("a receive-time quote stamp cannot confirm a fresh entry", async () => {
  candleProvider = "mt5_broker";
  quoteResult = quote("assistant_real", new Date(NOW - 1_000).toISOString(), false);
  const r = await scoreLiveCandidates(["EURUSD"], 10);
  for (const c of r.candidates) {
    assert.equal(c.quoteSource, "assistant_real");
    assert.match(String(c.entryNote), /market tick may be older/);
    assert.match(String(c.entryNote), /not confirmed as current/);
  }
});

test("no quote: entry is labelled a candle close, never a live quote", async () => {
  candleProvider = "mt5_broker";
  quoteResult = null;
  const r = await scoreLiveCandidates(["EURUSD"], 10);
  for (const c of r.candidates) {
    assert.equal(c.entryBasis, "last_candle_close");
    assert.equal(c.quoteSource, null);
    assert.match(String(c.entryNote), /No quote — entry is the last (M15|H1) candle close/);
  }
});

// The scan is gated on the ASSISTANT market-data adapter, while candles come
// from the router (mt5_broker / deriv). When that adapter is off the scan
// still fails closed (no candidates — unchanged), but the result must say the
// adapter gate stopped it, not that no market data provider is connected:
// the router's feed was never asked.
test("adapter not connected: fails closed, says the adapter gate stopped the scan, not that no provider is connected", async () => {
  adapter = { name: "none", connected: false, features: { quotes: false, candles: false, news: false } };
  try {
    const r = await scoreLiveCandidates(["EURUSD"], 10);
    assert.equal(r.connected, false);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.reason, "PROVIDER_NOT_CONFIGURED");
    assert.equal(r.gateProvider, "none");
    assert.equal(r.source, "none", "no candles were served, so no feed is named as their source");
    assert.doesNotMatch(r.reasonDetail, /No market data provider is connected/i);
    assert.match(r.reasonDetail, /assistant's market-data adapter/i);
    assert.match(r.reasonDetail, /not checked/i);
    for (const w of r.warnings) assert.doesNotMatch(w, /No market data provider is connected/i);
  } finally {
    adapter = CONNECTED_ADAPTER;
  }
});

test("adapter without candle support: says the adapter gate stopped the scan, not that real candles are unavailable", async () => {
  adapter = { name: "newsapi", connected: true, features: { quotes: false, candles: false, news: true } };
  try {
    const r = await scoreLiveCandidates(["EURUSD"], 10);
    assert.equal(r.connected, false);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.reason, "PROVIDER_UNAVAILABLE");
    assert.equal(r.gateProvider, "newsapi");
    assert.equal(r.source, "none");
    assert.doesNotMatch(r.reasonDetail, /cannot rank candidates without real candles/i);
    assert.match(r.reasonDetail, /not checked/i);
  } finally {
    adapter = CONNECTED_ADAPTER;
  }
});

test("router served no candles: the failure is the router's, never pinned on the assistant adapter", async () => {
  candlesOk = false;
  try {
    let r = await scoreLiveCandidates(["EURUSD"], 10);
    assert.equal(r.reason, "CANDLES_UNAVAILABLE");
    assert.doesNotMatch(r.reasonDetail, /Provider 'twelve_data' is connected but returned no usable candle/);
    assert.match(r.reasonDetail, /market-data router/);
    adapterStatus = { stale: true, staleAfterMs: 300_000, lastError: null };
    r = await scoreLiveCandidates(["EURUSD"], 10);
    assert.equal(r.reason, "MARKET_DATA_STALE");
    assert.doesNotMatch(r.reasonDetail, /Provider 'twelve_data' is connected but market data is stale/);
    assert.match(r.reasonDetail, /market-data router/);
  } finally {
    candlesOk = true;
    adapterStatus = { stale: false, staleAfterMs: 300_000, lastError: null };
  }
});
