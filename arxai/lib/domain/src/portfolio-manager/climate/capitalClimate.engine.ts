import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Capital Climate — composite "weather report" for the ecosystem.
// 0 = hostile (storm), 1 = benign (calm).
// Inputs are weighted negatives of all ecosystem stress signals plus
// positive signals (execution quality, confidence health).
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const ClimateInputSchema = z.object({
  regimeUncertainty01: z.number().min(0).max(1),
  accountDrawdownFraction01: z.number().min(0).max(1),
  agentDisagreement01: z.number().min(0).max(1),
  executionQualityAvg01: z.number().min(0).max(1),
  confidenceHealth01: z.number().min(0).max(1),
  cognitiveRisk01: z.number().min(0).max(1),
});
export type ClimateInput = z.infer<typeof ClimateInputSchema>;

export const ClimateTierSchema = z.enum(["STORM", "ROUGH", "NORMAL", "CALM"]);
export type ClimateTier = z.infer<typeof ClimateTierSchema>;

export interface CapitalClimate {
  climateScore01: number;
  tier: ClimateTier;
  reasons: string[];
}

const W = {
  unc: 0.20, dd: 0.20, dis: 0.15,
  exec: 0.20, conf: 0.15, cog: 0.10,
};

export function assessCapitalClimate(i: ClimateInput): CapitalClimate {
  const benign =
      W.unc  * (1 - clamp01(i.regimeUncertainty01))
    + W.dd   * (1 - clamp01(i.accountDrawdownFraction01))
    + W.dis  * (1 - clamp01(i.agentDisagreement01))
    + W.exec * clamp01(i.executionQualityAvg01)
    + W.conf * clamp01(i.confidenceHealth01)
    + W.cog  * (1 - clamp01(i.cognitiveRisk01));
  const score = clamp01(benign);
  let tier: ClimateTier;
  if (score < 0.25) tier = "STORM";
  else if (score < 0.50) tier = "ROUGH";
  else if (score < 0.75) tier = "NORMAL";
  else tier = "CALM";
  return {
    climateScore01: score, tier,
    reasons: [
      `climate ${score.toFixed(3)} → ${tier}`,
      `unc ${i.regimeUncertainty01.toFixed(2)}, dd ${i.accountDrawdownFraction01.toFixed(2)}, dis ${i.agentDisagreement01.toFixed(2)}`,
      `exec ${i.executionQualityAvg01.toFixed(2)}, conf ${i.confidenceHealth01.toFixed(2)}, cog ${i.cognitiveRisk01.toFixed(2)}`,
    ],
  };
}
