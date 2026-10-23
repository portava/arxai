import { z } from "zod/v4";
import { StrategyIdSchema, clamp01 } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Capital Fatigue — long-deployed and bleeding strategies are exhausted
// and should temporarily lose participation, even if otherwise eligible.
// fatigue01 = 0 (fresh) … 1 (exhausted).
// multiplier in [0.4, 1.0].
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const FatigueInputSchema = z.object({
  strategyId: StrategyIdSchema,
  deploymentDurationDays: z.number().nonnegative(),
  recentDrawdown01: z.number().min(0).max(1),
});
export type FatigueInput = z.infer<typeof FatigueInputSchema>;

export const FATIGUE_BOUNDS = { min: 0.4, max: 1.0 } as const;

export interface CapitalFatigueOutput {
  perStrategy: ReadonlyArray<{
    strategyId: string; fatigue01: number; multiplier: number; reasons: string[];
  }>;
  multipliersById: ReadonlyMap<string, number>;
}

const FATIGUE_FULL_DAYS = 60;

export function computeCapitalFatigue(
  inputs: ReadonlyArray<FatigueInput>,
): CapitalFatigueOutput {
  const map = new Map<string, number>();
  const perStrategy = inputs.map((s) => {
    const ageRatio = clamp01(s.deploymentDurationDays / FATIGUE_FULL_DAYS);
    const dd = clamp01(s.recentDrawdown01);
    const fatigue = clamp01(0.5 * ageRatio + 0.5 * dd);
    const m = FATIGUE_BOUNDS.max - fatigue * (FATIGUE_BOUNDS.max - FATIGUE_BOUNDS.min);
    map.set(s.strategyId, m);
    return {
      strategyId: s.strategyId,
      fatigue01: fatigue,
      multiplier: m,
      reasons: [
        `age ${s.deploymentDurationDays}d → ratio ${ageRatio.toFixed(2)}, dd ${dd.toFixed(2)}`,
        `fatigue ${fatigue.toFixed(3)} → multiplier ${m.toFixed(3)}`,
      ],
    };
  });
  return { perStrategy, multipliersById: map };
}
