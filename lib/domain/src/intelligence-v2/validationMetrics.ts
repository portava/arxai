import { v1ActionClass, v2ActionClass } from "./shadowRunner";
import type { ResolvedTrade, SystemPerformance, ValidationMetrics } from "./intelligenceV2.types";

// computeValidationMetrics
//
// Aggregates a window of resolved trades (each carrying both v1 and v2
// decisions plus the real outcome) into a single ValidationMetrics
// record. Pure: no IO, callable from any layer.
//
// Quality counters use the canonical 3-state action class (ACTED /
// WAITED / BLOCKED) so the same accounting works regardless of vote
// vocabulary differences between the engines.
export function computeValidationMetrics(input: {
  trades: ResolvedTrade[];
  windowStart?: string;
  windowEnd?: string;
}): ValidationMetrics {
  const trades = input.trades;
  const notes: string[] = [];
  if (trades.length === 0) {
    notes.push("empty sample — metrics are zero");
  }

  // Window bounds default to the data range
  const occurredAts = trades.map((t) => t.occurredAt).sort();
  const windowStart = input.windowStart ?? occurredAts[0] ?? new Date(0).toISOString();
  const windowEnd   = input.windowEnd   ?? occurredAts[occurredAts.length - 1] ?? new Date().toISOString();

  // ── v1 performance — uses real outcomes for trades v1 actually took ──
  const v1Acted = trades.filter((t) => v1ActionClass(t.v1.vote) === "ACTED" && t.realOutcomeR !== null);
  const v1 = computePerformance(v1Acted.map((t) => t.realOutcomeR!));

  // ── v2 sim performance — counterfactual; uses real R when v2 would
  //    have acted, signed by direction agreement and SCALED by v2's
  //    recommendedSizeMultiplier so REDUCE_SIZE contributes proportionally.
  let v2RList: number[] = [];
  for (const t of trades) {
    if (v2ActionClass(t.v2.verdict) !== "ACTED") continue;
    if (t.realOutcomeR === null) continue;
    if (t.realDirection === null) continue;
    if (t.v2.direction === null) continue;

    const sign = t.v2.direction === t.realDirection ? 1 : -1;
    v2RList.push(sign * t.realOutcomeR * t.v2.sizeMultiplier);
  }
  const v2Sim = computePerformance(v2RList);

  // ── Quality counters ─────────────────────────────────────────────────
  let v2FalsePositives = 0;     // v2 ACTED, R<0
  let v2CorrectActions = 0;     // v2 ACTED, R>0
  let v2FalseBlocks    = 0;     // v2 BLOCKED, real trade actually won (R>0)
  let v2CorrectBlocks  = 0;     // v2 BLOCKED, real trade lost (R<0)
  let executionCalibrationSum = 0;
  let executionCalibrationCount = 0;

  for (const t of trades) {
    const v2Class = v2ActionClass(t.v2.verdict);
    if (t.realOutcomeR === null) continue;

    if (v2Class === "ACTED") {
      const sign = t.v2.direction && t.realDirection && t.v2.direction !== t.realDirection ? -1 : 1;
      const r = sign * t.realOutcomeR * t.v2.sizeMultiplier;
      if (r > 0)      v2CorrectActions++;
      else if (r < 0) v2FalsePositives++;

      // Calibration: confidence in [0..100] vs binary win
      const win = r > 0 ? 1 : 0;
      executionCalibrationSum += Math.abs(t.v2.confidence / 100 - win);
      executionCalibrationCount++;
    } else if (v2Class === "BLOCKED") {
      // Counterfactual outcome is the real one if anyone (v1) traded
      if (v1ActionClass(t.v1.vote) === "ACTED") {
        if (t.realOutcomeR > 0) v2FalseBlocks++;
        else                     v2CorrectBlocks++;
      }
    }
  }

  const v2FalsePositiveRate = denomOrZero(v2FalsePositives, v2FalsePositives + v2CorrectActions);
  const v2FalseBlockRate    = denomOrZero(v2FalseBlocks,    v2FalseBlocks + v2CorrectBlocks);
  const executionQuality = executionCalibrationCount > 0
    ? Math.max(0, Math.min(1, 1 - (executionCalibrationSum / executionCalibrationCount))) : 0;
  const riskAvoidanceQuality = denomOrZero(v2CorrectBlocks, v2CorrectBlocks + v2FalseBlocks);

  if (trades.length < 30) notes.push(`small sample (${trades.length}) — metrics noisy`);
  if (v2Sim.tradesActed === 0) notes.push("v2 never acted in this sample");

  return {
    windowStart, windowEnd,
    sampleSize: trades.length,
    v1, v2Sim,
    v2FalsePositives, v2FalseBlocks, v2CorrectActions, v2CorrectBlocks,
    v2FalsePositiveRate, v2FalseBlockRate,
    executionQuality, riskAvoidanceQuality,
    notes,
  };
}

// computePerformance — turn a list of R outcomes into a SystemPerformance summary.
export function computePerformance(rList: number[]): SystemPerformance {
  if (rList.length === 0) {
    return { tradesActed: 0, wins: 0, losses: 0, winRate: 0, avgR: 0, expectancy: 0, totalR: 0 };
  }
  const wins   = rList.filter((r) => r > 0).length;
  const losses = rList.filter((r) => r < 0).length;
  const totalR = rList.reduce((s, r) => s + r, 0);
  const avgR   = totalR / rList.length;
  const winRate = wins / rList.length;
  // Per-trade expectancy IS avgR over the full sample (it already
  // accounts for losing trades by averaging signed R). The earlier
  // `winRate × avgR` form double-discounted losses.
  return {
    tradesActed: rList.length, wins, losses,
    winRate, avgR, expectancy: avgR, totalR,
  };
}

function denomOrZero(num: number, denom: number): number {
  if (denom <= 0) return 0;
  return num / denom;
}
