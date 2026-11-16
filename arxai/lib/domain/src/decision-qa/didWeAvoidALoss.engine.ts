import { wouldThisTradeHaveWon } from "./wouldThisTradeHaveWon.engine";
import type { DeclineQAContext, QAvoidedLossAnswer } from "./decisionQA.types";

// Q5: Did we avoid a loss?
//
// Delegates to wouldThisTradeHaveWon (single source of truth for sim).
// Mapping:
//   WOULD_HAVE_LOST       → AVOIDED_LOSS    (yes, we dodged a loser)
//   WOULD_HAVE_WON        → NO_LOSS_TO_AVOID (no — we missed a winner)
//   WOULD_HAVE_SCRATCHED  → INCONCLUSIVE    (would have been ~flat)
//   INSUFFICIENT_EVIDENCE → INSUFFICIENT_EVIDENCE
export function didWeAvoidALoss(ctx: DeclineQAContext): QAvoidedLossAnswer {
  const w = wouldThisTradeHaveWon(ctx);
  switch (w.verdict) {
    case "INSUFFICIENT_EVIDENCE":
      return { verdict: "INSUFFICIENT_EVIDENCE", confidence: 0, evidence: w.evidence, reasons: w.reasons };
    case "WOULD_HAVE_LOST": {
      const magnitude = Math.abs(w.evidence.simulatedPnlR);
      return { verdict: "AVOIDED_LOSS", confidence: w.confidence, evidence: w.evidence,
        reasons: [...w.reasons, `avoided ${magnitude.toFixed(2)}R loss`] };
    }
    case "WOULD_HAVE_WON":
      return { verdict: "NO_LOSS_TO_AVOID", confidence: w.confidence, evidence: w.evidence,
        reasons: [...w.reasons, "trade would have won — no loss avoided"] };
    case "WOULD_HAVE_SCRATCHED":
      return { verdict: "INCONCLUSIVE", confidence: 50, evidence: w.evidence,
        reasons: [...w.reasons, "trade would have scratched — neither lost nor won"] };
  }
}
