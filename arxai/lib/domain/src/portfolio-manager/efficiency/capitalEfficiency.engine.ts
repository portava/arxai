import { z } from "zod/v4";
import { StrategyIdSchema } from "../portfolio.types";

// ═══════════════════════════════════════════════════════════════════════════
// Capital Efficiency — return per R deployed.
// Higher = capital is "working harder". Used as input to allocation trust
// and survivability-adjusted allocation, not as a direct allocator.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export const EfficiencyInputSchema = z.object({
  strategyId: StrategyIdSchema,
  expectancyR: z.number(),
  riskRDeployed: z.number().nonnegative(),
});
export type EfficiencyInput = z.infer<typeof EfficiencyInputSchema>;

export interface CapitalEfficiencyOutput {
  perStrategy: ReadonlyArray<{
    strategyId: string; efficiency: number; reasons: string[];
  }>;
  portfolioEfficiency: number;
  reasons: string[];
}

export function computeCapitalEfficiency(
  inputs: ReadonlyArray<EfficiencyInput>,
): CapitalEfficiencyOutput {
  const per = inputs.map((s) => {
    const denom = Math.max(s.riskRDeployed, 1);
    const eff = s.expectancyR / denom;
    return {
      strategyId: s.strategyId,
      efficiency: eff,
      reasons: [`expectancyR ${s.expectancyR.toFixed(3)} / max(risk ${s.riskRDeployed.toFixed(2)}, 1) = ${eff.toFixed(4)}`],
    };
  });
  const totalR = inputs.reduce((s, x) => s + x.expectancyR, 0);
  const totalDeployed = Math.max(inputs.reduce((s, x) => s + x.riskRDeployed, 0), 1);
  const portfolio = totalR / totalDeployed;
  return {
    perStrategy: per,
    portfolioEfficiency: portfolio,
    reasons: [`portfolioEfficiency ${portfolio.toFixed(4)} (totalR ${totalR.toFixed(2)} / totalDeployed ${totalDeployed.toFixed(2)})`],
  };
}
