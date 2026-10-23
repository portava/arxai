import { simulateCounterfactual } from "./simulateCounterfactual";
import {
  type DeclineQAContext, type QWouldWinAnswer, DECISION_QA_THRESHOLDS,
} from "./decisionQA.types";

// Q2: Would this trade have won?
//
// Direct mapping from the simulation verdict:
//   TP_HIT_FIRST           → WOULD_HAVE_WON (high confidence)
//   SL_HIT_FIRST           → WOULD_HAVE_LOST (high confidence)
//   BOTH_TOUCHED_AMBIGUOUS → WOULD_HAVE_LOST (medium — conservative bias:
//                            without bar-order data, prefer claiming a loss
//                            we didn't take over claiming a win we didn't have)
//   NEITHER_TOUCHED        → WOULD_HAVE_WON / WOULD_HAVE_SCRATCHED /
//                            WOULD_HAVE_LOST based on end-of-window pnl
//                            with neutral-band scratch zone
//   WINDOW_TOO_SHORT       → INSUFFICIENT_EVIDENCE
export function wouldThisTradeHaveWon(ctx: DeclineQAContext): QWouldWinAnswer {
  const T = DECISION_QA_THRESHOLDS;
  const sim = simulateCounterfactual(ctx.setup, ctx.postDeclineWindow);

  if (!sim.windowAdequate) {
    return { verdict: "INSUFFICIENT_EVIDENCE", confidence: 0, evidence: sim, reasons: [...sim.reasons] };
  }

  const pnl = sim.simulatedPnlR;
  switch (sim.simVerdict) {
    case "TP_HIT_FIRST":
      return { verdict: "WOULD_HAVE_WON", confidence: 95, evidence: sim,
        reasons: [...sim.reasons, `clean TP hit → +${pnl.toFixed(2)}R`] };
    case "SL_HIT_FIRST":
      return { verdict: "WOULD_HAVE_LOST", confidence: 95, evidence: sim,
        reasons: [...sim.reasons, `clean SL hit → ${pnl.toFixed(2)}R`] };
    case "BOTH_TOUCHED_AMBIGUOUS":
      return { verdict: "WOULD_HAVE_LOST", confidence: 60, evidence: sim,
        reasons: [...sim.reasons, "both levels touched — conservatively WOULD_HAVE_LOST (low confidence)"] };
    case "NEITHER_TOUCHED": {
      if (Math.abs(pnl) <= T.neutralBandR) {
        return { verdict: "WOULD_HAVE_SCRATCHED", confidence: 60, evidence: sim,
          reasons: [...sim.reasons, `end pnl ${pnl.toFixed(2)}R within ±${T.neutralBandR}R scratch zone`] };
      }
      if (pnl > 0) {
        return { verdict: "WOULD_HAVE_WON", confidence: Math.min(80, 40 + pnl * 30), evidence: sim,
          reasons: [...sim.reasons, `end pnl +${pnl.toFixed(2)}R favorable but no TP hit`] };
      }
      return { verdict: "WOULD_HAVE_LOST", confidence: Math.min(80, 40 + Math.abs(pnl) * 30), evidence: sim,
        reasons: [...sim.reasons, `end pnl ${pnl.toFixed(2)}R adverse but no SL hit`] };
    }
    case "WINDOW_TOO_SHORT":
      // Already handled by !windowAdequate guard, but exhaustive switch.
      return { verdict: "INSUFFICIENT_EVIDENCE", confidence: 0, evidence: sim, reasons: [...sim.reasons] };
  }
}
