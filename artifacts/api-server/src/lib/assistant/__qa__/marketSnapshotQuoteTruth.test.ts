// Truth regression: getMarketSnapshot's provider quote (bid/ask/price the model
// restates) must carry when it was observed, on what basis, and read stale past
// the shared quote budget — a quote with no usable time is never current.
// Also locks the pure quoteObservationFreshness helper it uses.
//
// Run with --experimental-test-module-mocks (test:truth-component-evidence).
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const NOW = Date.now();
let nextQuote: Record<string, unknown> = {};

const realProvider = await import("../marketProvider.js");
mock.module("../marketProvider.js", {
  namedExports: {
    ...realProvider,
    getMarketProvider: () => ({
      name: "twelve_data",
      connected: true,
      features: { quotes: true, candles: true, news: false },
      getLiveQuote: async () => nextQuote,
    }),
  },
});

const realOverview = await import("../../data/marketOverview.js");
mock.module("../../data/marketOverview.js", {
  namedExports: {
    ...realOverview,
    getSymbolSnapshot: async (sym: string) => ({
      symbol: sym, displaySymbol: sym, assetClass: "forex",
      source: "mt5_broker", quality: "clean", aiUsable: true, isLive: true, stale: false,
      freshness: "REALTIME", lastPrice: 1.1, lastCandleTime: new Date(NOW).toISOString(),
      cause: null, message: null,
    }),
  },
});

const { getMarketSnapshot } = await import("../tools.js");
const { quoteObservationFreshness } = await import("../../data/quoteObservationFreshness.js");
const { QUOTE_STALE_AFTER_MS } = await import("../../data/freshness.js");

function q(over: Record<string, unknown>): Record<string, unknown> {
  return {
    symbol: "EURUSD", price: 1.1, bid: 1.0999, ask: 1.1001, change: null, changePct: null,
    high: null, low: null, open: null, previousClose: null,
    asOf: new Date(NOW - 2_000).toISOString(), freshness: "REALTIME", source: "twelve_data", stale: false,
    ...over,
  };
}

type SnapQuote = {
  observedAt: string | null; timeBasis: string; ageMs: number | null;
  freshness: string; stale: boolean; observationNote: string;
};
async function snapQuote(): Promise<SnapQuote> {
  const r = (await getMarketSnapshot("EURUSD")) as { quote: SnapQuote | null };
  assert.ok(r.quote, "expected the provider quote enrichment");
  return r.quote!;
}

test("fresh provider quote carries its observation time and basis", async () => {
  nextQuote = q({});
  const s = await snapQuote();
  assert.equal(s.timeBasis, "provider_as_of");
  assert.ok(s.observedAt, "observedAt must be set");
  assert.equal(s.stale, false);
  assert.equal(s.freshness, "fresh");
  assert.match(s.observationNote, /observed .* ago/);
});

test("quote older than the budget reads stale / last-known even when the vendor says REALTIME", async () => {
  nextQuote = q({ asOf: new Date(NOW - QUOTE_STALE_AFTER_MS - 60_000).toISOString() });
  const s = await snapQuote();
  assert.equal(s.stale, true);
  assert.equal(s.freshness, "stale");
  assert.match(s.observationNote, /last-known price, not a current one/);
});

test("quote with no as-of time is never current", async () => {
  nextQuote = q({ asOf: null });
  const s = await snapQuote();
  assert.equal(s.observedAt, null);
  assert.equal(s.timeBasis, "none");
  assert.equal(s.freshness, "unknown");
  assert.equal(s.stale, true);
  assert.match(s.observationNote, /unknown, so it cannot be treated as current/);
});

test("vendor-marked STALE quote stays stale even when recent", async () => {
  nextQuote = q({ freshness: "STALE", stale: true });
  const s = await snapQuote();
  assert.equal(s.stale, true);
  assert.equal(s.freshness, "stale");
  assert.match(s.observationNote, /not a current price/);
});

test("helper: no price is unavailable; a receive-time stamp cannot confirm fresh; future stamps are unknown", () => {
  const none = quoteObservationFreshness({ hasPrice: false, observedAt: new Date(NOW).toISOString(), basis: "producer_tick", nowMs: NOW });
  assert.equal(none.freshness, "unavailable");
  assert.equal(none.stale, true);
  assert.equal(none.observedAt, null);

  const recv = quoteObservationFreshness({ hasPrice: true, observedAt: NOW - 1_000, basis: "server_receive", nowMs: NOW });
  assert.equal(recv.freshness, "delayed");
  assert.equal(recv.stale, false);
  assert.match(recv.plainEnglish, /market tick may be older/);

  const tick = quoteObservationFreshness({ hasPrice: true, observedAt: NOW - 1_000, basis: "producer_tick", nowMs: NOW });
  assert.equal(tick.freshness, "fresh");

  const future = quoteObservationFreshness({ hasPrice: true, observedAt: NOW + 60_000, basis: "producer_tick", nowMs: NOW });
  assert.equal(future.freshness, "unknown");
  assert.equal(future.stale, true);
});
