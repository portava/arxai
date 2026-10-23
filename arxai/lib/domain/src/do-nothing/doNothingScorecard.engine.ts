import type {
  CounterfactualOutcome, CounterfactualVerdict, DeclineKind,
  DoNothingScorecard, NoTradeRecord,
} from "./doNothing.types";

// doNothingScorecard — aggregate decline records + counterfactual outcomes
// into a single scorecard. INSUFFICIENT_WINDOW outcomes are counted but
// excluded from R sums (no judgment).
export function buildDoNothingScorecard(
  records: NoTradeRecord[],
  outcomes: CounterfactualOutcome[],
): DoNothingScorecard {
  const reasons: string[] = [];
  const byKind: Partial<Record<DeclineKind, number>> = {};
  const byVerdict: Partial<Record<CounterfactualVerdict, number>> = {};

  for (const r of records) {
    byKind[r.declineKind] = (byKind[r.declineKind] ?? 0) + 1;
  }

  let preventedRSum = 0;
  let missedRSum = 0;
  for (const o of outcomes) {
    byVerdict[o.verdict] = (byVerdict[o.verdict] ?? 0) + 1;
    if (o.verdict === "INSUFFICIENT_WINDOW") continue;
    preventedRSum += o.estimatedPreventedR;
    missedRSum += o.estimatedMissedR;
  }

  const netDoNothingEdgeR = preventedRSum - missedRSum;
  reasons.push(
    `${records.length} declines; prevented ${preventedRSum.toFixed(2)}R, missed ${missedRSum.toFixed(2)}R, ` +
    `net no-trade edge ${netDoNothingEdgeR.toFixed(2)}R`,
  );

  return {
    totalDeclines: records.length,
    byKind, byVerdict,
    preventedRSum, missedRSum, netDoNothingEdgeR,
    reasons,
  };
}
