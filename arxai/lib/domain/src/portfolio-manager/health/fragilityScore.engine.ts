import { z } from "zod/v4";
import { clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Fragility Score — how vulnerable the current portfolio is to shock.
// 0 = robust, 1 = fragile.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const FragilityInputSchema = z.object({
  accountDrawdownFraction01: z.number().min(0).max(1),
  correlatedExposureScore01: z.number().min(0).max(1),
  decayedStrategyShare01: z.number().min(0).max(1),
  agentDisagreement01: z.number().min(0).max(1),
});
export type FragilityInput = z.infer<typeof FragilityInputSchema>;

export interface FragilityOutput {
  fragility01: number;
  reasons: string[];
}

export function computeFragilityScore(i: FragilityInput): FragilityOutput {
  const f = clamp01(
      0.35 * i.accountDrawdownFraction01
    + 0.30 * i.correlatedExposureScore01
    + 0.20 * i.decayedStrategyShare01
    + 0.15 * i.agentDisagreement01,
  );
  return {
    fragility01: f,
    reasons: [
      `dd ${i.accountDrawdownFraction01.toFixed(2)}, corr ${i.correlatedExposureScore01.toFixed(2)}, decay ${i.decayedStrategyShare01.toFixed(2)}, dis ${i.agentDisagreement01.toFixed(2)}`,
      `fragility ${f.toFixed(3)}`,
    ],
  };
}
