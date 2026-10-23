import {
  scoreDrawdownResilience, type DrawdownInputs,
} from "./drawdownResilience.engine";
import {
  scoreCapitalPreservation, type CapitalPreservationInputs,
} from "./capitalPreservation.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Survival Score — composite "are we still in the game" metric. Project
// rule: SURVIVAL must matter MORE than raw win rate. A 90% win rate
// system that blows up once is worse than a 55% win rate system that
// has never had a catastrophic loss.
//
// Composite weights (sum to 1.0):
//   drawdown resilience:  0.40
//   capital preservation: 0.40
//   tail risk inverted:   0.20
// ═══════════════════════════════════════════════════════════════════════════

export interface SurvivalInputs extends DrawdownInputs, CapitalPreservationInputs {
  worstSingleDayPnLPct: number;         // signed; negative = bad. Used for tail risk.
}

export interface SurvivalScoreResult {
  score01: number;
  drawdownResilience01: number;
  capitalPreservation01: number;
  tailRisk01: number;                   // 1 = low tail risk
  reasons: string[];
}

export const SURVIVAL_WEIGHTS = {
  drawdownResilience: 0.40,
  capitalPreservation: 0.40,
  tailRisk: 0.20,
} as const;

export const TAIL_RISK_THRESHOLDS = {
  excellentWorstDayLossPct: 1.0,        // worst day ≤ -1% = excellent (low tail risk)
  poorWorstDayLossPct: 8.0,             // worst day ≤ -8% = poor
} as const;

export function computeSurvivalScore(i: SurvivalInputs): SurvivalScoreResult {
  const reasons: string[] = [];
  const W = SURVIVAL_WEIGHTS;
  const T = TAIL_RISK_THRESHOLDS;

  const dd  = scoreDrawdownResilience(i);
  const cap = scoreCapitalPreservation(i);

  // Tail risk: |worstSingleDayPnLPct| — bigger negative = more tail risk
  const worstLossAbs = Math.max(0, -i.worstSingleDayPnLPct);
  const tailRisk01 = clamp01(1 - (worstLossAbs - T.excellentWorstDayLossPct) / (T.poorWorstDayLossPct - T.excellentWorstDayLossPct));

  reasons.push(
    `drawdownResilience ${dd.score01.toFixed(2)} × ${W.drawdownResilience}`,
    `capitalPreservation ${cap.score01.toFixed(2)} × ${W.capitalPreservation}`,
    `tailRisk ${tailRisk01.toFixed(2)} (worstDay ${i.worstSingleDayPnLPct.toFixed(2)}%) × ${W.tailRisk}`,
  );

  const score = dd.score01 * W.drawdownResilience
              + cap.score01 * W.capitalPreservation
              + tailRisk01  * W.tailRisk;

  return {
    score01: score,
    drawdownResilience01: dd.score01,
    capitalPreservation01: cap.score01,
    tailRisk01,
    reasons: [...reasons, `composite survival score ${score.toFixed(3)}`],
  };
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
