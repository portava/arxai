import { z } from "zod/v4";
import { ContributionInputsSchema, type ContributionInputs, computeContributionScore } from "./contributionScore.engine";
import { FragilityInputsSchema, type FragilityInputs, evaluateSystemicFragility } from "./systemicFragility.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Ecosystem Fitness — single number in [0, 1] describing how healthy the
// whole strategy ecosystem is. Composed of:
//   • mean per-strategy contribution score (clamped to [0,1] for the mean)
//   • systemic fragility (inverted: more fragile = less fit)
//   • fraction of strategies that are NET-BENEFICIAL
//
// Used as a gate for promotions: a strategy that lowers ecosystem fitness
// must not gain authority, regardless of its isolated profit.
// ═══════════════════════════════════════════════════════════════════════════

export const EcosystemFitnessInputsSchema = z.object({
  contributions: z.array(ContributionInputsSchema).min(1),
  fragility: FragilityInputsSchema,
});
export type EcosystemFitnessInputs = z.infer<typeof EcosystemFitnessInputsSchema>;

export interface EcosystemFitnessReport {
  fitness01: number;
  netBeneficialFraction01: number;
  fragility01: number;
  perStrategy: { strategyId: string; score: number; netBenefit: boolean }[];
  reasons: string[];
  blockers: string[];
}

export function evaluateEcosystemFitness(i: EcosystemFitnessInputs): EcosystemFitnessReport {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const perStrategy = i.contributions.map((c: ContributionInputs) => {
    const r = computeContributionScore(c);
    return { strategyId: r.strategyId, score: r.score, netBenefit: r.netBenefit };
  });
  // Map per-strategy [-1,1] to [0,1] before averaging.
  const meanContribution01 =
    perStrategy.reduce((s, x) => s + (x.score + 1) / 2, 0) / perStrategy.length;
  const netBeneficialFraction01 =
    perStrategy.filter((x) => x.netBenefit).length / perStrategy.length;
  const frag = evaluateSystemicFragility(i.fragility);
  const fitness01 = Math.max(0, Math.min(1,
    meanContribution01 * 0.45
    + netBeneficialFraction01 * 0.30
    + (1 - frag.fragility01) * 0.25,
  ));
  if (fitness01 < 0.4) blockers.push(`ecosystem fitness ${fitness01.toFixed(3)} < 0.4 — promotions should be paused`);
  reasons.push(`fitness=${fitness01.toFixed(3)} (mean contrib ${meanContribution01.toFixed(2)}, beneficial frac ${netBeneficialFraction01.toFixed(2)}, fragility ${frag.fragility01.toFixed(2)})`);
  return {
    fitness01,
    netBeneficialFraction01,
    fragility01: frag.fragility01,
    perStrategy,
    reasons,
    blockers,
  };
}
