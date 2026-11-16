import {
  type AdaptiveAggression, type AggressionLevel, type ConvictionReport,
  type ExpectancyMetrics, type FatigueState, type MarketPersonality,
  clamp01,
} from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Adaptive Aggression — picks an aggression level (and risk multiplier)
// based on conviction QUALITY (not streak), expectancy, fatigue, and
// market personality.
//
//   composite = w_c·calibration + w_e·expectancyQuality + w_s·survival
//             − w_f·fatigue − w_n·frenzy/noise penalty
//
//   level = bucketed via cut points; multiplier looked up per level.
//
// Hard rules:
//   • forceCooldown → CONSERVATIVE × 0 (no live risk)
//   • calibration < MIN_CAL → cap at STANDARD
//   • mean expectancy < 0 → cap at CONSERVATIVE
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_AGGRESSION_TUNING = {
  W_CALIBRATION: 0.35,
  W_EXPECTANCY:  0.30,
  W_SURVIVAL:    0.20,
  W_FATIGUE:     0.25,    // subtracted
  W_NOISE:       0.15,    // subtracted (frenzy + noisy)
  CUT_ELEVATED:  0.65,
  CUT_MAX:       0.85,
  CUT_STANDARD:  0.40,
  MIN_CAL_FOR_ELEVATED: 0.55,
} as const;
export type AggressionTuning = typeof DEFAULT_AGGRESSION_TUNING;

export const LEVEL_MULTIPLIER: Record<AggressionLevel, number> = {
  CONSERVATIVE: 0.50,
  STANDARD:     1.00,
  ELEVATED:     1.40,
  MAX:          1.75,
};

export interface AggressionInput {
  conviction: ConvictionReport;
  expectancy: ExpectancyMetrics;
  fatigue: FatigueState;
  market: MarketPersonality;
  tuning?: AggressionTuning;
}

export function recommendAggression(input: AggressionInput): AdaptiveAggression {
  const t = input.tuning ?? DEFAULT_AGGRESSION_TUNING;
  const reasons: string[] = [];
  const blockers: string[] = [];

  // Hard cooldown — no live risk regardless of composite.
  if (input.fatigue.forceCooldown) {
    blockers.push(`fatigue cooldown active (${input.fatigue.cooldownMinutes.toFixed(0)}m) — aggression CONSERVATIVE × 0`);
    return {
      level: "CONSERVATIVE", multiplier: 0,
      reasons: [`forceCooldown — zero risk multiplier`], blockers,
    };
  }

  const noisePenalty = clamp01(0.5 * input.market.frenzy01 + 0.5 * input.market.noisy01);
  const composite =
      t.W_CALIBRATION * clamp01(input.conviction.overallCalibration01)
    + t.W_EXPECTANCY  * clamp01(input.expectancy.expectancyQuality01)
    + t.W_SURVIVAL    * clamp01(input.expectancy.survivalQuality01)
    - t.W_FATIGUE     * clamp01(input.fatigue.fatigueScore01)
    - t.W_NOISE       * noisePenalty;
  const composite01 = clamp01(composite);
  reasons.push(
    `composite ${composite01.toFixed(3)} (cal ${input.conviction.overallCalibration01.toFixed(2)} · ` +
    `eQ ${input.expectancy.expectancyQuality01.toFixed(2)} · sQ ${input.expectancy.survivalQuality01.toFixed(2)} · ` +
    `−fatigue ${input.fatigue.fatigueScore01.toFixed(2)} · −noise ${noisePenalty.toFixed(2)})`);

  let level: AggressionLevel;
  if      (composite01 >= t.CUT_MAX)      level = "MAX";
  else if (composite01 >= t.CUT_ELEVATED) level = "ELEVATED";
  else if (composite01 >= t.CUT_STANDARD) level = "STANDARD";
  else                                    level = "CONSERVATIVE";

  // Caps.
  if (input.expectancy.expectancyR < 0) {
    if (level !== "CONSERVATIVE") reasons.push(`capped to CONSERVATIVE — negative expectancyR ${input.expectancy.expectancyR.toFixed(3)}`);
    level = "CONSERVATIVE";
  } else if (input.conviction.overallCalibration01 < t.MIN_CAL_FOR_ELEVATED) {
    if (level === "ELEVATED" || level === "MAX") {
      reasons.push(`capped to STANDARD — calibration ${input.conviction.overallCalibration01.toFixed(2)} < ${t.MIN_CAL_FOR_ELEVATED}`);
      level = "STANDARD";
    }
  }

  const multiplier = LEVEL_MULTIPLIER[level];
  reasons.push(`level ${level} → multiplier ${multiplier.toFixed(2)}`);
  return { level, multiplier, reasons, blockers };
}
