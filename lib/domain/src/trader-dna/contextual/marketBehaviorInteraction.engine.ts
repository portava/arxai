// ═══════════════════════════════════════════════════════════════════════════
// Market × Behavior Interaction
//
// Combines current market regime with the trader's behavior risk score
// to produce a context-adjusted risk modifier. Some regimes (CHOPPY,
// NEWS_DRIVEN) amplify mistakes; others (TRENDING) absorb them.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const MarketRegimeSchema = z.enum([
  "CALM", "TRENDING", "CHOPPY", "NEWS_DRIVEN", "ILLIQUID", "UNKNOWN",
]);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

export const MarketBehaviorInteractionSchema = z.object({
  regime: MarketRegimeSchema,
  behaviorRiskScore01: z.number().min(0).max(1),
  contextMultiplier: z.number().positive(),
  adjustedRiskScore01: z.number().min(0).max(1),
  neutralLanguage: z.string(),
});
export type MarketBehaviorInteraction = z.infer<typeof MarketBehaviorInteractionSchema>;

export function analyzeMarketBehaviorInteraction(input: {
  regime: MarketRegime;
  behaviorRiskScore01: number;
}): MarketBehaviorInteraction {
  const m = ({
    CALM:        0.85,
    TRENDING:    0.80,
    CHOPPY:      1.40,
    NEWS_DRIVEN: 1.55,
    ILLIQUID:    1.30,
    UNKNOWN:     1.00,
  } as const)[input.regime];
  const adj = clamp01(input.behaviorRiskScore01 * m);
  return {
    regime: input.regime,
    behaviorRiskScore01: input.behaviorRiskScore01,
    contextMultiplier: m,
    adjustedRiskScore01: adj,
    neutralLanguage: `${input.regime} regime applies ×${m.toFixed(2)} to behavior risk (${input.behaviorRiskScore01.toFixed(2)} → ${adj.toFixed(2)}).`,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
