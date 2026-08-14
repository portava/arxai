// AACI Learning, Trust & Drift (Task #232, Phase 6) — PURE unit tests.
// Run via:
//   node --import tsx --test --test-force-exit src/lib/aaci/__qa__/learning.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:aaci-learning`)
//
// Verifies the honesty + safety contracts of the adaptive-learning math:
//   1. Neutral prior is 0.50 trust mean (50/100).
//   2. Luck filter: a profitable result from a poor decision (BAD_DECISION_WIN)
//      is NEVER rewarded; a null P/L stays NEUTRAL (no fabricated evidence).
//   3. Safety penalty λ > learning rate η — a safety event lowers a weight more
//      than any single reward can raise it; weights stay clamped to [MIN, MAX].
//   4. Minimum-evidence rule blocks an auto-change below threshold (recommend-
//      only); major (expanding) changes are ALWAYS recommend-only.
//   5. Quarantine excludes an unreliable module — effective trust collapses to
//      the neutral prior and is flagged excluded.
//   6. Drift detection produces bounded, caution-only recommendations and fails
//      open (neutral score, no drift call) below the minimum recent sample.
//
// Pure & deterministic. No DB, no IO.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AACI_LEARNING_RATE_ETA,
  AACI_SAFETY_PENALTY_LAMBDA,
  AACI_WEIGHT_MAX,
  AACI_WEIGHT_MIN,
  AACI_MIN_EVIDENCE,
  AACI_TRUST_NEUTRAL_MEAN,
  neutralTrust,
  trustMean,
  trustScore0to100,
  evidenceCount,
  classifyDecisionOutcome,
  luckFilteredUpdate,
  learnFromOutcome,
  evaluateQuarantine,
  effectiveLearnedTrust,
  meetsMinimumEvidence,
  classifyChangePermission,
  computeWeightUpdate,
  detectDrift,
  regimeReset,
  type TrustState,
} from "@workspace/domain/aaci";

// ── 1. Neutral prior ─────────────────────────────────────────────────────────

test("neutral prior is 0.50 trust mean (50/100)", () => {
  const s = neutralTrust();
  assert.equal(trustMean(s), AACI_TRUST_NEUTRAL_MEAN);
  assert.equal(trustMean(s), 0.5);
  assert.equal(trustScore0to100(s), 50);
  assert.equal(evidenceCount(s), 0);
});

// ── 2. Luck filter ───────────────────────────────────────────────────────────

test("luck filter: a lucky win (bad decision, profitable) is never rewarded", () => {
  const cls = classifyDecisionOutcome({ decisionQuality: 20, realizedPnl: 100 });
  assert.equal(cls, "BAD_DECISION_WIN");
  const u = luckFilteredUpdate(cls);
  assert.equal(u.reward, 0, "lucky win must add zero reward");
  assert.equal(u.rewarded, false);
  assert.ok(u.penalty > 0, "poor process still earns a small penalty");
});

test("luck filter: a good decision win is the only path that rewards", () => {
  const cls = classifyDecisionOutcome({ decisionQuality: 85, realizedPnl: 100 });
  assert.equal(cls, "GOOD_DECISION_WIN");
  const u = luckFilteredUpdate(cls);
  assert.equal(u.reward, AACI_LEARNING_RATE_ETA);
  assert.equal(u.rewarded, true);
  assert.equal(u.penalty, 0);
});

test("null P/L is NEUTRAL — never fabricated from elapsed time", () => {
  assert.equal(classifyDecisionOutcome({ decisionQuality: 85, realizedPnl: null }), "NEUTRAL");
  const u = luckFilteredUpdate("NEUTRAL");
  assert.equal(u.reward, 0);
  assert.equal(u.penalty, 0);
});

test("a lucky win does not raise trust above neutral", () => {
  const { next } = learnFromOutcome(neutralTrust(), {
    decisionQuality: 20,
    realizedPnl: 100,
  });
  assert.ok(trustMean(next) <= AACI_TRUST_NEUTRAL_MEAN, "lucky win must not lift trust");
});

// ── 3. λ > η and clamping ────────────────────────────────────────────────────

test("safety penalty λ exceeds learning rate η", () => {
  assert.ok(
    AACI_SAFETY_PENALTY_LAMBDA > AACI_LEARNING_RATE_ETA,
    "λ must be strictly greater than η",
  );
});

test("a safety violation lowers a weight more than a single reward raises it", () => {
  const base = 1.0;
  const afterReward = computeWeightUpdate({ currentWeight: base, reward: 1 });
  const afterSafety = computeWeightUpdate({ currentWeight: base, penalty: 1, safetyViolation: true });
  const up = afterReward - base;
  const down = base - afterSafety;
  assert.ok(up > 0 && down > 0);
  assert.ok(down > up, "a safety penalty must dominate a reward");
});

