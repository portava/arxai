import {
  type ConvictionReport,
  type DecisionQualityScore,
  type ExpectancyMetrics,
  type SimulationResult,
} from "../decisionIntelligence.types";
import {
  type AggressionLimitDecision,
  type SizingDecision,
} from "./governance.types";

// ═══════════════════════════════════════════════════════════════════════════
// deriveSizingMultiplier — convert conviction + survival + sim into a
// concrete maxPositionSizeR cap.
//
// maxPositionSizeR = baseRiskR
//   × min(aggressionCapMultiplier,
//         convictionMultiplier,
//         qualityMultiplier,
//         survivalMultiplier,
//         simSafetyMultiplier,
//         expectancyMultiplier)
//
// Conviction:
//   • calibration ≥ 0.80         → ×1.00
//   • calibration 0.60–0.80      → linear ramp 0.70 → 1.00
//   • calibration 0.40–0.60      → linear ramp 0.40 → 0.70
//   • calibration < 0.40         → ×0.25 (deeply uncalibrated)
//
// Quality:
//   • quality ≥ 0.75             → ×1.00
//   • quality 0.40–0.75          → linear 0.60 → 1.00
//   • quality < 0.40             → ×0       (PUNISH)
//
// Survival:
//   • survivalQuality ≥ 0.65     → ×1.00
//   • survivalQuality 0.30–0.65  → linear 0.50 → 1.00
//   • survivalQuality < 0.30     → ×0.40
//
// Sim safety (recomputed proof):
//   • not approved               → ×0       (BLOCK)
//   • P(ruin) ≤ 0.02             → ×1.00
//   • P(ruin) ≤ 0.05             → ×0.75
//   • else                       → ×0.50
//
// Expectancy:
//   • E[R] > 0 with sample ≥ 20  → ×1.00
//   • E[R] ≤ 0 with sample ≥ 20  → ×0       (no edge → no size)
//   • sample < 20                → ×0.50    (insufficient evidence)
// ═══════════════════════════════════════════════════════════════════════════

export interface DeriveSizingInput {
  readonly baseRiskR: number;            // base "1R" target risk in R units
  readonly conviction: ConvictionReport;
  readonly decisionQuality: DecisionQualityScore;
  readonly expectancy: ExpectancyMetrics;
  readonly simulation: SimulationResult;
  readonly aggressionLimit: AggressionLimitDecision;
}

function lerp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x <= x0) return y0;
  if (x >= x1) return y1;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

function convictionMul(cal: number): number {
  if (cal >= 0.80) return 1.0;
  if (cal >= 0.60) return lerp(cal, 0.60, 0.80, 0.70, 1.00);
  if (cal >= 0.40) return lerp(cal, 0.40, 0.60, 0.40, 0.70);
  return 0.25;
}
function qualityMul(q: number): number {
  if (q < 0.40) return 0;
  if (q >= 0.75) return 1.0;
  return lerp(q, 0.40, 0.75, 0.60, 1.00);
}
function survivalMul(s: number): number {
  if (s >= 0.65) return 1.0;
  if (s >= 0.30) return lerp(s, 0.30, 0.65, 0.50, 1.00);
  return 0.40;
}
function simMul(sim: SimulationResult): number {
  if (!sim.approved) return 0;
  if (sim.ruinProbability01 <= 0.02) return 1.0;
  if (sim.ruinProbability01 <= 0.05) return 0.75;
  return 0.50;
}
function expectancyMul(e: ExpectancyMetrics): number {
  if (e.sampleSize < 20) return 0.50;
  return e.expectancyR > 0 ? 1.0 : 0;
}

export function deriveSizingMultiplier(
  input: DeriveSizingInput,
): SizingDecision {
  const reasons: string[] = [];
  const cap = input.aggressionLimit.maxAggressionMultiplier;

  const mConv = convictionMul(input.conviction.overallCalibration01);
  const mQual = qualityMul(input.decisionQuality.qualityScore01);
  const mSurv = survivalMul(input.expectancy.survivalQuality01);
  const mSim  = simMul(input.simulation);
  const mExp  = expectancyMul(input.expectancy);

  const applied = Math.min(cap, mConv, mQual, mSurv, mSim, mExp);
  const maxPositionSizeR = Math.max(0, input.baseRiskR * applied);

  reasons.push(`baseRiskR=${input.baseRiskR}`);
  reasons.push(`aggression cap multiplier=${cap.toFixed(2)}`);
  reasons.push(`conviction mul=${mConv.toFixed(2)} (cal=${input.conviction.overallCalibration01.toFixed(2)})`);
  reasons.push(`quality mul=${mQual.toFixed(2)} (q=${input.decisionQuality.qualityScore01.toFixed(2)})`);
  reasons.push(`survival mul=${mSurv.toFixed(2)} (s=${input.expectancy.survivalQuality01.toFixed(2)})`);
  reasons.push(`sim mul=${mSim.toFixed(2)} (approved=${input.simulation.approved}, P(ruin)=${input.simulation.ruinProbability01.toFixed(2)})`);
  reasons.push(`expectancy mul=${mExp.toFixed(2)} (E[R]=${input.expectancy.expectancyR.toFixed(2)}, n=${input.expectancy.sampleSize})`);
  reasons.push(`applied multiplier=${applied.toFixed(2)} → maxPositionSizeR=${maxPositionSizeR.toFixed(3)}`);

  return {
    baseRiskR: input.baseRiskR,
    maxPositionSizeR,
    appliedMultiplier: applied,
    reasons,
  };
}
