// Capability #4 — Conformal Decision Bounds test suite.
//
// Proves, offline and deterministically:
//   1. The finite-sample quantile is exactly the split-conformal rank
//      statistic (hand-computed fixture).
//   2. COVERAGE: on a synthetic known-distribution series, an interval
//      calibrated on the EARLIER chronological window empirically covers the
//      LATER window at the declared rate within tolerance (seeded PRNG — the
//      run is reproducible, not flaky).
//   3. MONOTONICITY: a higher declared coverage never yields a narrower
//      interval.
//   4. Admissibility abstains: a required outcome is admissible ONLY when the
//      calibrated interval/set excludes every violating outcome; too little
//      calibration data is ALWAYS inadmissible (unbounded interval).
//   5. Advisory wiring: attaching the REAL conformalGate verdict to a
//      confidence-gate result changes NO verdict field — the advisory rides
//      as evidence, never as authority. (This also pins the structural
//      compatibility of the domain mirror type with the real verdict.)
//
// Run: pnpm --filter @workspace/scripts run test:conformal-bounds

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calibrateConformal,
  calibrateConformalSets,
  conformalGate,
  conformalInterval,
  conformalOutcomeSet,
  splitChronological,
  validateCoverage,
  type LabeledPrediction,
} from "@workspace/validation";
import {
  attachConformalAdvisory,
  type ConfidenceGateResult,
} from "@workspace/domain/confidence-gate";

// ── Deterministic PRNG (mulberry32) — reproducible, never Math.random ───────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticSeries(n: number, seed: number, noiseHalfWidth: number): LabeledPrediction[] {
  const rnd = mulberry32(seed);
  const out: LabeledPrediction[] = [];
  for (let i = 0; i < n; i++) {
    const predicted = 100 + 10 * rnd();
    const noise = (rnd() * 2 - 1) * noiseHalfWidth; // Uniform(-w, +w)
    out.push({ predicted, actual: predicted + noise });
  }
  return out;
}

// ── 1. Finite-sample quantile, hand-computed ────────────────────────────────

test("quantile is the ceil((n+1)·coverage)-th smallest nonconformity score", () => {
  // Residuals are exactly 1..9 (n=9). coverage 0.9 → rank ceil(10·0.9)=9 →
  // quantile = 9th smallest = 9.
  const calib: LabeledPrediction[] = Array.from({ length: 9 }, (_, i) => ({
    predicted: 0,
    actual: i + 1,
  }));
  const cal = calibrateConformal(calib, { coverage: 0.9 });
  assert.equal(cal.quantile, 9);
  const iv = conformalInterval(cal, 50);
  assert.deepEqual({ lower: iv.lower, upper: iv.upper, unbounded: iv.unbounded },
    { lower: 41, upper: 59, unbounded: false });

  // coverage 0.5 → rank ceil(10·0.5)=5 → quantile = 5.
  assert.equal(calibrateConformal(calib, { coverage: 0.5 }).quantile, 5);
});

test("too small a calibration window yields an UNBOUNDED interval, never a number", () => {
  const calib = syntheticSeries(3, 1, 1); // n=3, coverage 0.9 → rank 4 > 3
  const cal = calibrateConformal(calib, { coverage: 0.9 });
  assert.equal(cal.quantile, Number.POSITIVE_INFINITY);
  const iv = conformalInterval(cal, 100);
  assert.equal(iv.unbounded, true);

  // ...and is therefore never admissible for any requirement.
  const verdict = conformalGate(
    { kind: "numeric", calibration: cal, predicted: 100 },
    { kind: "threshold", direction: "gte", value: -1e9 },
  );
  assert.equal(verdict.admissible, false);
  assert.match(verdict.reason, /cannot support coverage/);
});

// ── 2. Empirical coverage on a later chronological window ───────────────────

test("declared 90% coverage holds empirically on the LATER window (synthetic uniform noise)", () => {
  const series = syntheticSeries(1000, 42, 2);
  const { calibration, validation } = splitChronological(series, 0.5);
  const cal = calibrateConformal(calibration, { coverage: 0.9 });
  const check = validateCoverage(cal, validation, 0.05);
  assert.equal(check.pass, true, check.reason);
  assert.ok(check.empiricalCoverage !== null);
  assert.ok(check.empiricalCoverage! >= 0.85 && check.empiricalCoverage! <= 0.95,
    `empirical coverage ${check.empiricalCoverage} outside [0.85, 0.95]`);
});

test("an empty validation window FAILS the coverage check with a reason", () => {
  const cal = calibrateConformal(syntheticSeries(100, 7, 1), { coverage: 0.9 });
  const check = validateCoverage(cal, [], 0.05);
  assert.equal(check.pass, false);
  assert.equal(check.empiricalCoverage, null);
  assert.match(check.reason, /empty/);
});

// ── 3. Monotonicity: higher coverage → never narrower ───────────────────────

