import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Systemic Fragility — how brittle is the ecosystem RIGHT NOW. Higher
// fragility means a single shock could cascade. Pure / deterministic.
// ═══════════════════════════════════════════════════════════════════════════

export const FragilityInputsSchema = z.object({
  meanCorrelation01: z.number().min(0).max(1),
  topStrategyCapitalShare01: z.number().min(0).max(1),
  recentFailureRate01: z.number().min(0).max(1),
  liquidityDepthScore01: z.number().min(0).max(1),
  agentDisagreementVariance01: z.number().min(0).max(1).default(0),
});
export type FragilityInputs = z.infer<typeof FragilityInputsSchema>;

export interface FragilityScore {
  fragility01: number;
  triggers: string[];
  reasons: string[];
}

export function evaluateSystemicFragility(i: FragilityInputs): FragilityScore {
  const triggers: string[] = [];
  let f = 0;
  f += i.meanCorrelation01 * 0.30;
  if (i.meanCorrelation01 > 0.7) triggers.push(`high mean correlation ${i.meanCorrelation01.toFixed(2)}`);
  f += i.topStrategyCapitalShare01 * 0.25;
  if (i.topStrategyCapitalShare01 > 0.4) triggers.push(`top-strategy concentration ${(i.topStrategyCapitalShare01 * 100).toFixed(1)}%`);
  f += i.recentFailureRate01 * 0.20;
  if (i.recentFailureRate01 > 0.3) triggers.push(`recent failure rate ${(i.recentFailureRate01 * 100).toFixed(1)}%`);
  f += (1 - i.liquidityDepthScore01) * 0.15;
  if (i.liquidityDepthScore01 < 0.3) triggers.push(`low liquidity depth ${i.liquidityDepthScore01.toFixed(2)}`);
  f += i.agentDisagreementVariance01 * 0.10;
  const fragility01 = Math.min(1, Math.max(0, f));
  return {
    fragility01,
    triggers,
    reasons: [`fragility=${fragility01.toFixed(3)} from ${triggers.length} explicit trigger(s)`],
  };
}
