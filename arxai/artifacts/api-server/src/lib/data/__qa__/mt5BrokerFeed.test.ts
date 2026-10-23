// QA — MT5 broker feed foundation (Task #406, Phases 1–3).
//
// These tests lock the market-data INGESTION/PROVIDER/ROUTER hardening only.
// They never touch live execution, fills, balance, equity, or the 16-gate
// pipeline — those surfaces are guarded by their own CI guards and must stay
// untouched. Scope here:
//   1. Symbol-key normalization on candle + quote write/read.
//   2. Per-series freshness + TTL serving semantics.
//   3. getMt5AllSeriesStatus separates aged-out ("stale") from
//      empty-but-fresh ("non-contributing").
//   4. Candle/quote availability introspection (the precise router reasons).
//   5. routeCandles serves the mt5_broker slot first when fresh bars exist
//      (deterministic — no network, mt5 wins before any external provider).
//
// `export {}` scopes this file as a module (avoids the scripts/__qa__ global
// duplicate-identifier collision documented in memory).
export {};

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANDLE_TTL_MS,
  normalizeSymbolKey,
  updateCandlesFromMT5,
  updateQuoteFromMT5,
  mergeCandleFromMT5,
  __resetMt5ProviderStore,
  getMt5SeriesFreshness,
  getMt5CandleAvailability,
  getMt5QuoteAvailability,
  getMt5AllSeriesStatus,
  mt5Provider,
} from "../providers/mt5Provider.js";
import { routeCandles } from "../marketDataRouter.js";
import type { Candle } from "../types.js";

function bars(n: number, startMs: number = Date.UTC(2026, 5, 9, 12, 0, 0)): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(startMs + i * 60_000).toISOString();
    out.push({ time: t, open: 1 + i * 0.001, high: 1.002 + i * 0.001, low: 0.999 + i * 0.001, close: 1.001 + i * 0.001, volume: 100 + i });
  }
  return out;
}

test("normalizeSymbolKey trims + upper-cases", () => {
  assert.equal(normalizeSymbolKey("  eurusd "), "EURUSD");
  assert.equal(normalizeSymbolKey("XauUsd"), "XAUUSD");
  assert.equal(normalizeSymbolKey(""), "");
});

test("candle store is symbol-key normalized: push lower-case, read upper-case", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("eurusd", bars(10), "M5");
  // Reading via a differently-cased symbol resolves to the same series.
  const f = getMt5SeriesFreshness("EURUSD", "M5");
  assert.equal(f.hasSeries, true);
  assert.equal(f.barCount, 10);
  assert.equal(f.fresh, true);
  // Provider read path is also normalized.
  const got = await mt5Provider.getCandles("EurUsd", "M5", 100);
  assert.equal(got.length, 10);
});

test("quote store is symbol-key normalized on write + read", async () => {
  __resetMt5ProviderStore();
  updateQuoteFromMT5("eurusd", { symbol: "eurusd", bid: 1.073, ask: 1.0732, timestamp: new Date().toISOString() });
  const q = await mt5Provider.getQuote("EURUSD");
  assert.ok(q.bid != null && q.bid > 0);
  const avail = getMt5QuoteAvailability("EurUsd");
  // ageMs is wall-clock-dependent, so assert the deterministic flags exactly and
  // ageMs structurally (non-negative number) rather than deep-equalling a value.
  assert.deepEqual(
    { hasQuote: avail.hasQuote, fresh: avail.fresh, hasPrice: avail.hasPrice },
    { hasQuote: true, fresh: true, hasPrice: true },
  );
  assert.ok(
    typeof avail.ageMs === "number" && avail.ageMs >= 0,
    `ageMs should be a non-negative number, got ${String(avail.ageMs)}`,
  );
});

test("getMt5SeriesFreshness reports stale once age exceeds CANDLE_TTL_MS", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(5), "M5");
  const future = Date.now() + CANDLE_TTL_MS + 1_000;
  const f = getMt5SeriesFreshness("EURUSD", "M5", future);
  assert.equal(f.hasSeries, true);
  assert.equal(f.fresh, false);
});

test("getMt5AllSeriesStatus separates aged-out (stale) from empty-but-fresh (non-contributing)", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(5), "M5");   // fresh + bars  → contributing
  updateCandlesFromMT5("GBPUSD", [], "M5");        // fresh + empty → non-contributing
  const now = Date.now();
  const fresh = getMt5AllSeriesStatus(now);
  const eur = fresh.find((s) => s.symbol === "EURUSD" && s.timeframe === "M5");
  const gbp = fresh.find((s) => s.symbol === "GBPUSD" && s.timeframe === "M5");
  assert.equal(eur?.status, "contributing");
  assert.equal(gbp?.status, "non-contributing");
  // Same series, evaluated far in the future → both aged out to "stale".
  const later = getMt5AllSeriesStatus(now + CANDLE_TTL_MS + 1_000);
  assert.equal(later.find((s) => s.symbol === "EURUSD")?.status, "stale");
  assert.equal(later.find((s) => s.symbol === "GBPUSD")?.status, "stale");
});

