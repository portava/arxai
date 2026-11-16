import {
  type CalibrationRating, type ClosedTradeRecord, type ConfidenceVerdict,
  RETROSPECTIVE_THRESHOLDS,
} from "./retrospective.types";

// computeConfidenceCalibration
//
// Pure: SINGLE-TRADE calibration verdict. Real calibration requires sample
// size — one trade is one data point. To stay honest, this engine ONLY
// fires a verdict on extremes (very high confidence + clear loss, or very
// low confidence + clean win). Everything else is INSUFFICIENT_DATA. The
// reason strings make this explicit so downstream aggregators don't treat
// a per-trade verdict as a calibration conclusion.
export function computeConfidenceCalibration(rec: ClosedTradeRecord): ConfidenceVerdict {
  const T = RETROSPECTIVE_THRESHOLDS.confidence;
  const reasons: string[] = [];
  const conf = rec.consensus.consensusConfidence;
  const won = rec.outcome.pnlR > 0;
  const outcomeOneIfWin: 0 | 1 = won ? 1 : 0;

  // Calibration "gap" — positive = confident & lost; negative = unconfident & won.
  // gap = confidence − (won ? 100 : 0), bounded.
  const gap = conf - (won ? 100 : 0);

  let rating: CalibrationRating = "INSUFFICIENT_DATA";

  // ── Strong overconfidence signal ───────────────────────────────────────
  if (!won && conf >= T.overconfidentLossThreshold) {
    rating = "TOO_HIGH";
    reasons.push(`confidence was ${conf}% — high — and trade lost (${rec.outcome.pnlR.toFixed(2)}R)`);
    reasons.push("(single-trade signal — calibration verdict requires aggregation across trades)");
  }
  // ── Strong underconfidence signal ──────────────────────────────────────
  else if (won && conf <= T.underconfidentWinThreshold && rec.outcome.pnlR >= T.cleanWinR) {
    rating = "TOO_LOW";
    reasons.push(`confidence was ${conf}% — low — and trade won cleanly (${rec.outcome.pnlR.toFixed(2)}R)`);
    reasons.push("(single-trade signal — calibration verdict requires aggregation across trades)");
  }
  // ── Well-calibrated (mid-confidence ↔ marginal outcome, OR high conf + win) ─
  else if (
    (conf >= 60 && won && rec.outcome.pnlR >= 0.5) ||
    (conf < 50 && !won && rec.outcome.pnlR > -1.0)
  ) {
    rating = "WELL_CALIBRATED";
    reasons.push(`confidence ${conf}% directionally matched the outcome (${rec.outcome.pnlR.toFixed(2)}R)`);
    reasons.push("(single-trade signal — well-calibrated by inspection, not a population conclusion)");
  } else {
    reasons.push(`confidence ${conf}% with outcome ${rec.outcome.pnlR.toFixed(2)}R — neither extreme`);
    reasons.push("calibration verdict deferred — single-trade evidence is insufficient");
  }

  return {
    rating,
    originalConfidence: conf,
    outcomeOneIfWin,
    gap,
    reasons,
  };
}
