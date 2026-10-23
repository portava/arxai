import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Portfolio Health — composite score and tier from all observable
// ecosystem signals. Continuous, advisory, vault-logged.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const HealthTierSchema = z.enum(["CRITICAL", "WARN", "OK", "STRONG"]);
export type HealthTier = z.infer<typeof HealthTierSchema>;

export const HealthInputSchema = z.object({
  climateScore01: z.number().min(0).max(1),
  fragility01: z.number().min(0).max(1),
  diversification01: z.number().min(0).max(1),
  concentrationIndex01: z.number().min(0).max(1),
  executionQualityAvg01: z.number().min(0).max(1),
  // Squash any sign of capitalEfficiency to [0,1] by tanh on the caller side.
  capitalEfficiency01: z.number().min(0).max(1),
  regimeConcentration01: z.number().min(0).max(1),
});
export type HealthInput = z.infer<typeof HealthInputSchema>;

export interface PortfolioHealthOutput {
  health01: number;
  tier: HealthTier;
  contributingSignals: Record<string, number>;
  reasons: string[];
}

const W = {
  climate: 0.20, fragility: 0.20, divers: 0.15, conc: 0.15,
  exec: 0.10, eff: 0.10, regime: 0.10,
};

export function computePortfolioHealth(i: HealthInput): PortfolioHealthOutput {
  const positive =
      W.climate * clamp01(i.climateScore01)
    + W.divers  * clamp01(i.diversification01)
    + W.exec    * clamp01(i.executionQualityAvg01)
    + W.eff     * clamp01(i.capitalEfficiency01);
  const negative =
      W.fragility * clamp01(i.fragility01)
    + W.conc      * clamp01(i.concentrationIndex01)
    + W.regime    * clamp01(i.regimeConcentration01);
  // Health = positive − negative, both in [0, sum(W_pos)]/[0,sum(W_neg)].
  // Normalize to 0..1 by recentering.
  const raw = positive - negative;
  // raw ∈ [-(W.fragility+W.conc+W.regime), (W.climate+W.divers+W.exec+W.eff)]
  //     = [-0.45, 0.55]; recenter to 0..1 over that span.
  const lo = -0.45, hi = 0.55;
  const score = clamp01((raw - lo) / (hi - lo));
  let tier: HealthTier;
  if (score < 0.25) tier = "CRITICAL";
  else if (score < 0.50) tier = "WARN";
  else if (score < 0.75) tier = "OK";
  else tier = "STRONG";
  return {
    health01: score, tier,
    contributingSignals: {
      climate: clamp01(i.climateScore01),
      fragility: clamp01(i.fragility01),
      diversification: clamp01(i.diversification01),
      concentration: clamp01(i.concentrationIndex01),
      execution: clamp01(i.executionQualityAvg01),
      efficiency: clamp01(i.capitalEfficiency01),
      regimeConcentration: clamp01(i.regimeConcentration01),
    },
    reasons: [
      `positive ${positive.toFixed(3)}, negative ${negative.toFixed(3)}, raw ${raw.toFixed(3)}`,
      `health ${score.toFixed(3)} → ${tier}`,
    ],
  };
}
