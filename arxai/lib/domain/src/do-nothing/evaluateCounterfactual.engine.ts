import {
  type CounterfactualOutcome, type CounterfactualVerdict,
  type NoTradeRecord, type PostDeclinePriceWindow,
  DO_NOTHING_THRESHOLDS,
} from "./doNothing.types";

// evaluateCounterfactual — given a decline record + price action since,
// estimate what would have happened if we'd actually traded.
//
// Convention: caller passes priceWindow with all prices in the same units
// AND a `riskPerUnit` factor that converts a 1R move (in price units) into
// the multiplier needed for our "estimated R" calculation.
//
// The MFE / MAE from the decline price determine the counterfactual:
//   • If proposed BUY: MFE = high − price, MAE = price − low
//   • If proposed SELL: MFE = price − low, MAE = high − price
//
// Verdict matrix: prevented = max(MAE / riskPerUnit, 0); missed = max(MFE / riskPerUnit, 0).
// Net = missed − prevented; if abs(net) ≤ neutralBandR → NEUTRAL, else
// the larger side wins.
export function evaluateCounterfactual(
  record: NoTradeRecord,
  window: PostDeclinePriceWindow,
  riskPerUnit: number = DO_NOTHING_THRESHOLDS.defaultRiskPerUnitPipDistance,
): CounterfactualOutcome {
  const reasons: string[] = [];
  const T = DO_NOTHING_THRESHOLDS;

  if (window.windowSeconds < T.minWindowSeconds) {
    reasons.push(`window ${window.windowSeconds}s < min ${T.minWindowSeconds}s — not enough data yet`);
    return {
      noTradeId: record.noTradeId, verdict: "INSUFFICIENT_WINDOW",
      estimatedPreventedR: 0, estimatedMissedR: 0, reasons,
    };
  }

  if (record.proposedDirection === null) {
    reasons.push("no proposed direction — pure 'no setup' decline; treat as NEUTRAL");
    return {
      noTradeId: record.noTradeId, verdict: "DECLINE_NEUTRAL",
      estimatedPreventedR: 0, estimatedMissedR: 0, reasons,
    };
  }
  if (riskPerUnit <= 0) {
    reasons.push("invalid riskPerUnit ≤ 0 — cannot compute R; treating as INSUFFICIENT");
    return {
      noTradeId: record.noTradeId, verdict: "INSUFFICIENT_WINDOW",
      estimatedPreventedR: 0, estimatedMissedR: 0, reasons,
    };
  }

  const dir = record.proposedDirection;
  const px = window.priceAtDecline;
  const mfePrice = dir === "BUY" ? Math.max(0, window.highSinceDecline - px) : Math.max(0, px - window.lowSinceDecline);
  const maePrice = dir === "BUY" ? Math.max(0, px - window.lowSinceDecline)  : Math.max(0, window.highSinceDecline - px);

  const missedR    = mfePrice / riskPerUnit;
  const preventedR = maePrice / riskPerUnit;
  const netR = missedR - preventedR;

  let verdict: CounterfactualVerdict;
  if (Math.abs(netR) <= T.neutralBandR) {
    verdict = "DECLINE_NEUTRAL";
    reasons.push(`net ${netR.toFixed(2)}R within neutral band ±${T.neutralBandR}R`);
  } else if (netR < 0) {
    verdict = "DECLINE_WAS_RIGHT";
    reasons.push(`prevented ${preventedR.toFixed(2)}R loss, missed ${missedR.toFixed(2)}R upside — decline was right by ${(-netR).toFixed(2)}R`);
  } else {
    verdict = "DECLINE_WAS_WRONG";
    reasons.push(`missed ${missedR.toFixed(2)}R upside, prevented ${preventedR.toFixed(2)}R — decline was wrong by ${netR.toFixed(2)}R`);
  }

  return {
    noTradeId: record.noTradeId, verdict,
    estimatedPreventedR: preventedR,
    estimatedMissedR: missedR,
    reasons,
  };
}
