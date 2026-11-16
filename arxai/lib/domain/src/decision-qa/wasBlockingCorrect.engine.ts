import { simulateCounterfactual } from "./simulateCounterfactual";
import {
  type DeclineQAContext, type QBlockAnswer, DECISION_QA_THRESHOLDS,
} from "./decisionQA.types";

// Q1: Was blocking this trade correct?
//
// Logic:
//   • simulate the trade we did NOT take
//   • if simulated pnl < −neutralBand → BLOCK_WAS_CORRECT (we'd have lost)
//   • if simulated pnl > +neutralBand → BLOCK_WAS_WRONG    (we'd have won)
//   • |pnl| ≤ neutralBand              → INCONCLUSIVE
//   • !windowAdequate                  → INSUFFICIENT_EVIDENCE
//
// Confidence scales with magnitude: bigger hypothetical move = stronger
// evidence the block was right or wrong. Capped at 100.
export function wasBlockingCorrect(ctx: DeclineQAContext): QBlockAnswer {
  const T = DECISION_QA_THRESHOLDS;
  const sim = simulateCounterfactual(ctx.setup, ctx.postDeclineWindow);

  if (!sim.windowAdequate) {
    return {
      verdict: "INSUFFICIENT_EVIDENCE", confidence: 0, evidence: sim,
      reasons: [...sim.reasons, "cannot judge block correctness without sufficient window"],
    };
  }

  const pnl = sim.simulatedPnlR;
  if (Math.abs(pnl) <= T.neutralBandR) {
    return {
      verdict: "INCONCLUSIVE", confidence: 30, evidence: sim,
      reasons: [...sim.reasons, `|${pnl.toFixed(2)}R| ≤ ±${T.neutralBandR}R neutral band — cannot say either way`],
    };
  }

  if (pnl < 0) {
    const conf = Math.min(100, 50 + Math.abs(pnl) * 30);
    return {
      verdict: "BLOCK_WAS_CORRECT", confidence: conf, evidence: sim,
      reasons: [...sim.reasons, `hypothetical loss ${pnl.toFixed(2)}R — block saved us from a losing trade`],
    };
  }
  const conf = Math.min(100, 50 + pnl * 30);
  return {
    verdict: "BLOCK_WAS_WRONG", confidence: conf, evidence: sim,
    reasons: [...sim.reasons, `hypothetical win +${pnl.toFixed(2)}R — block cost us a winning trade`],
  };
}
