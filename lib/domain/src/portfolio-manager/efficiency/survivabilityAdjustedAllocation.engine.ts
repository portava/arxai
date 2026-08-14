import { z } from "zod/v4";
import { StrategyIdSchema, clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Survivability-Adjusted Allocation — combines risk-adjusted efficiency
// with survivalScore into a single bounded multiplier in [0.2, 1.4].
//
// "Allocate to what survives, not what runs hottest."
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const SurvivabilityAdjustedInputSchema = z.object({
  strategyId: StrategyIdSchema,
  riskAdjustedEfficiency: z.number(),
  survivalScore01: z.number().min(0).max(1),
});
export type SurvivabilityAdjustedInput = z.infer<typeof SurvivabilityAdjustedInputSchema>;

export const SURV_ADJ_BOUNDS = { min: 0.2, max: 1.4 } as const;

export interface SurvivabilityAdjustedOutput {
  multipliers: ReadonlyArray<{ strategyId: string; multiplier: number; reasons: string[] }>;
  multipliersById: ReadonlyMap<string, number>;
}

export function survivabilityAdjustedAllocation(
  inputs: ReadonlyArray<SurvivabilityAdjustedInput>,
): SurvivabilityAdjustedOutput {
  const map = new Map<string, number>();
  const multipliers = inputs.map((s) => {
    const surv = clamp01(s.survivalScore01);
    // Squash efficiency to [0,1] via tanh/2+0.5 so we don't blow up on outliers.
    const effSquash = (Math.tanh(s.riskAdjustedEfficiency) + 1) / 2;
    // Composite: 60% survivability, 40% efficiency.
    const composite = 0.60 * surv + 0.40 * effSquash;
    const m = SURV_ADJ_BOUNDS.min + composite * (SURV_ADJ_BOUNDS.max - SURV_ADJ_BOUNDS.min);
    map.set(s.strategyId, m);
    return {
      strategyId: s.strategyId,
      multiplier: m,
      reasons: [
        `survival ${surv.toFixed(2)}, eff(squash) ${effSquash.toFixed(3)}`,
        `composite ${composite.toFixed(3)} → multiplier ${m.toFixed(3)}`,
      ],
    };
  });
  return { multipliers, multipliersById: map };
}
