// QA — R7 step 1c: honest fallback semantics on the decision-capable
// market-data seam (marketDataService + fallbackProvider).
//
// Locks four contracts:
//   1. `getMarketData` NEVER serves synthetic candles: with no real provider
//      configured the snapshot is honest-empty (no candles, NaN quote, a
//      reason in warnings) and carries CRITICAL blockers — so tradeDecision
//      HOLDs, paper execution rejects at fill time, and the paper monitor's
//      NaN comparisons can never "hit" a TP/SL.
//   2. The envelope keys {snapshot, blockers, usedFallback, providerError}
//      are unchanged for every consumer.
//   3. The synthetic FallbackMarketDataProvider (display-only) labels its
//      output dataQuality.status="SYNTHETIC" and no longer re-stamps the
//      quote time to "now" — the stale blocker is NOT defeated.
//   4. `computeBlockers` flags SYNTHETIC status and any non-REAL source as
//      CRITICAL, independently.
//
// Offline by construction (established pattern — emergencyKillSwitchPreGate):
// dummy DATABASE_URL; the real provider is deliberately unconfigured by
// clearing its env; nothing here reaches a network.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/marketData/__qa__/fallbackHonesty.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";
delete process.env.MARKET_DATA_PROVIDER;
delete process.env.MARKET_DATA_BASE_URL;
delete process.env.MARKET_DATA_API_KEY;

import { test } from "node:test";
import assert from "node:assert/strict";

const { getMarketData, computeBlockers, emptySnapshot } =
  await import("../marketDataService.js");
const { fallbackMarketDataProvider } = await import("../fallbackProvider.js");

test("no real provider → honest EMPTY snapshot with reason, never synthetic candles", async () => {
  const { snapshot, blockers, usedFallback, providerError } =
    await getMarketData({ symbol: "Volatility 75 Index", timeframe: "M5", limit: 100 });

  // Envelope keys unchanged.
  assert.ok(snapshot && Array.isArray(blockers));
  assert.equal(usedFallback, true);
  assert.equal(typeof providerError, "string");

  // Honest empty: no invented numbers anywhere.
  assert.equal(snapshot.candles.length, 0);
  assert.ok(Number.isNaN(snapshot.bid) && Number.isNaN(snapshot.ask) && Number.isNaN(snapshot.mid));
  assert.equal(snapshot.dataQuality.status, "MISSING");
  assert.equal(snapshot.dataQuality.candlesAvailable, 0);
  assert.ok(snapshot.dataQuality.warnings.length >= 1, "the reason must travel in warnings");

  // The quote timestamp can never read as fresh.
  assert.equal(new Date(snapshot.timestamp).getTime(), 0);

  // CRITICAL blockers force every decision-capable consumer to refuse.
  const critical = blockers.filter((b) => b.blocked && b.severity === "CRITICAL");
  assert.ok(critical.length >= 1, "expected CRITICAL blockers on the empty snapshot");
  assert.ok(blockers.some((b) => /not a real provider|MISSING/i.test(b.reason)));
});

test("NaN quote can never 'hit' a level (paper-monitor fail-safety)", async () => {
  const { snapshot } = await getMarketData({ symbol: "Volatility 75 Index", timeframe: "M5", limit: 100 });
  const price = snapshot.mid;
  // Mirrors paperExecutionMonitor.detectHit comparisons: all false on NaN.
  assert.equal(price <= 100, false);
  assert.equal(price >= 100, false);
});

test("unsupported symbol → honest empty + unsupported blocker (no synthetic bars)", async () => {
  const { snapshot, blockers } = await getMarketData({ symbol: "NOT_A_SYMBOL", timeframe: "M5", limit: 50 });
  assert.equal(snapshot.candles.length, 0);
  assert.ok(blockers.some((b) => b.blocked && /unsupported/i.test(b.reason)));
});

test("display-only synthetic provider labels SYNTHETIC and does not forge freshness", async () => {
  const snap = await fallbackMarketDataProvider.fetch({ symbol: "Volatility 75 Index", timeframe: "M5", limit: 60 });
  assert.equal(snap.source, "FALLBACK");
  assert.equal(snap.dataQuality.status, "SYNTHETIC");
  assert.ok(snap.dataQuality.warnings.some((w) => /SYNTHETIC/i.test(w)));
  // Quote timestamp equals the LAST BAR's own time — not re-stamped to now.
  assert.equal(snap.timestamp, snap.candles[snap.candles.length - 1]!.time);
  // On an M5 window that timestamp is ≥ one interval old ⇒ the stale blocker
  // (60s cap) fires naturally instead of being defeated.
  const ageMs = Date.now() - new Date(snap.timestamp).getTime();
  assert.ok(ageMs > 60_000, `expected a stale synthetic quote, got age ${ageMs}ms`);
});

test("computeBlockers flags SYNTHETIC status and non-REAL source as CRITICAL, independently", async () => {
  const snap = await fallbackMarketDataProvider.fetch({ symbol: "Volatility 75 Index", timeframe: "M5", limit: 60 });
  const blockers = computeBlockers(snap);
  assert.ok(blockers.some((b) => b.blocked && b.severity === "CRITICAL" && /SYNTHETIC/.test(b.reason)));
  assert.ok(blockers.some((b) => b.blocked && b.severity === "CRITICAL" && /not a real provider/.test(b.reason)));
  // And the un-forged timestamp trips the stale blocker too.
  assert.ok(blockers.some((b) => b.blocked && /Stale quote/.test(b.reason)));
});

test("emptySnapshot helper carries the reason verbatim", () => {
  const snap = emptySnapshot("EURUSD", "M5", "why-not-served");
  assert.deepEqual(snap.dataQuality.warnings, ["why-not-served"]);
  assert.equal(snap.candles.length, 0);
  assert.equal(snap.dataQuality.status, "MISSING");
});
