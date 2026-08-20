// QA — R4 slice 4 prep: decision-grade WAIT routing
// (docs/prodready-20260819/audit-reports/audit-marketdata.md §3.3, §5 rule 6;
//  replit-command-arx-R4-marketdata-provenance.md slice 4).
//
// Locks the contracts:
//   1. `routeCandlesForDecision` uses ONLY the execution-broker chain. When the
//      execution broker's feed is absent/stale/missing it returns
//      { ok:false, verdict:"WAIT", reason } — it NEVER attempts
//      assistant_real/twelvedata, and never attempts deriv unless the caller
//      names the Deriv connection as the executing venue for a synthetic.
//   2. Display paths are untouched: `routeCandles` still walks the full
//      labeled fallback chain for the same symbol.
//   3. A served decision read carries the wave-2 provenance envelope with the
//      serving bridge identity (slice 2), and a bridge-pinned miss is labeled
//      MT5_BRIDGE_SERIES_MISSING — not mislabeled as a missing timeframe.
//   4. Venue parameterization: intendedVenue "deriv" is refused outright for
//      non-synthetics (DERIV_EXECUTION_VENUE_REQUIRES_SYNTHETIC) and WAITs
//      honestly when the Deriv feed is not configured.
//
// Offline by construction (established pattern — see
// src/lib/live/__qa__/emergencyKillSwitchPreGate.test.ts): dummy unroutable
// DATABASE_URL satisfies @workspace/db init; the durable-mirror read fails
// fast and is caught (honest fall-through); third-party/Deriv env keys are
// cleared BEFORE module load so no attempt can reach a network.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/__qa__/decisionGradeWait.test.ts
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
const { updateCandlesFromMT5, __resetMt5ProviderStore } =
  await import("../providers/mt5Provider.js");
const {
  routeCandles,
  routeCandlesForDecision,
  DECISION_VENUE_MISMATCH_REASON,
} = await import("../marketDataRouter.js");

function bars(n: number, startMs: number = Date.UTC(2026, 5, 9, 12, 0, 0)): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(startMs + i * 60_000).toISOString();
    out.push({ time: t, open: 1 + i * 0.001, high: 1.002 + i * 0.001, low: 0.999 + i * 0.001, close: 1.001 + i * 0.001, volume: 100 + i });
  }
  return out;
}

test("SERVE: fresh execution-broker feed serves with verdict SERVE + bridge-attributed provenance", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(50), "M1", { bridgeConnectionId: 3, userId: 30 });
  const r = await routeCandlesForDecision("EURUSD", "M1", { limit: 50, bridgeConnectionId: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "SERVE");
  assert.equal(r.reason, null);
  assert.equal(r.intendedVenue, "mt5");
  assert.equal(r.primaryProvider, "mt5_broker");
  assert.equal(r.candles.length, 50);
  assert.equal(r.provenance?.bridgeConnectionId, 3);
  assert.equal(r.provenance?.userId, 30);
  // The execution-broker slot is the whole chain — exactly one attempt.
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0]?.provider, "mt5_broker");
});

test("WAIT, never borrow: absent broker feed refuses without touching fallback providers", async () => {
  __resetMt5ProviderStore();
  const d = await routeCandlesForDecision("GBPUSD", "M1", { limit: 50 });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, "WAIT");
  assert.ok(d.reason, "a WAIT must name its reason");
  assert.deepEqual(d.candles, []);
  assert.equal(d.primaryProvider, null);
  assert.equal("provenance" in d, false, "an empty result must not fabricate an origin");
  assert.equal(d.attempts.length, 1, "ONLY the execution broker may be attempted");
  assert.equal(d.attempts[0]?.provider, "mt5_broker");
  for (const a of d.attempts) {
    assert.ok(!a.provider.startsWith("assistant_real"), "assistant_real must never be attempted on a decision read");
    assert.notEqual(a.provider, "deriv", "deriv must not be attempted for an mt5 execution venue");
  }

  // DISPLAY CONTRAST (untouched): the same symbol on the display router still
  // walks the full labeled fallback chain.
  const disp = await routeCandles("GBPUSD", "M1", 50);
  assert.equal(disp.ok, false);
  assert.equal(disp.attempts.length, 2, "display chain still tries the fallback provider");
  assert.ok(disp.attempts[1]?.provider.startsWith("assistant_real"));
});

test("synthetic + mt5 execution venue: deriv is NOT in the decision chain (display keeps it)", async () => {
  __resetMt5ProviderStore();
  const d = await routeCandlesForDecision("V75", "M1", { limit: 50 });
  assert.equal(d.verdict, "WAIT");
  assert.equal(d.intendedVenue, "mt5");
  assert.equal(d.attempts.length, 1);
  assert.equal(d.attempts[0]?.provider, "mt5_broker");

  const disp = await routeCandles("V75", "M1", 50);
  assert.equal(disp.ok, false);
  assert.equal(disp.attempts.length, 2);
  assert.equal(disp.attempts[1]?.provider, "deriv", "display chain still falls through to deriv");
});

test("bridge-pinned decision read that misses is labeled MT5_BRIDGE_SERIES_MISSING", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(50), "M1", { bridgeConnectionId: 3 });
  const d = await routeCandlesForDecision("EURUSD", "M1", { limit: 50, bridgeConnectionId: 99 });
  assert.equal(d.verdict, "WAIT");
  assert.equal(
    d.reason,
    "MT5_BRIDGE_SERIES_MISSING",
    "a wrong-bridge miss must not be mislabeled as a missing timeframe/symbol",
  );
  assert.equal(d.attempts.length, 1);
});

test("missing timeframe on the execution broker WAITs precisely (no fallback)", async () => {
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars(50), "M5", { bridgeConnectionId: 3 });
  const d = await routeCandlesForDecision("EURUSD", "H1", { limit: 50 });
  assert.equal(d.verdict, "WAIT");
  assert.equal(d.reason, "MT5_TIMEFRAME_MISSING");
  assert.equal(d.attempts.length, 1);
});

test("intendedVenue deriv is refused for a non-synthetic symbol", async () => {
  __resetMt5ProviderStore();
  const d = await routeCandlesForDecision("EURUSD", "M1", { intendedVenue: "deriv" });
  assert.equal(d.verdict, "WAIT");
  assert.equal(d.reason, DECISION_VENUE_MISMATCH_REASON);
  assert.deepEqual(d.attempts, [], "no provider may even be attempted on a venue/symbol mismatch");
});

test("intendedVenue deriv for a synthetic WAITs honestly when the Deriv feed is unconfigured", async () => {
  __resetMt5ProviderStore();
  const d = await routeCandlesForDecision("V75", "M1", { intendedVenue: "deriv" });
  assert.equal(d.verdict, "WAIT");
  assert.equal(d.reason, "DERIV_NOT_CONFIGURED");
  assert.equal(d.intendedVenue, "deriv");
  assert.equal(d.attempts.length, 1);
  assert.equal(d.attempts[0]?.provider, "deriv");
  assert.ok(!d.attempts.some((a) => a.provider === "mt5_broker"), "deriv-venue decisions do not ride the mt5 slot");
});
