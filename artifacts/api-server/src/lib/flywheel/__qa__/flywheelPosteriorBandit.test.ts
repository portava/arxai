// Flywheel B2 (NIG posteriors) + B3 (discounted Thompson, SHADOW) + B4/B5
// (edge decay → reduce-only demotion) — OFFLINE.
//
// Locks:
//   * The conjugate NIG update is exact (hand-computed fixture); the honest
//     prior presumes NO edge (mu0 = 0); non-finite rewards are dropped.
//   * INSUFFICIENT_SAMPLE below the floor; the bandit allocates 0 to
//     unmeasured cohorts (kellyCap's no-edge rule, in allocation form).
//   * Discounting only ever moves belief back TOWARD the prior.
//   * Bandit clamps: per-arm ≤ 0.25, total ≤ 1, non-promoted ⇒ 0 with the
//     gate-#20 reason, decayed ⇒ 0; the record is mode SHADOW / authority
//     NONE and deterministic per seed.
//   * decideEdgeDecay: too-short series is honest silence; a real downward
//     break decays; a non-positive posterior mean on adequate sample decays;
//     healthy cohorts do not.
//   * Pins: decayDemotion reuses @workspace/domain/change-point (no detector
//     re-implementation); the worker notifies via the injected reduce-only
//     seam and never calls promote(.
//
// Run: pnpm --filter @workspace/api-server run test:flywheel-posterior-bandit

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FLYWHEEL_MIN_COHORT_SAMPLE,
  FLYWHEEL_NIG_PRIOR,
  discountPosterior,
  mulberry32,
  nigUpdate,
  posteriorStatus,
  samplePosteriorMean,
} from "../posterior.js";
import {
  FLYWHEEL_MAX_ARM_WEIGHT,
  FLYWHEEL_MAX_TOTAL_WEIGHT,
  computeShadowAllocation,
  type BanditArm,
} from "../bandit.js";
import { FLYWHEEL_DECAY_MIN_SERIES, decideEdgeDecay } from "../decayDemotion.js";

// ── B2 — NIG math ───────────────────────────────────────────────────────────

test("B2: conjugate NIG update matches the closed form (hand-computed)", () => {
  const prior = { mu: 0, kappa: 1, alpha: 2, beta: 0.0001, n: 0 };
  const xs = [0.01, 0.03, -0.01, 0.02, 0.05];
  const post = nigUpdate(prior, xs);
  const n = 5;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const ss = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const kappaN = 1 + n;
  const muN = (1 * 0 + n * mean) / kappaN;
  const alphaN = 2 + n / 2;
  const betaN = 0.0001 + ss / 2 + (1 * n * (mean - 0) ** 2) / (2 * kappaN);
  assert.ok(Math.abs(post.mu - muN) < 1e-15);
  assert.equal(post.kappa, kappaN);
  assert.equal(post.alpha, alphaN);
  assert.ok(Math.abs(post.beta - betaN) < 1e-15);
  assert.equal(post.n, 5);
});

test("B2: the honest prior presumes NO edge and empty/non-finite input changes nothing", () => {
  assert.equal(FLYWHEEL_NIG_PRIOR.mu, 0);
  const same = nigUpdate(FLYWHEEL_NIG_PRIOR, []);
  assert.deepEqual(same, { ...FLYWHEEL_NIG_PRIOR });
  const filtered = nigUpdate(FLYWHEEL_NIG_PRIOR, [Number.NaN, Number.POSITIVE_INFINITY]);
  assert.equal(filtered.n, 0);
});

test("B2: INSUFFICIENT_SAMPLE floor is exact", () => {
  assert.equal(posteriorStatus(FLYWHEEL_MIN_COHORT_SAMPLE - 1), "INSUFFICIENT_SAMPLE");
  assert.equal(posteriorStatus(FLYWHEEL_MIN_COHORT_SAMPLE), "OK");
});

