import {
  type ClosedTradeRecord, type RiskRating, type RiskVerdict,
  RETROSPECTIVE_THRESHOLDS,
} from "./retrospective.types";

// computeRiskSizing
//
// Pure: was the position size justified by the conviction?
//
// Verdict rule:
//  • Trade lost AND riskMultiplier > 1.5×       → TOO_LARGE
//  • Trade won big (≥1.5R) AND riskMultiplier < 0.6× → TOO_SMALL
//  • Trade lost AND risk was at policy ceiling  → TOO_LARGE (policy may need tightening)
//  • Otherwise                                  → APPROPRIATE
//
// suggestedRiskPct is the policy-justified size given the actual confidence:
//   suggestedPct = baselinePct × (confidence / 60)  capped at maxAllowedRiskPct
// This is the post-hoc "what should have been sized given what we knew at
// entry" reference. The verdict compares actual taken vs this reference.
export function computeRiskSizing(rec: ClosedTradeRecord): RiskVerdict {
  const T = RETROSPECTIVE_THRESHOLDS.risk;
  const reasons: string[] = [];

  const baseline = rec.risk.baselineRiskPct;
  const maxAllowed = rec.risk.maxAllowedRiskPct;
  const taken = rec.risk.riskAsPctOfBalance;
  const multiplier = rec.risk.riskMultiplierUsed;
  const conf = rec.consensus.consensusConfidence;

  let suggestedRiskPct = baseline > 0
    ? Math.min(maxAllowed, baseline * (conf / 60))
    : 0;
  if (suggestedRiskPct < 0 || !Number.isFinite(suggestedRiskPct)) suggestedRiskPct = baseline;

  let rating: RiskRating;

  // INSUFFICIENT_DATA when we don't have a baseline to compare against.
  if (baseline <= 0 || maxAllowed <= 0) {
    reasons.push("baseline or max-allowed risk policy not recorded — cannot judge sizing");
    return {
      rating: "INSUFFICIENT_DATA",
      riskTakenPct: taken, suggestedRiskPct: 0, riskMultiplierUsed: multiplier, reasons,
    };
  }

  const lost = rec.outcome.pnlR < 0;
  const wonBig = rec.outcome.pnlR >= 1.5;
  const atCeiling = taken >= maxAllowed * 0.95;

  if (lost && multiplier >= T.tooLargeMultiplier) {
    rating = "TOO_LARGE";
    reasons.push(`lost ${rec.outcome.pnlR.toFixed(2)}R with risk multiplier ${multiplier.toFixed(2)}× (≥ ${T.tooLargeMultiplier}× threshold)`);
  } else if (lost && atCeiling) {
    rating = "TOO_LARGE";
    reasons.push(`lost ${rec.outcome.pnlR.toFixed(2)}R while sized at policy ceiling (${taken.toFixed(2)}% of balance)`);
  } else if (wonBig && multiplier <= T.tooSmallMultiplier) {
    rating = "TOO_SMALL";
    reasons.push(`won ${rec.outcome.pnlR.toFixed(2)}R cleanly but only sized at ${multiplier.toFixed(2)}× baseline — left edge unmonetized`);
  } else {
    rating = "APPROPRIATE";
    reasons.push(`risk taken ${taken.toFixed(2)}% (mult ${multiplier.toFixed(2)}×) vs suggested ${suggestedRiskPct.toFixed(2)}% — within tolerance for outcome ${rec.outcome.pnlR.toFixed(2)}R`);
  }

  return { rating, riskTakenPct: taken, suggestedRiskPct, riskMultiplierUsed: multiplier, reasons };
}
