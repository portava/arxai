import {
  type ClosedTradeRecord, type EntryVerdict, type QualityRating,
  RETROSPECTIVE_THRESHOLDS,
} from "./retrospective.types";

// computeEntryQuality
//
// Pure: judges entry timing/conditions independent of final outcome.
// A "good entry" is one that immediately moved favorable with shallow
// drawdown — that proves the timing was right even if exit later mishandled
// the trade. Final pnlR is intentionally NOT a factor here (that's exit
// quality's job).
//
// Factors:
//  • immediateMfeProgress — did we get ≥ 0.5R favorable inside the first
//    25% of trade duration? Strong evidence of good timing.
//  • mae depth — did the trade go deep against us early? Evidence of
//    rushed entry into a still-developing move.
//  • spread normality — did we pay an elevated spread tax to enter?
//  • bias alignment — was short-term bias actually with us at entry?
export function computeEntryQuality(rec: ClosedTradeRecord): EntryVerdict {
  const T = RETROSPECTIVE_THRESHOLDS.entry;
  const reasons: string[] = [];
  let score = 50;

  // Immediate MFE progress is approximated by checking when MFE peaked. If
  // the peak landed inside the early-window fraction, we credit "immediate
  // progress" with the full MFE. Otherwise we credit nothing on this axis.
  // (We don't have a per-tick replay here — only the peak fraction and
  // peak magnitude are recorded.)
  let immediateMfeProgressR = 0;
  if (rec.intra.mfePeakAtFraction <= T.immediateProgressFraction) {
    immediateMfeProgressR = rec.intra.maxFavorableExcursionR;
  }
  if (immediateMfeProgressR >= T.goodImmediateMfeR) {
    score += 25;
    reasons.push(`+25 from immediate progress (${immediateMfeProgressR.toFixed(2)}R MFE within first ${(T.immediateProgressFraction * 100).toFixed(0)}%)`);
  } else if (rec.intra.mfePeakAtFraction <= T.immediateProgressFraction
             && immediateMfeProgressR <= T.poorImmediateMfeR) {
    score -= 15;
    reasons.push(`-15 — early window produced no favorable progress`);
  }

  // MAE depth penalty
  const maeMag = Math.abs(rec.intra.maxAdverseExcursionR);
  if (maeMag >= T.poorMaeR) {
    score -= 20;
    reasons.push(`-20 from deep MAE (${maeMag.toFixed(2)}R against us at worst)`);
  } else if (maeMag <= 0.2) {
    score += 10;
    reasons.push(`+10 from shallow MAE (${maeMag.toFixed(2)}R)`);
  }

  // Spread tax at entry — only judged when we have a baseline. Without a
  // baseline this factor stays neutral rather than guessing.
  let spreadAtEntryNormality = 1.0;
  if (rec.entryConditions.spreadPipsAtEntry > 0) {
    // We approximate normality by comparing to "what the system uses as
    // its slippage budget pip baseline" — caller would normally inject
    // that. Here we use a soft proxy: anything ≥ 8 pips on a synthetic
    // index is elevated. Without a true baseline we keep this conservative.
    spreadAtEntryNormality = rec.entryConditions.spreadPipsAtEntry >= 8 ? 2.5
                            : rec.entryConditions.spreadPipsAtEntry >= 4 ? 1.5
                            : 1.0;
    if (spreadAtEntryNormality >= T.elevatedSpreadRatio) {
      score -= 10;
      reasons.push(`-10 from elevated spread tax at entry (${rec.entryConditions.spreadPipsAtEntry.toFixed(1)} pips)`);
    }
  }

  // Bias alignment — bonus when we entered with the short-term bias
  if (rec.entryConditions.shortTermBiasAlignedAtEntry === true) {
    score += 10;
    reasons.push(`+10 — entry aligned with short-term bias`);
  } else if (rec.entryConditions.shortTermBiasAlignedAtEntry === false) {
    score -= 10;
    reasons.push(`-10 — entry against short-term bias (counter-trend)`);
  }

  score = clamp(score, 0, 100);

  // INSUFFICIENT_DATA when we have neither MFE peak signal nor a meaningful
  // MAE — the trade closed too fast to derive timing quality.
  let rating: QualityRating;
  if (rec.intra.maxFavorableExcursionR === 0 && maeMag === 0) {
    rating = "INSUFFICIENT_DATA";
    reasons.push("trade closed before MFE/MAE could develop — entry quality unjudgeable");
  } else if (score >= 65) {
    rating = "GOOD";
  } else if (score >= 40) {
    rating = "MIXED";
  } else {
    rating = "POOR";
  }

  return {
    rating, score,
    factors: {
      immediateMfeProgressR,
      mae: maeMag,
      spreadAtEntryNormality,
      biasAlignment: rec.entryConditions.shortTermBiasAlignedAtEntry,
    },
    reasons,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
