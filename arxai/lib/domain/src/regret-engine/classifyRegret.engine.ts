import {
  type RegretInput, type RegretKind, type RegretRecord,
  REGRET_THRESHOLDS,
} from "./regretEngine.types";

// classifyRegret — given the action taken + the outcome, pick a RegretKind
// and compute regret magnitude (in R).
//
// Cross product (using ±0.20R neutral band for win/loss/scratch):
//   APPROVE_FULL    + LOSS     → REGRET_TAKING_LOSER       (magnitude = |pnlR|)
//   APPROVE_FULL    + WIN/scr  → NO_REGRET                 (vindicated; magnitude 0)
//   APPROVE_REDUCED + WIN      → REGRET_REDUCING_WINNER    (magnitude ≈ pnlR ÷ ratio of foregone)
//                                                          here we use pnlR as the regret unit
//                                                          since the caller knows the size ratio
//   APPROVE_REDUCED + LOSS/scr → NO_REGRET                 (damage was limited)
//   REJECT          + cf WIN   → REGRET_BLOCKING_WINNER    (magnitude = pnlR)
//   REJECT          + cf LOSS/scr → NO_REGRET              (block vindicated)
export function classifyRegret(input: RegretInput): RegretRecord {
  const T = REGRET_THRESHOLDS;
  const reasons: string[] = [];
  const pnl = input.outcomePnlR;
  const won  = pnl >  T.neutralBandR;
  const lost = pnl < -T.neutralBandR;

  let regretKind: RegretKind = "NO_REGRET";
  let regretMagnitudeR = 0;

  switch (input.action) {
    case "APPROVE_FULL":
      if (lost) {
        regretKind = "REGRET_TAKING_LOSER";
        regretMagnitudeR = Math.abs(pnl);
        reasons.push(`took full size, lost ${pnl.toFixed(2)}R — regret magnitude ${regretMagnitudeR.toFixed(2)}R`);
      } else {
        reasons.push(`took full size, ${won ? "won" : "scratched"} ${pnl.toFixed(2)}R — vindicated`);
      }
      break;
    case "APPROVE_REDUCED":
      if (won) {
        regretKind = "REGRET_REDUCING_WINNER";
        regretMagnitudeR = pnl;       // foregone upside per unit reduced (caller knows ratio)
        reasons.push(`reduced size, won ${pnl.toFixed(2)}R — left money on the table`);
      } else {
        reasons.push(`reduced size, ${lost ? "lost" : "scratched"} ${pnl.toFixed(2)}R — damage limited`);
      }
      break;
    case "REJECT":
      if (!input.outcomeWasCounterfactual) {
        // REJECT outcomes MUST be counterfactual — there's no realized pnl
        // for a trade that was never taken. Refuse to classify rather than
        // corrupt the regret ledger and downstream calibration inputs.
        reasons.push("REJECT requires outcomeWasCounterfactual=true; refusing to classify — NO_REGRET");
        break;
      }
      if (won) {
        regretKind = "REGRET_BLOCKING_WINNER";
        regretMagnitudeR = pnl;
        reasons.push(`blocked, counterfactual would have won ${pnl.toFixed(2)}R — missed winner`);
      } else {
        reasons.push(`blocked, counterfactual ${lost ? "lost" : "scratched"} ${pnl.toFixed(2)}R — block vindicated`);
      }
      break;
  }

  return { ...input, regretKind, regretMagnitudeR, reasons };
}
