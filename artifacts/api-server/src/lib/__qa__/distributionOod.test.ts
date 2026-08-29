// Capability #3 — distribution-based OOD detection.
//
// Locked here:
//   * References are DISTRIBUTIONS (empirical deciles from real history), and
//     live windows are compared with two-sample statistics (PSI + KS) — not
//     scalar thresholds.
//   * KNOWN-SHIFT REPLAY BENCHMARK: fixtures with deliberately shifted
//     volatility, tick cadence, cost, and a joint (combination) shift are all
//     DETECTED.
//   * MEASURED FALSE-POSITIVE RATE: across 40 no-shift replay windows drawn
//     from the same generator, the false-positive rate is measured and must
//     stay ≤ 10%.
//   * Fail-honest: thin reference → INSUFFICIENT_REFERENCE; thin live window
//     → INSUFFICIENT_LIVE; nothing measurable → INSUFFICIENT_EVIDENCE (never
//     IN_DISTRIBUTION by default). advisoryOnly is stamped on every verdict.
//
// Run: pnpm --filter @workspace/api-server run test:distribution-ood

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_LIVE_SAMPLES,
  MIN_REFERENCE_SAMPLES,
  buildReferenceDistribution,
  compareToReference,
  evaluateDistributionOod,
  tickCadenceFeature,
  volCostProductFeature,
  volatilityFeature,
  type DistributionOodInput,
} from "@workspace/domain/continuous-validation";

// Deterministic LCG so the benchmark replays identically forever.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Positive, right-skewed samples (spread/vol-like): scale × (0.5 + u²). */
function skewedSamples(n: number, scale: number, seed: number): number[] {
  const rnd = lcg(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = rnd();
    out.push(scale * (0.5 + u * u));
  }
  return out;
}

const REF_N = 500;
const LIVE_N = 200;

// ── Feature extraction sanity ───────────────────────────────────────────────

test("volatility/tickCadence/volCostProduct extract real series", () => {
  const closes = [100, 101, 100.5, 102, 101].map((c) => ({ close: c }));
  const vol = volatilityFeature(closes);
  assert.equal(vol.length, 4);
  assert.ok(vol.every((v) => v > 0));

  const gaps = tickCadenceFeature([1000, 1250, 1600, 1600, 2100]);
  assert.deepEqual(gaps, [250, 350, 0, 500]);

  const joint = volCostProductFeature([0.1, 0.2, 0.3], [2, 3]);
  assert.deepEqual(joint, [0.2 * 2, 0.3 * 3]);
});

// ── Honest insufficiency ────────────────────────────────────────────────────

test("thin reference → INSUFFICIENT_REFERENCE (never a certified distribution)", () => {
  const ref = buildReferenceDistribution("volatility", skewedSamples(MIN_REFERENCE_SAMPLES - 1, 1, 7));
  assert.equal(ref.status, "INSUFFICIENT_REFERENCE");
  const cmp = compareToReference(skewedSamples(LIVE_N, 1, 8), ref);
  assert.equal(cmp.status, "INSUFFICIENT_REFERENCE");
});

test("thin live window → INSUFFICIENT_LIVE for that feature", () => {
  const ref = buildReferenceDistribution("cost", skewedSamples(REF_N, 1, 9));
  const cmp = compareToReference(skewedSamples(MIN_LIVE_SAMPLES - 1, 1, 10), ref);
  assert.equal(cmp.status, "INSUFFICIENT_LIVE");
});

test("nothing measurable → INSUFFICIENT_EVIDENCE, never IN_DISTRIBUTION by default", () => {
  const inputs: DistributionOodInput[] = [
    {
      feature: "volatility",
      liveValues: [],
      reference: buildReferenceDistribution("volatility", []),
    },
  ];
  const verdict = evaluateDistributionOod(inputs);
  assert.equal(verdict.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(verdict.advisoryOnly, true);
});

// ── Known-shift replay benchmark ────────────────────────────────────────────

test("known-shift benchmark: vol / cadence / cost / joint shifts all detected", () => {
  const volRef = buildReferenceDistribution("volatility", skewedSamples(REF_N, 0.001, 11));
  const cadRef = buildReferenceDistribution("tickCadence", skewedSamples(REF_N, 400, 12));
  const costRef = buildReferenceDistribution("cost", skewedSamples(REF_N, 0.0002, 13));

  // Volatility regime doubled.
  const volShift = compareToReference(skewedSamples(LIVE_N, 0.002, 14), volRef);
  assert.equal(volShift.status, "SHIFTED", "vol ×2 must be detected");

  // Tick cadence slowed 3×.
  const cadShift = compareToReference(skewedSamples(LIVE_N, 1200, 15), cadRef);
  assert.equal(cadShift.status, "SHIFTED", "cadence ×3 must be detected");

  // Cost widened 2×.
  const costShift = compareToReference(skewedSamples(LIVE_N, 0.0004, 16), costRef);
  assert.equal(costShift.status, "SHIFTED", "cost ×2 must be detected");

  // JOINT shift: vol and cost each shifted only ~1.35× (kept marginally
  // subtle), but their product shifts ~1.8× — the combination feature sees it.
  const jointRefVals = volCostProductFeature(
    skewedSamples(REF_N, 0.001, 17),
    skewedSamples(REF_N, 0.0002, 18),
  );
  const jointRef = buildReferenceDistribution("volCostProduct", jointRefVals);
  const jointLive = volCostProductFeature(
    skewedSamples(LIVE_N, 0.00135, 19),
    skewedSamples(LIVE_N, 0.00027, 20),
  );
  const jointShift = compareToReference(jointLive, jointRef);
  assert.equal(jointShift.status, "SHIFTED", "joint vol×cost shift must be detected");

  // Overall verdict rolls up as OOD_SHIFT.
  const verdict = evaluateDistributionOod([
    { feature: "volatility", liveValues: skewedSamples(LIVE_N, 0.002, 21), reference: volRef },
    { feature: "cost", liveValues: skewedSamples(LIVE_N, 0.0002, 22), reference: costRef },
  ]);
  assert.equal(verdict.status, "OK");
  if (verdict.status === "OK") {
    assert.equal(verdict.verdict, "OOD_SHIFT");
    assert.deepEqual(verdict.shiftedFeatures, ["volatility"]);
    assert.equal(verdict.advisoryOnly, true);
  }
});

// ── Measured false-positive rate on no-shift fixtures ───────────────────────

test("no-shift benchmark: measured false-positive rate ≤ 10% over 40 windows", () => {
  const ref = buildReferenceDistribution("volatility", skewedSamples(REF_N, 0.001, 100));
  const WINDOWS = 40;
  let falsePositives = 0;
  let measured = 0;
  for (let w = 0; w < WINDOWS; w++) {
    const cmp = compareToReference(skewedSamples(LIVE_N, 0.001, 200 + w), ref);
    assert.ok(cmp.status === "IN_DISTRIBUTION" || cmp.status === "SHIFTED");
    measured += 1;
    if (cmp.status === "SHIFTED") falsePositives += 1;
  }
  const fpRate = falsePositives / measured;
  assert.ok(
    fpRate <= 0.1,
    `measured false-positive rate ${fpRate} (${falsePositives}/${measured}) exceeds 10%`,
  );
});
