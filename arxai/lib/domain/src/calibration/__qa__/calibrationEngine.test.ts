// Calibration engine — the pure contracts.
//
//   1. Below the minimum sample a reading is null + "unmeasured", always with N.
//   2. Isotonic fits are monotone in the raw score.
//   3. A score that really predicts is served as isotonic, beats the base rate
//      out of sample, and its reliability diagram lies near the diagonal.
//   4. A score that predicts nothing is served as the base rate: one flat
//      probability, no edge.
//   5. Agent trust: no record → 0 influence; a noise agent → ~0 influence over
//      many independent records; a skilled agent → positive influence.
//   6. Cross-timeframe fallback reads the nearest measured timeframe and says so.
//
// Run: pnpm --filter @workspace/api-server run test:calibration

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CALIBRATION_MIN_SAMPLE,
  agentTrustFromFit,
  brierScore,
  fitCalibration,
  fitKey,
  measureAgentTrust,
  rankByCalibration,
  readCalibration,
  readScoped,
  reliabilityDiagram,
  seededRandom,
  timeframesByDistance,
  type CalibrationFit,
  type CalibrationSample,
} from "../index";

function noise(n: number, seed: number, base = 0.4): CalibrationSample[] {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => ({ score: Math.floor(r() * 50) + 45, outcome: (r() < base ? 1 : 0) as 0 | 1 }));
}

function signal(n: number, seed: number): CalibrationSample[] {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => {
    const score = r() * 100;
    return { score, outcome: (r() < 0.15 + 0.7 * (score / 100) ? 1 : 0) as 0 | 1 };
  });
}

describe("calibration engine: unmeasured below the minimum sample", () => {
  it("returns null + unmeasured with N, never a rate off a tiny sample", () => {
    const fit = fitCalibration(noise(CALIBRATION_MIN_SAMPLE - 1, 1));
    assert.equal(fit.status, "unmeasured");
    const r = readCalibration(fit, 80);
    assert.equal(r.probability, null);
    assert.equal(r.status, "unmeasured");
    assert.equal(r.n, CALIBRATION_MIN_SAMPLE - 1);
    assert.match(r.reason ?? "", /Unmeasured: 29 graded outcomes, 30 needed/);
  });

  it("a missing fit reads unmeasured with N=0", () => {
    const r = readCalibration(null, 99);
    assert.equal(r.probability, null);
    assert.equal(r.n, 0);
  });

  it("at the minimum sample the base rate is measured and served with its N", () => {
    const fit = fitCalibration(noise(CALIBRATION_MIN_SAMPLE, 2));
    assert.equal(fit.status, "measured");
    assert.equal(fit.model, "base_rate");
    const r = readCalibration(fit, 95);
    assert.equal(r.probability, Math.round((fit.wins / fit.n) * 1e4) / 1e4);
    assert.equal(r.n, CALIBRATION_MIN_SAMPLE);
  });
});

describe("calibration engine: isotonic fit", () => {
  it("blocks are monotone non-decreasing in score", () => {
    for (const seed of [3, 4, 5, 6]) {
      const fit = fitCalibration(signal(800, seed));
      for (let i = 1; i < fit.blocks.length; i++) {
        assert.ok(fit.blocks[i].probability >= fit.blocks[i - 1].probability, `seed ${seed} block ${i}`);
        assert.ok(fit.blocks[i].lo > fit.blocks[i - 1].hi || fit.blocks[i].lo >= fit.blocks[i - 1].lo);
      }
    }
  });

  it("a predictive score is served isotonic, beats the base rate out of sample, and is reliable", () => {
    const fit = fitCalibration(signal(3000, 7));
    assert.equal(fit.model, "isotonic");
    assert.equal(fit.edgeDetected, true);
    assert.ok(fit.cv && fit.cv.improvementLower95 > 0);
    assert.ok((fit.brier as number) < (fit.brierBaseline as number));
    // Reliability: every well-populated bin within 3 standard errors (+0.02)
    // of the diagonal. The predictions are out-of-sample (CV), so this is a
    // real check, not the fit grading itself.
    for (const b of fit.reliability) {
      if (b.n < 100) continue;
      const p = b.meanPredicted as number;
      const tol = 3 * Math.sqrt((p * (1 - p)) / b.n) + 0.02;
      assert.ok(Math.abs(p - (b.observedRate as number)) < tol, JSON.stringify(b));
    }
    const low = readCalibration(fit, 10).probability as number;
    const high = readCalibration(fit, 90).probability as number;
    assert.ok(high - low > 0.4, `low ${low} high ${high}`);
  });

  it("a score that predicts nothing is served as one flat base rate with no edge", () => {
    for (const seed of [11, 12, 13, 14, 15]) {
      const fit = fitCalibration(noise(2000, seed));
      assert.equal(fit.model, "base_rate", `seed ${seed}`);
      assert.equal(fit.edgeDetected, false);
      const ps = new Set([0, 45, 60, 80, 95, 100].map((s) => readCalibration(fit, s).probability));
      assert.equal(ps.size, 1, "one probability whatever the score");
    }
  });

  it("Brier score and reliability diagram are exact on a hand case", () => {
    assert.equal(brierScore([0.5, 1, 0], [1, 1, 0]), Math.round((0.25 / 3) * 1e6) / 1e6);
    const rel = reliabilityDiagram([0.05, 0.15, 0.95, 0.95], [0, 1, 1, 0], 10);
    assert.equal(rel[0].n, 1);
    assert.equal(rel[1].observedRate, 1);
    assert.equal(rel[9].n, 2);
    assert.equal(rel[9].observedRate, 0.5);
  });
});