test("B2: discounting only ever moves belief back toward the prior", () => {
  const post = nigUpdate(FLYWHEEL_NIG_PRIOR, Array.from({ length: 50 }, (_, i) => 0.02 + (i % 3) * 0.001));
  const d1 = discountPosterior(post, 0.9, 1);
  const d10 = discountPosterior(post, 0.9, 10);
  // evidence mass shrinks monotonically
  assert.ok(d1.kappa < post.kappa && d10.kappa < d1.kappa);
  assert.ok(d10.kappa >= FLYWHEEL_NIG_PRIOR.kappa);
  // mean pulls toward the prior's 0, never past the posterior's own mu
  assert.ok(Math.abs(d10.mu) < Math.abs(d1.mu) && Math.abs(d1.mu) < Math.abs(post.mu));
  // gamma=1 or steps=0 is the identity
  assert.deepEqual(discountPosterior(post, 1, 5), { ...post });
  assert.deepEqual(discountPosterior(post, 0.9, 0), { ...post });
});

test("B2: Thompson draw is deterministic per seed and concentrates with evidence", () => {
  const tight = { mu: 0.01, kappa: 10_000, alpha: 5_000, beta: 0.05, n: 100 };
  const a = samplePosteriorMean(tight, mulberry32(9));
  const b = samplePosteriorMean(tight, mulberry32(9));
  assert.equal(a, b);
  // with enormous evidence mass the draw sits within a hair of mu
  assert.ok(Math.abs(a - 0.01) < 0.005, `draw ${a} strayed from mu`);
});

// ── B3 — bandit clamps + SHADOW record shape ────────────────────────────────

function arm(overrides: Partial<BanditArm> = {}): BanditArm {
  return {
    strategyId: "s1",
    cohortKey: "s1|TREND|EURUSD",
    posterior: { mu: 0.01, kappa: 200, alpha: 100, beta: 0.001, n: 50 },
    promotedEligible: true,
    decayed: false,
    stalenessSteps: 0,
    ...overrides,
  };
}

test("B3: non-promoted strategy journals weight 0 with the gate-#20 reason (learning still recorded)", () => {
  const rec = computeShadowAllocation([arm({ promotedEligible: false })], mulberry32(1));
  const w = rec.weights[0]!;
  assert.equal(w.weight, 0);
  assert.ok(w.hypotheticalWeight > 0, "the Thompson intention is journaled");
  assert.ok(w.reasons.some((r) => r.startsWith("STRATEGY_NOT_LIVE_PROMOTED")));
});

test("B3: unmeasured and decayed cohorts allocate exactly 0", () => {
  const rec = computeShadowAllocation(
    [
      arm({ cohortKey: "a|R|X", posterior: null }),
      arm({ cohortKey: "b|R|X", posterior: { mu: 0.05, kappa: 5, alpha: 4, beta: 0.001, n: FLYWHEEL_MIN_COHORT_SAMPLE - 1 } }),
      arm({ cohortKey: "c|R|X", decayed: true }),
    ],
    mulberry32(2),
  );
  for (const w of rec.weights) assert.equal(w.weight, 0);
  assert.ok(rec.weights[0]!.reasons[0]!.startsWith("NO_POSTERIOR"));
  assert.ok(rec.weights[1]!.reasons[0]!.startsWith("INSUFFICIENT_SAMPLE"));
  assert.ok(rec.weights[2]!.reasons.some((r) => r.startsWith("EDGE_DECAYED")));
});

