import { z } from "zod/v4";
import { StrategyIdSchema } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Risk-Adjusted Efficiency — Sortino-flavored: expectancy ÷ downside risk.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const RiskAdjustedInputSchema = z.object({
  strategyId: StrategyIdSchema,
  expectancyR: z.number(),
  downsideR: z.number().nonnegative(),
});
export type RiskAdjustedInput = z.infer<typeof RiskAdjustedInputSchema>;

export interface RiskAdjustedEfficiency {
  perStrategy: ReadonlyArray<{
    strategyId: string; riskAdjustedEfficiency: number; reasons: string[];
  }>;
}

export function computeRiskAdjustedEfficiency(
  inputs: ReadonlyArray<RiskAdjustedInput>,
): RiskAdjustedEfficiency {
  return {
    perStrategy: inputs.map((s) => {
      const denom = Math.max(s.downsideR, 1);
      const v = s.expectancyR / denom;
      return {
        strategyId: s.strategyId,
        riskAdjustedEfficiency: v,
        reasons: [`expectancyR ${s.expectancyR.toFixed(3)} / max(downside ${s.downsideR.toFixed(2)}, 1) = ${v.toFixed(4)}`],
      };
    }),
  };
}