describe("agent trust is measured only from the agent's own scored record", () => {
  it("no record means zero influence", () => {
    const t = agentTrustFromFit("risk-1", null);
    assert.equal(t.influence, 0);
    assert.equal(t.trustScore, 50);
    assert.match(t.basis, /no_scored_record/);
  });

  it("a noise agent ends at about zero influence across 200 independent records", () => {
    let sum = 0;
    let max = 0;
    for (let seed = 0; seed < 200; seed++) {
      const t = measureAgentTrust(`noise-${seed}`, noise(400, 5000 + seed, 0.3 + (seed % 5) * 0.08));
      sum += t.influence;
      max = Math.max(max, t.influence);
    }
    const mean = sum / 200;
    process.stdout.write(`[agent-noise] mean influence ${mean.toFixed(4)}, max ${max.toFixed(3)} over 200 noise agents (n=400 each)` + "\n");
    assert.ok(mean < 0.01, `mean influence ${mean}`);
    assert.ok(max <= 0.25, `max influence ${max}`);
  });

  it("a skilled agent earns positive influence", () => {
    const t = measureAgentTrust("skilled", signal(1500, 21));
    assert.ok(t.influence > 0.2, `influence ${t.influence}`);
    assert.ok(t.trustScore > 50);
  });
});

describe("cross-timeframe fallback and calibrated ranking", () => {
  it("orders other timeframes by ladder distance", () => {
    assert.deepEqual(timeframesByDistance("M15").slice(0, 4), ["M12", "M20", "M10", "M30"]);
  });

  it("reads exact, then the nearest measured timeframe, then pooled, and labels the scope", () => {
    const measured = fitCalibration(noise(200, 31));
    const thin = fitCalibration(noise(10, 32));
    const fits = new Map<string, { fit: CalibrationFit; version: number }>([
      [fitKey("scanner", "EURUSD", "M15"), { fit: thin, version: 1 }],
      [fitKey("scanner", "EURUSD", "H1"), { fit: measured, version: 4 }],
    ]);
    const r = readScoped({ get: (k) => fits.get(k) }, "scanner", "EURUSD", "M15", 70);
    assert.equal(r.scope, "timeframe_fallback:H1");
    assert.equal(r.fitVersion, 4);
    assert.equal(r.n, 200);
    const none = readScoped({ get: () => undefined }, "scanner", "EURUSD", "M15", 70);
    assert.equal(none.probability, null);
    assert.equal(none.scope, "none");
    const onlyThin = readScoped({ get: (k) => (k === fitKey("scanner", "EURUSD", "M15") ? fits.get(k) : undefined) }, "scanner", "EURUSD", "M15", 70);
    assert.equal(onlyThin.probability, null);
    assert.equal(onlyThin.n, 10, "unmeasured still carries the N it has");
  });

  it("measured rows always outrank unmeasured rows; raw score orders the rest", () => {
    const ranked = rankByCalibration([
      { id: "a", rawScore: 99, reading: { probability: null } },
      { id: "b", rawScore: 10, reading: { probability: 0.41 } },
      { id: "c", rawScore: 50, reading: { probability: 0.55 } },
      { id: "d", rawScore: 60, reading: { probability: null } },
    ]);
    assert.deepEqual(ranked.map((r) => r.id), ["c", "b", "a", "d"]);
    assert.deepEqual(ranked.map((r) => r.rankBasis), [
      "calibrated_probability", "calibrated_probability", "unmeasured_raw_order", "unmeasured_raw_order",
    ]);
  });
});
