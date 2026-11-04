// An MT5 quote is LIVE_TICK only while its push is within MT5_FEED_FRESH_MS.
// The store keeps serving it up to CANDLE_TTL_MS (a real last quote), but an
// older push is labelled STALE with delayed unknown, never LIVE_TICK /
// delayed:false (2026-11-04 feed sweep).
// Run: DATABASE_URL=postgres://nobody@127.0.0.1:1/none node --import tsx --test \
//        src/lib/data/__qa__/mt5QuoteAgeProvenance.test.ts
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";
delete process.env.TWELVEDATA_API_KEY;

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { routeQuote } from "../marketDataRouter.js";
import { __resetMt5ProviderStore, updateCandlesFromMT5, updateQuoteFromMT5 } from "../providers/mt5Provider.js";
import { MT5_FEED_FRESH_MS } from "../freshness.js";

const BRIDGE = { bridgeConnectionId: 11, userId: 1 };

function withNow<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => ms;
  return fn().finally(() => { Date.now = real; });
}

function quote(atMs: number) {
  updateQuoteFromMT5("EURUSD", { symbol: "EURUSD", bid: 1.1, ask: 1.1002, spread: 0.0002, timestamp: new Date(atMs).toISOString() },
    BRIDGE, { tickTimeObserved: true, brokerClockOffsetMs: 0 });
}

beforeEach(() => __resetMt5ProviderStore());

test("a fresh MT5 quote push is a live tick", async () => {
  const t0 = Date.now();
  await withNow(t0, async () => quote(t0));
  const r = await withNow(t0 + 1_000, () => routeQuote("EURUSD"));
  assert.equal(r.primaryProvider, "mt5_broker");
  assert.equal(r.provenance?.source, "LIVE_TICK");
  assert.equal(r.provenance?.delayed, false);
});

test("an MT5 quote pushed longer ago than MT5_FEED_FRESH_MS is served but labelled STALE", async () => {
  const t0 = Date.now();
  await withNow(t0, async () => quote(t0));
  const later = t0 + MT5_FEED_FRESH_MS + 30_000;
  // Another push keeps the bridge connected; the EURUSD quote itself is old.
  await withNow(later, async () => updateCandlesFromMT5("GBPUSD", [{ time: new Date(later - 300_000).toISOString(), open: 1.3, high: 1.31, low: 1.29, close: 1.3, volume: 1 }], "M5", BRIDGE));
  const r = await withNow(later, () => routeQuote("EURUSD"));
  assert.equal(r.primaryProvider, "mt5_broker", "an old quote is not dropped");
  assert.equal(r.provenance?.source, "STALE");
  assert.equal(r.provenance?.delayed, null, "never delayed:false");
});
