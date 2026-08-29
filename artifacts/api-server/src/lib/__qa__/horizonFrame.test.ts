// Capability #10 — unified horizon representation.
//
// Locked here:
//   * ONE frame always carries ALL seven horizons (microstructure/entry/
//     position/session/regime/strategy/capital) — a missing reading appears
//     as an explicit null-state stale entry, never silently absent.
//   * Per-horizon state AGE is computed against the horizon's freshness
//     budget; unknown observation time is stale (fail-closed).
//   * Reliability is MEASURED only with a real value + sample count; anything
//     else is a typed UNMEASURED and never counts as reliable.
//   * The confidence gate consumes the frame as EVIDENCE:
//     attachHorizonAdvisory is a pure copy that changes no verdict field and
//     coexists with the conformal advisory.
//
// Run: pnpm --filter @workspace/api-server run test:horizon-frame

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARX_HORIZONS,
  HORIZON_MAX_STATE_AGE_MS,
  buildHorizonFrame,
  horizonFrameEvidence,
} from "@workspace/domain/horizons";
import {
  attachHorizonAdvisory,
  attachConformalAdvisory,
  type ConfidenceGateResult,
  type ConformalAdvisoryEvidence,
} from "@workspace/domain/confidence-gate";

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

test("the frame always contains all seven horizons; missing ones are explicit", () => {
  const frame = buildHorizonFrame({}, NOW);
  assert.deepEqual(Object.keys(frame.horizons).sort(), [...ARX_HORIZONS].sort());
  for (const h of ARX_HORIZONS) {
    const s = frame.horizons[h];
    assert.equal(s.state, null);
    assert.equal(s.ageMs, null);
    assert.equal(s.stale, true, `${h} must be fail-closed stale`);
    assert.deepEqual(s.reliability, { status: "UNMEASURED", reason: "NOT_PROVIDED" });
  }
});

test("state age is computed and judged against the per-horizon budget", () => {
  const frame = buildHorizonFrame(
    {
      entry: { state: "ARMED", observedAtMs: NOW - 30_000, source: "signal-intelligence" },
      regime: { state: "TRENDING", observedAtMs: NOW - 30_000, source: "market-state" },
      session: { state: "LONDON", observedAtMs: NOW - 2 * 60 * 60_000, source: "sessionIntelligence" },
    },
    NOW,
  );
  // entry: 30s age vs 60s budget → fresh... but its default budget is 60s.
  assert.equal(frame.horizons.entry.ageMs, 30_000);
  assert.equal(frame.horizons.entry.stale, false);
  // regime: 30s vs 6h budget → fresh.
  assert.equal(frame.horizons.regime.stale, false);
  // session: 2h old vs 1h budget → stale.
  assert.equal(frame.horizons.session.stale, true);
  assert.equal(frame.horizons.session.state, "LONDON"); // state still reported honestly
});

test("unknown observation time is stale (fail-closed), never assumed fresh", () => {
  const frame = buildHorizonFrame(
    { position: { state: "FLAT", observedAtMs: null } },
    NOW,
  );
  assert.equal(frame.horizons.position.state, "FLAT");
  assert.equal(frame.horizons.position.ageMs, null);
  assert.equal(frame.horizons.position.stale, true);
});

test("malformed reliability measurements degrade to typed UNMEASURED", () => {
  const frame = buildHorizonFrame(
    {
      strategy: {
        state: "CERTIFIED",
        observedAtMs: NOW,
        reliability: { status: "MEASURED", value01: Number.NaN, samples: 10 },
      },
      capital: {
        state: "NORMAL",
        observedAtMs: NOW,
        reliability: { status: "MEASURED", value01: 0.9, samples: 0 },
      },
    },
    NOW,
  );
  assert.deepEqual(frame.horizons.strategy.reliability, {
    status: "UNMEASURED",
    reason: "MALFORMED_MEASUREMENT",
  });
  assert.deepEqual(frame.horizons.capital.reliability, {
    status: "UNMEASURED",
    reason: "MALFORMED_MEASUREMENT",
  });
});

test("evidence summary: trusted = fresh AND measured-reliable; everything else flagged", () => {
  const frame = buildHorizonFrame(
    {
      microstructure: {
        state: "NORMAL_SPREAD",
        observedAtMs: NOW - 1_000,
        reliability: { status: "MEASURED", value01: 0.8, samples: 40 },
      },
      entry: {
        state: "ARMED",
        observedAtMs: NOW - 10_000,
        reliability: { status: "MEASURED", value01: 0.3, samples: 12 }, // measured but weak
      },
      regime: {
        state: "TRENDING",
        observedAtMs: NOW - 24 * 60 * 60_000, // stale for the 6h budget
        reliability: { status: "MEASURED", value01: 0.9, samples: 100 },
      },
    },
    NOW,
  );
  const ev = horizonFrameEvidence(frame);
  assert.deepEqual(ev.trustedHorizons, ["microstructure"]);
  assert.ok(ev.staleHorizons.includes("regime"));
  assert.ok(!ev.staleHorizons.includes("entry"));
  assert.ok(ev.unreliableHorizons.includes("entry")); // reliability below floor
  // The four never-reported horizons are all stale + unreliable.
  for (const h of ["position", "session", "strategy", "capital"] as const) {
    assert.ok(ev.staleHorizons.includes(h));
    assert.ok(ev.unreliableHorizons.includes(h));
  }
});

test("budgets exist for every horizon and order sanely (micro < entry < … < capital)", () => {
  let prev = 0;
  for (const h of ARX_HORIZONS) {
    const budget = HORIZON_MAX_STATE_AGE_MS[h];
    assert.ok(budget > prev, `${h} budget must exceed the faster horizon's`);
    prev = budget;
  }
});

// ── Consumption by the confidence gate ──────────────────────────────────────

function gateResult(): ConfidenceGateResult {
  return {
    approved: true,
    finalScore: 96,
    requiredScore: 95,
    blockers: [],
    warnings: [],
    scoreBreakdown: {
      strategyEdge: 96, marketRegime: 96, multiTimeframe: 96, executionQuality: 96,
      riskApproval: 96, traderBehavior: 96, liveValidation: 96,
    },
    recommendation: "ENTER",
    reports: [],
    signalId: "sig-1",
    decidedAt: "2026-08-29T12:00:00.000Z",
    totalDurationMs: 1,
  };
}

test("attachHorizonAdvisory is evidence-only: pure copy, verdict untouched, coexists with conformal", () => {
  const result = gateResult();
  const frame = buildHorizonFrame({}, NOW);
  const ev = horizonFrameEvidence(frame);

  const conformal: ConformalAdvisoryEvidence = {
    admissible: false, interval: null, outcomeSet: ["WIN", "LOSS"], coverage: 0.9,
    calibrationSize: 10, reason: "rivals cannot be excluded", advisoryOnly: true,
  };
  const withBoth = attachHorizonAdvisory(attachConformalAdvisory(result, conformal), ev);

  // Both advisories ride together.
  assert.equal(withBoth.advisory?.conformal?.admissible, false);
  assert.equal(withBoth.advisory?.horizons?.staleHorizons.length, 7);
  // Verdict fields byte-identical — a fully-stale frame changes NOTHING.
  assert.equal(withBoth.approved, true);
  assert.equal(withBoth.finalScore, 96);
  assert.equal(withBoth.recommendation, "ENTER");
  assert.deepEqual(withBoth.blockers, []);
  // Input untouched.
  assert.equal(result.advisory, undefined);
});