test("monotonicity: quantile (interval half-width) is nondecreasing in coverage", () => {
  for (const seed of [3, 11, 99]) {
    const calib = syntheticSeries(200, seed, 3);
    const coverages = [0.5, 0.8, 0.9, 0.95];
    let prev = -Infinity;
    for (const coverage of coverages) {
      const q = calibrateConformal(calib, { coverage }).quantile;
      assert.ok(q >= prev, `seed ${seed}: quantile at coverage ${coverage} (${q}) < previous (${prev})`);
      prev = q;
    }
  }
});

// ── 4. Admissibility abstains unless violators are excluded ─────────────────

test("numeric admissibility: true only when the ENTIRE interval satisfies the requirement", () => {
  const calib: LabeledPrediction[] = Array.from({ length: 19 }, (_, i) => ({
    predicted: 0, actual: (i + 1) / 10, // residuals 0.1..1.9 → q(0.9)=1.8
  }));
  const cal = calibrateConformal(calib, { coverage: 0.9 });
  assert.equal(cal.quantile, 1.8);

  // Interval [8.2, 11.8]. Required ≥ 8 → whole interval satisfies → admissible.
  const ok = conformalGate(
    { kind: "numeric", calibration: cal, predicted: 10 },
    { kind: "threshold", direction: "gte", value: 8 },
  );
  assert.equal(ok.admissible, true);
  assert.equal(ok.advisoryOnly, true);

  // Required ≥ 9 → outcomes in [8.2, 9) cannot be excluded → abstain.
  const abstain = conformalGate(
    { kind: "numeric", calibration: cal, predicted: 10 },
    { kind: "threshold", direction: "gte", value: 9 },
  );
  assert.equal(abstain.admissible, false);
  assert.match(abstain.reason, /cannot be excluded/);
});

test("categorical admissibility: only a SINGLETON set naming the required outcome is admissible", () => {
  // Model is right but only moderately confident: score for the actual label
  // is 0.6 → every nonconformity is 0.4 → quantile 0.4. Labels with score
  // ≥ 0.6 stay in the set; labels below get excluded.
  const calib = Array.from({ length: 19 }, () => ({
    probs: { WIN: 0.6, LOSS: 0.4 },
    actual: "WIN",
  }));
  const cal = calibrateConformalSets(calib, { coverage: 0.9 });
  assert.equal(cal.quantile, 0.4);

  // Confident prediction → set {WIN} → admissible for WIN.
  const confident = { WIN: 0.95, LOSS: 0.05 };
  assert.deepEqual(conformalOutcomeSet(cal, confident), ["WIN"]);
  assert.equal(conformalGate(
    { kind: "categorical", calibration: cal, probs: confident },
    { kind: "label", label: "WIN" },
  ).admissible, true);

  // Uncertain prediction → both labels stay in the set → abstain.
  const uncertain = { WIN: 0.7, LOSS: 0.65 };
  const set = conformalOutcomeSet(cal, uncertain);
  assert.ok(set.includes("WIN") && set.includes("LOSS"));
  const verdict = conformalGate(
    { kind: "categorical", calibration: cal, probs: uncertain },
    { kind: "label", label: "WIN" },
  );
  assert.equal(verdict.admissible, false);
  assert.match(verdict.reason, /rival outcomes cannot be excluded/);
});

// ── 5. Advisory wiring on the confidence gate ───────────────────────────────

function fixtureGateResult(): ConfidenceGateResult {
  return {
    approved: true,
    finalScore: 96,
    requiredScore: 95,
    blockers: [],
    warnings: ["fixture warning"],
    scoreBreakdown: {
      strategyEdge: 96, marketRegime: 96, multiTimeframe: 96,
      executionQuality: 96, riskApproval: 96, traderBehavior: 96, liveValidation: 96,
    },
    recommendation: "ENTER",
    reports: [],
    signalId: "sig-1",
    decidedAt: "2026-08-29T00:00:00.000Z",
    totalDurationMs: 1,
  };
}

test("attachConformalAdvisory carries the REAL conformalGate verdict without touching the verdict", () => {
  const cal = calibrateConformal(syntheticSeries(100, 5, 1), { coverage: 0.9 });
  // The REAL lib/validation verdict — including an INADMISSIBLE one — flows
  // into the domain mirror type (structural compatibility is the compile-time
  // half of this assertion).
  const verdict = conformalGate(
    { kind: "numeric", calibration: cal, predicted: 0 },
    { kind: "threshold", direction: "gte", value: 1e9 }, // impossible → inadmissible
  );
  assert.equal(verdict.admissible, false);

  const original = fixtureGateResult();
  const before = structuredClone(original);
  const withAdvisory = attachConformalAdvisory(original, verdict);

  // The input object is NOT mutated.
  assert.deepEqual(original, before);
  // Every verdict field is untouched — an inadmissible advisory does NOT
  // block an approved result (advisory evidence, not a gate key).
  const { advisory, ...rest } = withAdvisory;
  assert.deepEqual(rest, before);
  // ...and the advisory rides along verbatim for journal/display.
  assert.deepEqual(advisory?.conformal, verdict);
  assert.equal(advisory?.conformal?.advisoryOnly, true);
});
