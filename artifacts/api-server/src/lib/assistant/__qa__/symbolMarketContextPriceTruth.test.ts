// Truth regression: getSymbolMarketContext's currentPrice/bid/ask must say where
// they came from and as of when. context.source is the chart feed, but the
// price comes from the market-data adapter's quote or a candle close — the
// model must not attribute it to the chart feed or call an old price current.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.now();
let nextCtx: Record<string, unknown> = {};

const realProvider = await import("../marketProvider.js");
mock.module("../marketProvider.js", {
  namedExports: {
    ...realProvider,
    getMarketProvider: () => ({ ...realProvider.getMarketProvider(), name: "twelve_data" }),
  },
});
mock.module("../../marketContext/contextBuilder.js", {
  namedExports: { buildMarketContext: async () => nextCtx },
});
mock.module("../../marketContext/classifier.js", {
  namedExports: {
    classify: () => ({ label: "Data insufficient", primaryTimeframe: "H1", htfTimeframe: "H4", scores: {}, explanation: "", evidence: [] }),
  },
});

const { getSymbolMarketContextTool } = await import("../tools.js");
const { QUOTE_STALE_AFTER_MS } = await import("../../data/freshness.js");

function tf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { available: false, source: "twelve_data", asOf: null, lastClose: null, ...over };
}
function ctx(over: Record<string, unknown>): Record<string, unknown> {
  return {
    symbol: "EURUSD",
    source: "mt5_broker", // chart-feed overlay — NOT the price's source
    asOf: null,
    currentPrice: null, bid: null, ask: null, spread: null,
    freshness: "REALTIME",
    session: "London",
    timeframes: { M1: tf(), M5: tf(), M15: tf(), H1: tf(), H4: tf(), D1: tf() },
    dataQuality: { hasQuote: false, hasAnyCandles: false, timeframesAvailable: [], timeframesMissing: [], missing: [], quality: "insufficient" },
    sharedFeed: { aiUsable: true, freshness: "REALTIME", quality: "clean", cause: null },
    ...over,
  };
}

type Evidence = { basis: string; source: string | null; observedAt: string | null; stale: boolean; freshness: string; note: string };
async function evidence(): Promise<Evidence> {
  const r = (await getSymbolMarketContextTool("EURUSD")) as { ok: boolean; context: { priceEvidence?: Evidence } };
  assert.equal(r.ok, true);
  assert.ok(r.context.priceEvidence, "context.priceEvidence must be present");
  return r.context.priceEvidence!;
}

test("quote-sourced price names the adapter, not the chart feed, with its observation time", async () => {
  nextCtx = ctx({
    currentPrice: 1.1, bid: 1.0999, ask: 1.1001,
    asOf: new Date(NOW - 3_000).toISOString(),
    dataQuality: { hasQuote: true, hasAnyCandles: true, timeframesAvailable: [], timeframesMissing: [], missing: [], quality: "good" },
  });
  const e = await evidence();
  assert.equal(e.basis, "provider_quote");
  assert.equal(e.source, "twelve_data");
  assert.notEqual(e.source, "mt5_broker");
  assert.ok(e.observedAt);
  assert.equal(e.stale, false);
});

test("quote past the budget reads stale / last-known", async () => {
  nextCtx = ctx({
    currentPrice: 1.1, bid: 1.0999, ask: 1.1001,
    asOf: new Date(NOW - QUOTE_STALE_AFTER_MS - 120_000).toISOString(),
    dataQuality: { hasQuote: true, hasAnyCandles: true, timeframesAvailable: [], timeframesMissing: [], missing: [], quality: "good" },
  });
  const e = await evidence();
  assert.equal(e.stale, true);
  assert.equal(e.freshness, "stale");
  assert.match(e.note, /last-known price, not a current one/);
});

test("no quote: price is labelled a candle close, not a bid/ask", async () => {
  nextCtx = ctx({
    currentPrice: 1.2,
    asOf: new Date(NOW - 30_000).toISOString(),
    timeframes: { M1: tf(), M5: tf({ available: true, source: "finnhub", asOf: new Date(NOW - 30_000).toISOString(), lastClose: 1.2 }), M15: tf(), H1: tf(), H4: tf(), D1: tf() },
  });
  const e = await evidence();
  assert.equal(e.basis, "candle_close");
  assert.equal(e.source, "finnhub");
  assert.match(e.note, /last M5 close, not a bid\/ask/);
});

test("no price at all: unavailable and stale", async () => {
  nextCtx = ctx({});
  const e = await evidence();
  assert.equal(e.basis, "none");
  assert.equal(e.stale, true);
  assert.equal(e.freshness, "unavailable");
});

test("undated quote is never current", async () => {
  nextCtx = ctx({
    currentPrice: 1.1, asOf: null,
    dataQuality: { hasQuote: true, hasAnyCandles: false, timeframesAvailable: [], timeframesMissing: [], missing: [], quality: "insufficient" },
  });
  const e = await evidence();
  assert.equal(e.observedAt, null);
  assert.equal(e.stale, true);
  assert.equal(e.freshness, "unknown");
});