test("weight updates stay clamped to [MIN, MAX]", () => {
  const hi = computeWeightUpdate({ currentWeight: AACI_WEIGHT_MAX, reward: 1000 });
  const lo = computeWeightUpdate({ currentWeight: AACI_WEIGHT_MIN, penalty: 1000, safetyViolation: true });
  assert.ok(hi <= AACI_WEIGHT_MAX);
  assert.ok(lo >= AACI_WEIGHT_MIN);
});

// ── 4. Minimum evidence + change permission ──────────────────────────────────

test("min-evidence rule blocks an auto minor change below threshold", () => {
  assert.equal(meetsMinimumEvidence(AACI_MIN_EVIDENCE - 1), false);
  assert.equal(meetsMinimumEvidence(AACI_MIN_EVIDENCE), true);
  // A minor (tightening) change below threshold must be recommend-only.
  assert.equal(classifyChangePermission("RAISE_THRESHOLD", AACI_MIN_EVIDENCE - 1), "RECOMMEND_ONLY");
  // The same minor change clears for AUTO once evidence is sufficient.
  assert.equal(classifyChangePermission("RAISE_THRESHOLD", AACI_MIN_EVIDENCE), "AUTO");
});

test("major (expanding) changes are always recommend-only, even with evidence", () => {
  assert.equal(classifyChangePermission("RAISE_LOT", 10_000), "RECOMMEND_ONLY");
  assert.equal(classifyChangePermission("LOOSEN_LOSS_LIMIT", 10_000), "RECOMMEND_ONLY");
  assert.equal(classifyChangePermission("ADD_SYMBOL", 10_000), "RECOMMEND_ONLY");
});

// ── 5. Quarantine ────────────────────────────────────────────────────────────

test("quarantine excludes an unreliable module from learned trust", () => {
  // High-evidence, low-trust state (mostly losses) → quarantine.
  const unreliable: TrustState = { alpha: 2, beta: 40 };
  assert.ok(evidenceCount(unreliable) >= AACI_MIN_EVIDENCE);
  assert.ok(trustMean(unreliable) <= 0.35);
  const verdict = evaluateQuarantine(unreliable, false);
  assert.equal(verdict.quarantined, true);
  assert.ok(verdict.reason && verdict.reason.length > 0);

  const eff = effectiveLearnedTrust(unreliable, verdict.quarantined);
  assert.equal(eff.excluded, true);
  assert.equal(eff.score, Math.round(AACI_TRUST_NEUTRAL_MEAN * 100), "quarantined → neutral 50");
});

test("insufficient evidence never quarantines", () => {
  const thin: TrustState = { alpha: 1, beta: 4 }; // low trust but tiny sample
  assert.ok(evidenceCount(thin) < AACI_MIN_EVIDENCE);
  assert.equal(evaluateQuarantine(thin, false).quarantined, false);
});

// ── 6. Drift detection ───────────────────────────────────────────────────────

test("drift fails open below the minimum recent sample", () => {
  const r = detectDrift({ baselineWinRate: 0.6, recentWinRate: 0.1, recentSample: 3 });
  assert.equal(r.insufficientEvidence, true);
  assert.equal(r.drifted, false);
  assert.equal(r.recommendation, "NONE");
  assert.equal(r.driftScore, 70, "neutral default drift score");
});

test("drift recommendations are graduated and caution-only", () => {
  const minor = detectDrift({ baselineWinRate: 0.6, recentWinRate: 0.48, recentSample: 50 });
  assert.equal(minor.severity, "MINOR");
  assert.equal(minor.recommendation, "WATCH_MODE");
  assert.equal(minor.alertAdmin, false);

  const major = detectDrift({ baselineWinRate: 0.6, recentWinRate: 0.38, recentSample: 50 });
  assert.equal(major.severity, "MAJOR");
  assert.equal(major.recommendation, "RAISE_THRESHOLD");

  const severe = detectDrift({ baselineWinRate: 0.7, recentWinRate: 0.3, recentSample: 50 });
  assert.equal(severe.severity, "SEVERE");
  assert.equal(severe.recommendation, "REDUCE_TRUST");
  assert.equal(severe.alertAdmin, true, "severe drift alerts admin");
});

test("regime reset decays learned evidence toward the neutral prior", () => {
  const learned: TrustState = { alpha: 21, beta: 5 };
  const before = trustMean(learned);
  const reset = regimeReset(learned);
  // Evidence shrinks (relearn) and trust moves back toward 0.5.
  assert.ok(evidenceCount(reset) < evidenceCount(learned));
  assert.ok(Math.abs(trustMean(reset) - AACI_TRUST_NEUTRAL_MEAN) < Math.abs(before - AACI_TRUST_NEUTRAL_MEAN));
  // Full reset returns exactly to the prior.
  const full = regimeReset(learned, 1);
  assert.equal(trustMean(full), AACI_TRUST_NEUTRAL_MEAN);
});
