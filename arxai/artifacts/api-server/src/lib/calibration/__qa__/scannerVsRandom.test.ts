// Scanner ranking vs random — measured, and reported as it comes out.
//
// The scanner orders every timeframe it scans by calibrated probability
// (rankByCalibration, with the cross-timeframe fallback in readScoped). This
// test asks the only question that matters about that order: do the rows it
// puts on top do better than rows picked at random?
//
// A. Synthetic history with NO edge (driftless GBM, 3 symbols × M1/M5/M15/H1):
//    fits are trained on the first 60% of each series' replayed strategy
//    signals and the held-out 40% is ranked. The top quintile is compared
//    with 5,000 random quintiles on hit rate and on expectancy (R).
//    Honest expectation: the order can lift HIT RATE (it prefers stop/target
//    geometries with a higher base rate) but not EXPECTANCY, because GBM has
//    none to find. The test asserts exactly that the expectancy lift is not
//    significant and prints both numbers.
// B. A planted edge (outcome probability rises with the raw score): the same
//    machinery must beat random decisively, so A's "no edge" is a finding and
//    not a test that cannot see.
//
// Run: pnpm --filter @workspace/api-server run test:calibration

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBars,
  fitCalibration,
  fitKey,
  gbmBars,
  POOLED,
  seededRandom,
  type CalibrationFit,
} from "@workspace/domain/calibration";
import { replayStrategies } from "../strategyReplay.js";
import { calibrate, clearCalibrationCache, rankByCalibration, replaceCalibrationCache } from "../cache.js";
import type { Candle } from "../../strategyEngine.js";

interface Cand {
  strategy: string;
  symbol: string;
  timeframe: string;
  rawScore: number;
  outcome: 0 | 1;
  r: number;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
}

/** Fraction of random top-k picks at least as good as `observed` (one-sided). */
function permutationP(values: number[], k: number, observed: number, seed: number, trials = 5000): number {
  const rand = seededRandom(seed);
  let atLeast = 0;
  const idx = values.map((_, i) => i);
  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rand() * (idx.length - i));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    let s = 0;
    for (let i = 0; i < k; i++) s += values[idx[i]];
    if (s / k >= observed - 1e-12) atLeast++;
  }
  return atLeast / trials;
}

function evaluate(test: Cand[], label: string, seed: number) {
  const readings = test.map((c) => ({
    ...c,
    reading: calibrate(c.strategy, c.symbol, c.timeframe, c.rawScore),
  }));
  const ranked = rankByCalibration(readings);
  const k = Math.max(1, Math.floor(ranked.length / 5));
  const top = ranked.slice(0, k);
  const hitTop = mean(top.map((c) => c.outcome));
  const rTop = mean(top.map((c) => c.r));
  const hitAll = mean(test.map((c) => c.outcome));
  const rAll = mean(test.map((c) => c.r));
  const pHit = permutationP(test.map((c) => c.outcome), k, hitTop, seed);
  const pR = permutationP(test.map((c) => c.r), k, rTop, seed + 1);
  const report = {
    label,
    candidates: test.length,
    topK: k,
    measuredShare: Number((readings.filter((c) => c.reading.probability != null).length / readings.length).toFixed(3)),
    fallbackScopes: [...new Set(readings.map((c) => c.reading.scope))].sort(),
    hitRate: { top: +hitTop.toFixed(4), random: +hitAll.toFixed(4), lift: +(hitTop - hitAll).toFixed(4), pValue: pHit },
    expectancyR: { top: +rTop.toFixed(4), random: +rAll.toFixed(4), lift: +(rTop - rAll).toFixed(4), pValue: pR },
  };
  process.stdout.write(`[scanner-vs-random] ${JSON.stringify(report)}` + "\n");
  return report;
}

