// THE KILLER TEST — on driftless GBM the calibration engine converges to the
// base rate and never claims an edge.
//
// Driftless geometric Brownian motion is a martingale: nothing computed from
// past bars can tell a winning call from a losing one. Every strategy in the
// strategy engine still emits confident-looking raw scores (70-95) on it. The
// calibration engine must turn every one of those into the same number — the
// measured base rate of that strategy's own stop/target geometry — and must
// not serve an isotonic (score-dependent) model for any of them.
//
//   - "truth": each strategy's base rate on six independent GBM paths
//   - fits on 1 path and on 3 paths (different seeds from the truth paths)
//   - every measured fit: model base_rate, edgeDetected false, one flat
//     probability for every raw score, within 3 SE of the truth; the SE
//     bound shrinks as N grows (convergence)
//   - the same holds on coarser timeframes (M5, M15 aggregates)
//   - the strategy-engine payload, read through the cache, carries that flat
//     probability with its N and edgeDetected=false
//
// Run: pnpm --filter @workspace/api-server run test:calibration

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBars,
  fitCalibration,
  fitKey,
  gbmBars,
  readCalibration,
  type CalibrationFit,
} from "@workspace/domain/calibration";
import { replayStrategies, type ReplaySample } from "../strategyReplay.js";
import { clearCalibrationCache, replaceCalibrationCache } from "../cache.js";
import { trendContinuationStrategy, runStrategyScan, type Candle } from "../../strategyEngine.js";

const BARS = 20_000;

function samplesFor(seeds: number[], factor = 1): ReplaySample[] {
  const out: ReplaySample[] = [];
  for (const seed of seeds) {
    const bars = factor === 1 ? gbmBars(BARS, seed) : aggregateBars(gbmBars(BARS * factor, seed), factor);
    out.push(...replayStrategies(bars as Candle[], "GBM"));
  }
  return out;
}

function byStrategy(samples: ReplaySample[]): Map<string, ReplaySample[]> {
  const m = new Map<string, ReplaySample[]>();
  for (const s of samples) {
    const list = m.get(s.strategyKey) ?? [];
    list.push(s);
    m.set(s.strategyKey, list);
  }
  return m;
}

function assertFlatBaseRate(key: string, fit: CalibrationFit) {
  assert.equal(fit.model, "base_rate", `${key}: served model must be the base rate on GBM`);
  assert.equal(fit.edgeDetected, false, `${key}: must not claim an edge on GBM`);
  if (fit.cv) assert.ok(fit.cv.improvementLower95 <= 0, `${key}: lower95 ${fit.cv.improvementLower95}`);
  const probs = new Set([0, 25, 50, 65, 70, 75, 80, 85, 90, 95, 100].map((s) => readCalibration(fit, s).probability));
  assert.equal(probs.size, 1, `${key}: one probability for every raw score, got ${[...probs].join(",")}`);
}

describe("killer test: driftless GBM", () => {
  const truth = new Map<string, { rate: number; n: number }>();

  before(() => {
    for (const [k, list] of byStrategy(samplesFor([101, 102, 103, 104, 105, 106]))) {
      truth.set(k, { rate: list.reduce((s, x) => s + x.outcome, 0) / list.length, n: list.length });
    }
  });
  after(() => clearCalibrationCache());

  it("calibrated probabilities converge to the base rate and never claim an edge (M1)", () => {
    const rows: string[] = [];
    let measured = 0;
    for (const seeds of [[1], [1, 2, 3]]) {
      for (const [key, list] of byStrategy(samplesFor(seeds))) {
        const fit = fitCalibration(list);
        if (fit.status !== "measured") continue;
        measured++;
        assertFlatBaseRate(key, fit);
        const t = truth.get(key);
        assert.ok(t, `truth for ${key}`);
        const p = readCalibration(fit, 90).probability as number;
        const se = Math.sqrt(t.rate * (1 - t.rate) * (1 / fit.n + 1 / t.n));
        rows.push(`${key} n=${fit.n} p=${p.toFixed(3)} truth=${t.rate.toFixed(3)} |err|=${Math.abs(p - t.rate).toFixed(3)} 3SE=${(3 * se).toFixed(3)} rawBrier=${fit.brierRaw} brier=${fit.brier}`);
        assert.ok(Math.abs(p - t.rate) <= 3 * se + 0.005, rows[rows.length - 1]);
      }
    }
    console.log(`[gbm-killer] M1\n  ${rows.join("\n  ")}`);
    assert.ok(measured >= 8, `expected most strategies measured, got ${measured}`);
  });

  it("no edge on coarser timeframes either (M5, M15 aggregates)", () => {
    for (const factor of [5, 15]) {
      for (const [key, list] of byStrategy(samplesFor([11, 12, 13, 14], factor))) {
        const fit = fitCalibration(list);
        if (fit.status !== "measured") continue;
        assertFlatBaseRate(`${key}@x${factor}`, fit);
      }
    }
  });

  it("the raw heuristic is badly miscalibrated where the calibrated reading is not", () => {
    for (const [key, list] of byStrategy(samplesFor([7]))) {
      const fit = fitCalibration(list);
      if (fit.status !== "measured") continue;
      assert.ok((fit.brier as number) < (fit.brierRaw as number), `${key}: calibrated ${fit.brier} vs raw ${fit.brierRaw}`);
    }
  });

  it("the strategy-engine payload carries the flat base rate with its N", () => {
    const fits = new Map<string, CalibrationFit>();
    for (const [key, list] of byStrategy(samplesFor([1, 2, 3]))) fits.set(key, fitCalibration(list));
    replaceCalibrationCache(
      [...fits].map(([key, fit]) => [fitKey(key, "GBM", "M1"), { fit, version: 1, source: "test", fittedAt: new Date().toISOString() }]),
    );
    const bars = gbmBars(6000, 909) as Candle[];
    let checked = 0;
    for (let i = 300; i < bars.length && checked < 25; i += 7) {
      const sig = trendContinuationStrategy(bars.slice(i - 250, i), "GBM");
      if (sig.direction === "WAIT") continue;
      const fit = fits.get("strategy:trend_continuation")!;
      // Exported strategy wrappers are not timeframe-aware: pooled-key reads
      // fall back; runStrategyScan with a timeframe reads the exact key.
      const scan = runStrategyScan("GBM", bars.slice(i - 250, i), 0, "synthetic", { timeframe: "M1" });
      if (scan.strategy === "Trend Continuation" && scan.direction !== "WAIT") {
        assert.equal(scan.calibratedProbability, readCalibration(fit, 50).probability);
        assert.equal(scan.calibration?.n, fit.n);
        assert.equal(scan.calibration?.edgeDetected, false);
        assert.equal(scan.calibration?.scope, "exact");
        assert.match(scan.calibration?.label ?? "", /^\d+% \(N=\d+\)$/);
        checked++;
      }
    }
    assert.ok(checked > 0, "at least one Trend Continuation payload checked");
  });
});