test("B3: per-arm cap 0.25 and total ≤ 1 hold; record is SHADOW/NONE", () => {
  const arms = Array.from({ length: 6 }, (_, i) =>
    arm({ strategyId: `s${i}`, cohortKey: `s${i}|R|X` }),
  );
  const rec = computeShadowAllocation(arms, mulberry32(3));
  assert.equal(rec.mode, "SHADOW");
  assert.equal(rec.authority, "NONE");
  let total = 0;
  for (const w of rec.weights) {
    assert.ok(w.weight >= 0 && w.weight <= FLYWHEEL_MAX_ARM_WEIGHT + 1e-12);
    total += w.weight;
  }
  assert.ok(total <= FLYWHEEL_MAX_TOTAL_WEIGHT + 1e-9);
  // a single dominant arm is clamped at the cap, not handed everything
  const solo = computeShadowAllocation([arm()], mulberry32(4));
  assert.equal(solo.weights[0]!.weight, FLYWHEEL_MAX_ARM_WEIGHT);
  assert.ok(solo.weights[0]!.reasons.some((r) => r.startsWith("ARM_CAP")));
});

// ── B4/B5 — decay decisions ─────────────────────────────────────────────────

test("B4/B5: a too-short series is honest silence, not a fabricated break", () => {
  const v = decideEdgeDecay({
    strategyId: "s1",
    cohortKey: "s1|R|X",
    rewardSeries: Array.from({ length: FLYWHEEL_DECAY_MIN_SERIES - 1 }, () => 0.01),
    posterior: null,
  });
  assert.equal(v.decayed, false);
  assert.ok(v.reasons[0]!.startsWith("INSUFFICIENT_SERIES"));
});

test("B4/B5: a downward structural break decays the edge", () => {
  // 40 in-control samples near +0.01, then a hard shift to −0.05.
  const series = [
    ...Array.from({ length: 40 }, (_, i) => 0.01 + ((i % 5) - 2) * 0.002),
    ...Array.from({ length: 30 }, (_, i) => -0.05 + ((i % 5) - 2) * 0.002),
  ];
  const v = decideEdgeDecay({ strategyId: "s1", cohortKey: "s1|R|X", rewardSeries: series, posterior: null });
  assert.equal(v.decayed, true);
  assert.ok(v.reasons[0]!.startsWith("CHANGE_POINT_DOWN"));
  assert.ok(v.detection !== null && (v.detection.cusum.alarm || v.detection.pageHinkley.alarm));
});

test("B4/B5: a non-positive posterior mean on adequate sample decays; a healthy cohort does not", () => {
  const gone = decideEdgeDecay({
    strategyId: "s1",
    cohortKey: "s1|R|X",
    rewardSeries: Array.from({ length: 25 }, () => -0.001),
    posterior: { mu: -0.002, kappa: 30, alpha: 15, beta: 0.001, n: 25 },
  });
  assert.equal(gone.decayed, true);
  assert.ok(gone.reasons.some((r) => r.startsWith("POSTERIOR_MEAN_NONPOSITIVE")));

  const healthy = decideEdgeDecay({
    strategyId: "s1",
    cohortKey: "s1|R|X",
    rewardSeries: Array.from({ length: 25 }, (_, i) => 0.01 + ((i % 5) - 2) * 0.002),
    posterior: { mu: 0.01, kappa: 30, alpha: 15, beta: 0.001, n: 25 },
  });
  assert.equal(healthy.decayed, false);
});

// ── Pins ────────────────────────────────────────────────────────────────────

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

test("pin: decayDemotion reuses the EXISTING change-point detectors", () => {
  assert.match(readSrc("../decayDemotion.ts"), /from "@workspace\/domain\/change-point"/);
});

test("pin: the worker notifies decay through the injected reduce-only seam and never calls promote(", () => {
  const src = readSrc("../flywheelWorker.ts");
  assert.match(src, /notifyDemotion/);
  assert.ok(!src.includes("promote("), "flywheelWorker must never call promote(");
  // decayed arms are journaled AND fed to the bandit as decayed
  assert.match(src, /decayed: verdict\.decayed/);
});

test("pin: the bandit record type has no apply path field", () => {
  const src = readSrc("../bandit.ts");
  assert.ok(!/apply|dispatch\(|execute\(/.test(src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")));
});