function fitAndCache(train: Cand[]): void {
  const groups = new Map<string, Cand[]>();
  const add = (k: string, c: Cand) => {
    const g = groups.get(k) ?? [];
    g.push(c);
    groups.set(k, g);
  };
  for (const c of train) {
    add(fitKey(c.strategy, c.symbol, c.timeframe), c);
    add(fitKey(c.strategy, POOLED, c.timeframe), c);
    add(fitKey(c.strategy, POOLED, POOLED), c);
  }
  const entries: [string, { fit: CalibrationFit; version: number; source: string; fittedAt: string }][] = [];
  for (const [k, rows] of groups) {
    entries.push([k, { fit: fitCalibration(rows.map((r) => ({ score: r.rawScore, outcome: r.outcome }))), version: 1, source: "test", fittedAt: "" }]);
  }
  replaceCalibrationCache(entries);
}

describe("scanner ranking vs random", () => {
  after(() => clearCalibrationCache());

  it("A. driftless GBM across M1/M5/M15/H1: no expectancy edge over random (reported)", () => {
    const train: Cand[] = [];
    const test: Cand[] = [];
    const tfs: [string, number][] = [["M1", 1], ["M5", 5], ["M15", 15], ["H1", 60]];
    for (const [si, symbol] of ["SYN_A", "SYN_B", "SYN_C"].entries()) {
      const m1 = gbmBars(60_000, 4242 + si);
      for (const [tf, factor] of tfs) {
        const bars = (factor === 1 ? m1.slice(0, 20_000) : aggregateBars(m1, factor)) as Candle[];
        const samples = replayStrategies(bars, symbol);
        const cut = Math.floor(bars.length * 0.6);
        for (const s of samples) {
          const c: Cand = {
            strategy: s.strategyKey, symbol, timeframe: tf, rawScore: s.score, outcome: s.outcome,
            r: s.outcome === 1 ? s.rr : -1,
          };
          (s.barIndex < cut ? train : test).push(c);
        }
      }
    }
    fitAndCache(train);
    const rep = evaluate(test, "gbm_no_edge", 77);
    assert.ok(rep.candidates > 500, `enough held-out candidates: ${rep.candidates}`);
    // No calibrated fit claims an edge on GBM.
    for (const c of test.slice(0, 200)) {
      assert.equal(calibrate(c.strategy, c.symbol, c.timeframe, c.rawScore).edgeDetected, false);
    }
    // The honest finding: the calibrated order does not buy expectancy on a
    // driftless market. (Hit-rate lift, if any, is geometry and is reported.)
    assert.ok(rep.expectancyR.pValue > 0.01, `spurious expectancy edge claimed: ${JSON.stringify(rep.expectancyR)}`);
  });

  it("B. a planted edge is found: the calibrated order beats random decisively", () => {
    const rand = seededRandom(31337);
    const mk = (n: number): Cand[] =>
      Array.from({ length: n }, (_, i) => {
        const tf = ["M5", "M15", "H1", "H4"][i % 4];
        const rawScore = rand() * 100;
        const outcome = (rand() < 0.2 + 0.5 * (rawScore / 100) ? 1 : 0) as 0 | 1;
        return { strategy: "scanner", symbol: "PLANTED", timeframe: tf, rawScore, outcome, r: outcome ? 1.5 : -1 };
      });
    // Train has no H4 fits: H4 rows must read through the cross-timeframe fallback.
    const train = mk(4000).filter((c) => c.timeframe !== "H4");
    fitAndCache(train);
    const rep = evaluate(mk(2000), "planted_edge", 78);
    assert.ok(rep.fallbackScopes.some((s) => s.startsWith("timeframe_fallback:")), "H4 rows used the cross-timeframe fallback");
    assert.ok(rep.hitRate.lift > 0.1 && rep.hitRate.pValue < 0.001, JSON.stringify(rep.hitRate));
    assert.ok(rep.expectancyR.lift > 0.2 && rep.expectancyR.pValue < 0.001, JSON.stringify(rep.expectancyR));
  });
});
