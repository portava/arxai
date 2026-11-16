import type {
  ComparisonClass, OutcomeComparison, OutcomeJudgment, ShadowSummary,
} from "./shadowLab.types";

// shadowAggregator — roll up many OutcomeComparisons into a ShadowSummary.
// Net edge = sum of (candidate − baseline) per pair, expressed in R.
export function summarizeShadowOutcomes(outcomes: OutcomeComparison[]): ShadowSummary {
  const reasons: string[] = [];
  const byClass: Partial<Record<ComparisonClass, number>> = {};
  const byJudgment: Partial<Record<OutcomeJudgment, number>> = {};

  let candidateNetEdgeR = 0;
  let candidateAvoidedLosersCount = 0;
  let candidateMissedWinnersCount = 0;

  for (const o of outcomes) {
    byClass[o.comparisonClass] = (byClass[o.comparisonClass] ?? 0) + 1;
    byJudgment[o.judgment] = (byJudgment[o.judgment] ?? 0) + 1;
    candidateNetEdgeR += o.candidateEdgeR;
    if (o.judgment === "CANDIDATE_AVOIDED_LOSER") candidateAvoidedLosersCount++;
    if (o.judgment === "CANDIDATE_MISSED_WINNER") candidateMissedWinnersCount++;
  }

  reasons.push(
    `${outcomes.length} pair(s); candidate net edge ${candidateNetEdgeR.toFixed(2)}R; ` +
    `avoided ${candidateAvoidedLosersCount} losers, missed ${candidateMissedWinnersCount} winners`,
  );

  return {
    totalPairs: outcomes.length,
    byClass, byJudgment,
    candidateNetEdgeR,
    candidateAvoidedLosersCount,
    candidateMissedWinnersCount,
    reasons,
  };
}
