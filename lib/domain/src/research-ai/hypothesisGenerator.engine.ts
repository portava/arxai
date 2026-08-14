import type { Hypothesis, HypothesisGeneratorPort } from "./researchAi.types";
import { rankHypotheses, scoreHypothesis, type ScoringContext } from "./hypothesisScoring.engine";

export interface ResearchRunResult {
  hypotheses: Hypothesis[];
  rankedByComposite: { hypothesisId: string; composite01: number }[];
  reasons: string[];
}

// runResearch — orchestrate Port call + pure scoring + ranking.
// Research AI never executes; this just produces hypotheses to feed the
// strategy-pipeline at the HYPOTHESIS stage.
export async function runResearch(
  port: HypothesisGeneratorPort,
  input: { marketContext: string; existingStrategyIds: string[]; maxToReturn: number },
  scoringCtx: ScoringContext,
): Promise<ResearchRunResult> {
  const reasons: string[] = [];
  if (input.maxToReturn <= 0) {
    reasons.push("maxToReturn ≤ 0 — returning empty");
    return { hypotheses: [], rankedByComposite: [], reasons };
  }
  const hypotheses = await port.proposeHypotheses(input);
  reasons.push(`port returned ${hypotheses.length} hypothesis(es)`);
  const scored = hypotheses.map((h) => scoreHypothesis(h, scoringCtx));
  const ranked = rankHypotheses(scored);
  return {
    hypotheses,
    rankedByComposite: ranked.map((s) => ({ hypothesisId: s.hypothesisId, composite01: s.composite01 })),
    reasons,
  };
}