test("getMt5CandleAvailability distinguishes missing-timeframe from never-pushed-symbol", () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(5), "M5");
  // Same symbol, different timeframe not pushed → symbol has series, requested does not.
  const tfMissing = getMt5CandleAvailability("EURUSD", "H1");
  assert.equal(tfMissing.requestedHasSeries, false);
  assert.equal(tfMissing.symbolHasAnySeries, true);
  assert.equal(tfMissing.symbolHasAnyFreshSeries, true);
  // Symbol never pushed at all.
  const neverPushed = getMt5CandleAvailability("USDJPY", "M5");
  assert.equal(neverPushed.requestedHasSeries, false);
  assert.equal(neverPushed.symbolHasAnySeries, false);
});

test("getMt5QuoteAvailability: no usable price when all legs are non-positive", () => {
  __resetMt5ProviderStore();
  updateQuoteFromMT5("EURUSD", { symbol: "EURUSD", bid: 0, ask: 0, last: 0, timestamp: new Date().toISOString() });
  const avail = getMt5QuoteAvailability("EURUSD");
  assert.equal(avail.hasQuote, true);
  assert.equal(avail.hasPrice, false);
});

test("routeCandles serves mt5_broker first when a fresh series exists (no external call)", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(120), "M5");
  const r = await routeCandles("EURUSD", "M5", 100);
  assert.equal(r.ok, true);
  assert.equal(r.primaryProvider, "mt5_broker");
  assert.ok(r.candles.length > 0);
  // mt5_broker is first in the chain and won — it must be the only attempt.
  assert.equal(r.attempts[0]?.provider, "mt5_broker");
  assert.equal(r.attempts[0]?.ok, true);
});

test("isConnected reflects recent push", async () => {
  __resetMt5ProviderStore();
  assert.equal(await mt5Provider.isConnected(), false);
  updateCandlesFromMT5("EURUSD", bars(3), "M5");
  assert.equal(await mt5Provider.isConnected(), true);
});

// ── mergeCandleFromMT5 (v2 single-bar ingest) ───────────────────────────────

function bar(i: number, startMs: number = Date.UTC(2026, 5, 9, 12, 0, 0)): Candle {
  const t = new Date(startMs + i * 60_000).toISOString();
  return { time: t, open: 1 + i * 0.001, high: 1.002 + i * 0.001, low: 0.999 + i * 0.001, close: 1.001 + i * 0.001, volume: 100 + i };
}

test("mergeCandleFromMT5 appends a new bar without destroying existing history", () => {
  __resetMt5ProviderStore();
  // Seed an existing window, then merge ONE new closed bar onto it.
  updateCandlesFromMT5("EURUSD", bars(10), "M5");
  mergeCandleFromMT5("EURUSD", bar(10), "M5");
  const f = getMt5SeriesFreshness("EURUSD", "M5");
  assert.equal(f.barCount, 11);
});

test("mergeCandleFromMT5 upserts (last-write-wins) on identical bar time", () => {
  __resetMt5ProviderStore();
  mergeCandleFromMT5("EURUSD", bar(0), "M5");
  const same = { ...bar(0), close: 9.999 };
  mergeCandleFromMT5("EURUSD", same, "M5");
  const f = getMt5SeriesFreshness("EURUSD", "M5");
  assert.equal(f.barCount, 1); // not duplicated
});

test("mergeCandleFromMT5 keeps ascending time order regardless of arrival order", async () => {
  __resetMt5ProviderStore();
  // Arrive out of order: bar 2, then bar 0, then bar 1.
  mergeCandleFromMT5("EURUSD", bar(2), "M5");
  mergeCandleFromMT5("EURUSD", bar(0), "M5");
  mergeCandleFromMT5("EURUSD", bar(1), "M5");
  const got = await mt5Provider.getCandles("EURUSD", "M5", 100);
  const times = got.map((c) => c.time);
  const sorted = [...times].sort();
  assert.deepEqual(times, sorted);
});

test("mergeCandleFromMT5 caps the series to the most recent window", () => {
  __resetMt5ProviderStore();
  // Push more than the cap (1500) and confirm it bounds.
  for (let i = 0; i < 1600; i++) mergeCandleFromMT5("EURUSD", bar(i), "M5");
  const f = getMt5SeriesFreshness("EURUSD", "M5");
  assert.equal(f.barCount, 1500);
});

test("mergeCandleFromMT5 is symbol-key normalized + keyed per timeframe", () => {
  __resetMt5ProviderStore();
  mergeCandleFromMT5("eurusd", bar(0), "M5");
  mergeCandleFromMT5("EURUSD", bar(0), "H1"); // same symbol, different tf → distinct series
  assert.equal(getMt5SeriesFreshness("EURUSD", "M5").barCount, 1);
  assert.equal(getMt5SeriesFreshness("EURUSD", "H1").barCount, 1);
});

test("merged broker bars win at the router as mt5_broker", async () => {
  __resetMt5ProviderStore();
  for (let i = 0; i < 120; i++) mergeCandleFromMT5("EURUSD", bar(i), "M5");
  const r = await routeCandles("EURUSD", "M5", 100);
  assert.equal(r.ok, true);
  assert.equal(r.primaryProvider, "mt5_broker");
  assert.ok(r.candles.length > 0);
});
