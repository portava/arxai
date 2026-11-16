import type {
  OutcomeComparison, OutcomeJudgment, PairClassification, PairOutcomeInput,
} from "./shadowLab.types";

// classifyOutcome — once the trade closes, judge whether the candidate
// (V2) actually beat the baseline (V1). Inputs:
//   • the prior PairClassification
//   • realized pnlR for whichever side executed; the other side's pnlR
//     is the caller's counterfactual estimate (e.g. same direction at
//     proportional size assumes same outcome scaled).
//
// Ambiguity rule: |pnl| ≤ 0.20R counts as "near zero" — outcomes within
// noise produce TIE rather than over-claiming a win for either side.
export function classifyOutcome(
  cls: PairClassification,
  pnl: PairOutcomeInput,
): OutcomeComparison {
  const reasons: string[] = [];
  const eps = 0.20;
  const baseWon = pnl.baselinePnlR > eps;
  const baseLost = pnl.baselinePnlR < -eps;
  const candWon = pnl.candidatePnlR > eps;
  const candLost = pnl.candidatePnlR < -eps;
  const candidateEdgeR = pnl.candidatePnlR - pnl.baselinePnlR;

  let judgment: OutcomeJudgment;
  switch (cls.comparisonClass) {
    case "CONCURRED_TRADED":
      judgment = baseWon && candWon ? "CONCURRED_RIGHT"
        : baseLost && candLost ? "CONCURRED_WRONG"
        : "TIE";
      reasons.push(`both traded — baseline ${pnl.baselinePnlR.toFixed(2)}R, candidate ${pnl.candidatePnlR.toFixed(2)}R`);
      break;
    case "CONCURRED_BLOCKED":
      judgment = "CONCURRED_RIGHT";
      reasons.push("both blocked — by definition concurred");
      break;
    case "BASELINE_TRADED_CANDIDATE_BLOCKED":
      judgment = baseLost ? "CANDIDATE_AVOIDED_LOSER"
        : baseWon ? "CANDIDATE_MISSED_WINNER" : "TIE";
      reasons.push(`baseline ran ${pnl.baselinePnlR.toFixed(2)}R, candidate stayed flat`);
      break;
    case "CANDIDATE_TRADED_BASELINE_BLOCKED":
      judgment = candLost ? "BASELINE_AVOIDED_LOSER"
        : candWon ? "BASELINE_MISSED_WINNER" : "TIE";
      reasons.push(`candidate ran ${pnl.candidatePnlR.toFixed(2)}R, baseline stayed flat`);
      break;
    case "BASELINE_FULL_CANDIDATE_REDUCED":
      judgment = baseLost ? "CANDIDATE_DAMAGE_REDUCED"
        : baseWon ? "CANDIDATE_LEFT_MONEY" : "TIE";
      reasons.push(`baseline full vs candidate reduced — pnls ${pnl.baselinePnlR.toFixed(2)}R / ${pnl.candidatePnlR.toFixed(2)}R`);
      break;
    case "CANDIDATE_FULL_BASELINE_REDUCED":
      judgment = candLost ? "BASELINE_DAMAGE_REDUCED"
        : candWon ? "BASELINE_LEFT_MONEY" : "TIE";
      reasons.push(`candidate full vs baseline reduced — pnls ${pnl.baselinePnlR.toFixed(2)}R / ${pnl.candidatePnlR.toFixed(2)}R`);
      break;
    case "OPPOSITE_DIRECTIONS":
      judgment = candidateEdgeR > eps ? "CANDIDATE_BETTER_DIRECTION"
        : candidateEdgeR < -eps ? "BASELINE_BETTER_DIRECTION" : "TIE";
      reasons.push(`opposite calls — candidate edge ${candidateEdgeR.toFixed(2)}R`);
      break;
  }

  return {
    pairId: cls.pairId,
    comparisonClass: cls.comparisonClass,
    judgment,
    baselinePnlR: pnl.baselinePnlR,
    candidatePnlR: pnl.candidatePnlR,
    candidateEdgeR,
    reasons,
  };
}
