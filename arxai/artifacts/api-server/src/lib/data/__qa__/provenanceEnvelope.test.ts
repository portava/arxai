// QA — R4 slice 1: series-level provenance envelope threading
// (docs/prodready-20260819/audit-reports/audit-marketdata.md §S1; spec §10.1).
//
// Locks three contracts:
//   1. A ROUTER result that served data carries a structured `SeriesProvenance`
//      envelope naming the producing venue — the label the router already
//      computed as a string is now machine-readable. Legacy fields
//      (`primaryProvider`, attempts) are byte-identical; attempts never carry
//      the envelope.
//   2. `dataManager.getMarketDataWithProvenance` (opt-in) preserves the
//      envelope; the legacy `getMarketData` bare-array shape is UNCHANGED —
//      bars expose only {time,open,high,low,close,volume}.
//   3. Honest empty: an exhausted chain yields NO envelope (nothing served →
//      nothing to attribute; fabricating an origin is forbidden), and the
//      opt-in accessor reports `provenance: null`.
//   Alignment: the envelope's `source` reuses lib/provenance's taxonomy, so
//   lib/provenance `isTradeable` applies to it unchanged (no parallel types).
//
// Offline by construction (established pattern — see
// src/lib/live/__qa__/emergencyKillSwitchPreGate.test.ts): a dummy unroutable
// DATABASE_URL satisfies @workspace/db module init; the durable-mirror read's
// connection attempt fails fast and is caught by the router (honest
// fall-through), so NO real DB and NO network is ever reached. Third-party /
// Deriv env keys are cleared BEFORE module load so provider selection is
// deterministic (null provider, Deriv unconfigured).
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/__qa__/provenanceEnvelope.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";
delete process.env.TWELVEDATA_API_KEY;
delete process.env.POLYGON_API_KEY;
delete process.env.FINNHUB_API_KEY;
delete process.env.ALPHA_VANTAGE_API_KEY;
delete process.env.NEWSAPI_API_KEY;
delete process.env.DERIV_APP_ID;
delete process.env.DERIV_API_TOKEN;

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../types.js";

// Dynamic imports so the env setup above runs before any module init
// (static imports hoist; @workspace/db throws without DATABASE_URL).
const { updateCandlesFromMT5, updateQuoteFromMT5, __resetMt5ProviderStore } =
  await import("../providers/mt5Provider.js");
const { routeCandles, routeQuote } = await import("../marketDataRouter.js");
const { getMarketData, getMarketDataWithProvenance } = await import("../dataManager.js");
const { isTradeable } = await import("../../provenance/index.js");

const LEGACY_BAR_KEYS = ["close", "high", "low", "open", "time", "volume"];

function bars(n: number, startMs: number = Date.UTC(2026, 5, 9, 12, 0, 0)): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(startMs + i * 300_000).toISOString();
    out.push({ time: t, open: 1 + i * 0.001, high: 1.002 + i * 0.001, low: 0.999 + i * 0.001, close: 1.001 + i * 0.001, volume: 100 + i });
  }
  return out;
}

