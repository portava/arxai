import { z } from "zod/v4";
import { evaluateDiversificationContribution, DiversificationInputsSchema } from "./diversificationContribution.engine";
import { evaluateExecutionStressContribution, ExecStressInputsSchema } from "./executionStressContribution.engine";
import { evaluateBehavioralStressContribution, BehStressInputsSchema } from "./behavioralStressContribution.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Contribution Score — composes diversification (positive) and execution +
// behavioral stress (negative) into ONE per-strategy ecosystem-contribution
// number in [-1, +1]. Positive means the strategy is a NET BENEFIT to the
// ecosystem; negative means it is a net cost.
//
// Profit alone does NOT enter this score. Ecosystem health > isolated profit.
// ═══════════════════════════════════════════════════════════════════════════

export const ContributionInputsSchema = z.object({
  strategyId: z.string().min(1),
  diversification: DiversificationInputsSchema,
  executionStress: ExecStressInputsSchema,
  behavioralStress: BehStressInputsSchema,
});
export type ContributionInputs = z.infer<typeof ContributionInputsSchema>;

export interface ContributionScore {
  strategyId: string;
  score: number; // -1..+1
  netBenefit: boolean;
  components: {
    diversification01: number;
    executionStress01: number;
    behavioralStress01: number;
  };
  triggers: string[];
  reasons: string[];
}

export function computeContributionScore(i: ContributionInputs): ContributionScore {
  const div = evaluateDiversificationContribution(i.diversification);
  const exe = evaluateExecutionStressContribution(i.executionStress);
  const beh = evaluateBehavioralStressContribution(i.behavioralStress);
  const score = Math.max(-1, Math.min(1,
    div.contribution01 * 0.55 - exe.stress01 * 0.20 - beh.stress01 * 0.25,
  ));
  return {
    strategyId: i.strategyId,
    score,
    netBenefit: score > 0,
    components: {
      diversification01: div.contribution01,
      executionStress01: exe.stress01,
      behavioralStress01: beh.stress01,
    },
    triggers: [...exe.triggers, ...beh.triggers],
    reasons: [`contribution=${score.toFixed(3)} (div ${div.contribution01.toFixed(2)}, exec -${exe.stress01.toFixed(2)}, beh -${beh.stress01.toFixed(2)})`],
  };
}
