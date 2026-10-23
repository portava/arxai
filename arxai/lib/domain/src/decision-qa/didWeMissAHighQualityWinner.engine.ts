import { wouldThisTradeHaveWon } from "./wouldThisTradeHaveWon.engine";
import {
  type DeclineQAContext, type QMissedWinnerAnswer, DECISION_QA_THRESHOLDS,
} from "./decisionQA.types";

// Q6: Did we miss a high-quality winner?
//
// Only meaningful when the counterfactual was a win. Quality threshold:
// simulated pnlR ≥ highQualityWinnerR (default 1.5R).
//
// Mapping:
//   WOULD_HAVE_WON + pnl ≥ 1.5R → MISSED_HIGH_QUALITY_WINNER
//   WOULD_HAVE_WON + pnl < 1.5R → MISSED_SMALL_WINNER
//   anything else (loss/scratch) → NO_WINNER_MISSED
//   INSUFFICIENT_EVIDENCE       → INSUFFICIENT_EVIDENCE
export function didWeMissAHighQualityWinner(ctx: DeclineQAContext): QMissedWinnerAnswer {
  const T = DECISION_QA_THRESHOLDS;
  const w = wouldThisTradeHaveWon(ctx);
  if (w.verdict === "INSUFFICIENT_EVIDENCE") {
    return { verdict: "INSUFFICIENT_EVIDENCE", confidence: 0, evidence: w.evidence, reasons: w.reasons };
  }
  if (w.verdict !== "WOULD_HAVE_WON") {
    return { verdict: "NO_WINNER_MISSED", confidence: w.confidence, evidence: w.evidence,
      reasons: [...w.reasons, `verdict ${w.verdict} — no winner missed`] };
  }
  const pnl = w.evidence.simulatedPnlR;
  if (pnl >= T.highQualityWinnerR) {
    return { verdict: "MISSED_HIGH_QUALITY_WINNER", confidence: w.confidence, evidence: w.evidence,
      reasons: [...w.reasons, `would have won +${pnl.toFixed(2)}R ≥ ${T.highQualityWinnerR}R quality threshold`] };
  }
  return { verdict: "MISSED_SMALL_WINNER", confidence: w.confidence, evidence: w.evidence,
    reasons: [...w.reasons, `would have won +${pnl.toFixed(2)}R < ${T.highQualityWinnerR}R — small winner only`] };
}
