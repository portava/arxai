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

const realProvider = await import("../marketProvider.js");
mock.module("../marketProvider.js", {
  namedExports: {
    ...realProvider,
    getMarketProvider: () => ({ name: "twelve_data", connected: true, features: { quotes: true, candles: true, news: false } }),
    getMarketStatus: () => ({ stale: false, staleAfterMs: 300_000, lastError: null }),
  },
});
const realRouter = await import("../../data/marketDataRouter.js");
mock.module("../../data/marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    routeCandles: async (symbol: string, tf: string) => ({
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
