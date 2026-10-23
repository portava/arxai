// ═══════════════════════════════════════════════════════════════════════════
// Volatility × Behavior Interaction
//
// Maps current implied/realized volatility band to a multiplier that
// either amplifies or dampens behavioral risk.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const VolatilityBandSchema = z.enum(["LOW", "NORMAL", "ELEVATED", "EXTREME"]);
export type VolatilityBand = z.infer<typeof VolatilityBandSchema>;

export const VolatilityBehaviorInteractionSchema = z.object({
  band: VolatilityBandSchema,
  behaviorRiskScore01: z.number().min(0).max(1),
  contextMultiplier: z.number().positive(),
  adjustedRiskScore01: z.number().min(0).max(1),
  neutralLanguage: z.string(),
});
export type VolatilityBehaviorInteraction = z.infer<typeof VolatilityBehaviorInteractionSchema>;

export function classifyVolatilityBand(realizedVolPct: number): VolatilityBand {
  if (realizedVolPct < 0.5) return "LOW";
  if (realizedVolPct < 1.5) return "NORMAL";
  if (realizedVolPct < 3.0) return "ELEVATED";
  return "EXTREME";
}

export function analyzeVolatilityBehaviorInteraction(input: {
  band: VolatilityBand;
  behaviorRiskScore01: number;
}): VolatilityBehaviorInteraction {
  const m = ({ LOW: 0.85, NORMAL: 1.00, ELEVATED: 1.30, EXTREME: 1.60 } as const)[input.band];
  const adj = clamp01(input.behaviorRiskScore01 * m);
  return {
    band: input.band,
    behaviorRiskScore01: input.behaviorRiskScore01,
    contextMultiplier: m,
    adjustedRiskScore01: adj,
    neutralLanguage: `${input.band} volatility applies ×${m.toFixed(2)} to behavior risk.`,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