test("routeCandles: served result carries a structured envelope; legacy labels unchanged", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("eurusd", bars(10), "M5");

  const r = await routeCandles("eurusd", "5m", 50);
  assert.equal(r.ok, true);
  // Legacy string label must be byte-identical to pre-envelope behavior.
  assert.equal(r.primaryProvider, "mt5_broker");
  assert.equal(r.candles.length, 10);

  const p = r.provenance;
  assert.ok(p, "a served result must carry a provenance envelope");
  assert.equal(p.providerId, "mt5_broker");
  assert.equal(p.subProviderId, null, "live in-memory push has no sub-channel");
  assert.equal(p.brokerCode, "mt5");
  // Serving layer cannot attribute bridge/owner/broker-symbol yet (stores are
  // keyed symbol|timeframe only) — these MUST be null, never guessed.
  assert.equal(p.bridgeConnectionId, null);
  assert.equal(p.userId, null);
  assert.equal(p.brokerSymbol, null);
  assert.equal(p.environment, "unknown");
  assert.equal(p.delayed, false, "EA live push is the terminal's real-time series");
  assert.equal(p.source, "DERIVED", "candle bars are tick aggregates in the lib/provenance taxonomy");
  assert.equal(p.sourceId, "mt5_broker:EURUSD:M5");
  assert.ok(!Number.isNaN(Date.parse(p.receivedAt)), "receivedAt is a parseable ISO instant");

  // Alignment proof: lib/provenance's own predicate accepts the envelope
  // directly — the taxonomy was reused, not re-invented.
  assert.equal(isTradeable(p), true);

  // Attempts are diagnostics: they must carry neither payload nor envelope.
  assert.ok(r.attempts.length > 0);
  for (const a of r.attempts) {
    assert.equal("provenance" in a, false, "attempt must not carry an envelope");
    assert.equal("candles" in a, false, "attempt must not carry the payload");
  }
});

test("routeQuote: served quote provenance is a LIVE_TICK reading", async () => {
  __resetMt5ProviderStore();
  updateQuoteFromMT5("eurusd", { symbol: "eurusd", bid: 1.073, ask: 1.0732, timestamp: new Date().toISOString() });

  const r = await routeQuote("EURUSD");
  assert.equal(r.ok, true);
  assert.equal(r.primaryProvider, "mt5_broker");
  const p = r.provenance;
  assert.ok(p, "a served quote must carry a provenance envelope");
  assert.equal(p.providerId, "mt5_broker");
  assert.equal(p.brokerCode, "mt5");
  assert.equal(p.source, "LIVE_TICK");
  assert.equal(p.delayed, false);
  assert.equal(p.sourceId, "mt5_broker:EURUSD");
  assert.equal(isTradeable(p), true);
});

test("dataManager opt-in path preserves the envelope; bars keep the bare legacy shape", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("eurusd", bars(10), "M5");

  const withProv = await getMarketDataWithProvenance("EURUSD", "5m", 50);
  assert.equal(withProv.candles.length, 10);
  assert.ok(withProv.provenance, "opt-in path must not strip the router envelope");
  assert.equal(withProv.provenance.providerId, "mt5_broker");
  assert.equal(withProv.provenance.source, "DERIVED");
  // The envelope is series-level: each bar stays the bare wire Candle.
  for (const c of withProv.candles) {
    assert.deepEqual(Object.keys(c).sort(), LEGACY_BAR_KEYS);
  }
});

test("legacy getMarketData path is unchanged: bare validated array, no envelope anywhere", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("eurusd", bars(10), "M5");

  const legacy = await getMarketData("EURUSD", "5m", 50);
  assert.equal(Array.isArray(legacy), true);
  assert.equal(legacy.length, 10);
  for (const c of legacy) {
    assert.deepEqual(Object.keys(c).sort(), LEGACY_BAR_KEYS);
  }
});

test("exhausted chain: honest empty carries NO envelope; opt-in path reports null", async () => {
  __resetMt5ProviderStore();
  // Forex chain with mt5 empty, no third-party keys, durable-mirror read
  // failing fast against the unroutable dummy DB → every link refuses honestly.
  const r = await routeCandles("GBPUSD", "1m", 50);
  assert.equal(r.ok, false);
  assert.equal(r.candles.length, 0);
  assert.equal(r.primaryProvider, null);
  assert.equal(r.provenance, undefined, "an empty result must not fabricate an origin");

  const withProv = await getMarketDataWithProvenance("GBPUSD", "1m", 50);
  assert.deepEqual(withProv.candles, []);
  assert.equal(withProv.provenance, null);

  const legacy = await getMarketData("GBPUSD", "1m", 50);
  assert.deepEqual(legacy, []);

  const q = await routeQuote("GBPUSD");
  assert.equal(q.ok, false);
  assert.equal(q.provenance, undefined);
});
