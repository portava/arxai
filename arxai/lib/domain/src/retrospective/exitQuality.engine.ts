import {
  type ClosedTradeRecord, type ExitVerdict, type QualityRating,
  RETROSPECTIVE_THRESHOLDS,
} from "./retrospective.types";

// computeExitQuality
//
// Pure: judges how well we captured the favorable move.
//   • capturedPctOfMfe = pnlR / mfeR when mfeR > 0
//   • leftOnTableR    = mfe − pnl (≥ 0; how much further the trade went vs what we banked)
//
// Special cases:
//  • Trade hit TP exactly → exit quality = GOOD by definition (we set the
//    target, we got it).
//  • Trade hit SL with zero MFE → INSUFFICIENT_DATA (no opportunity to
//    capture; this is an entry/stop-placement question, not an exit one).
//  • Trade was closed by EMERGENCY_KILL → MIXED (system-driven, not a
//    discretionary exit decision).
export function computeExitQuality(rec: ClosedTradeRecord): ExitVerdict {
  const T = RETROSPECTIVE_THRESHOLDS.exit;
  const reasons: string[] = [];

  const mfe = rec.intra.maxFavorableExcursionR;
  const exitedAtR = rec.outcome.pnlR;
  const leftOnTableR = Math.max(0, mfe - exitedAtR);
  const capturedPctOfMfe = mfe > 0 ? Math.max(0, Math.min(100, (exitedAtR / mfe) * 100)) : null;

  // ── Special-case: TP hit ────────────────────────────────────────────────
  if (rec.outcome.exitReason === "TAKE_PROFIT") {
    reasons.push(`TP hit cleanly at ${exitedAtR.toFixed(2)}R — exit by design`);
    if (leftOnTableR >= T.leftOnTableR) {
      // Even a TP hit can leave a lot on the table if MFE blew past it.
      // That's a target-setting issue, not an exit-management one — note it.
      reasons.push(`(note: MFE went ${mfe.toFixed(2)}R, ${leftOnTableR.toFixed(2)}R left on table — consider wider TP/runner)`);
    }
    return { rating: "GOOD", capturedPctOfMfe, exitedAtR, exitReason: rec.outcome.exitReason, leftOnTableR, reasons };
  }

  // ── Special-case: SL hit with no MFE ────────────────────────────────────
  if (rec.outcome.exitReason === "STOP_LOSS" && mfe <= 0.05) {
    reasons.push(`stopped out with no favorable progress (MFE ${mfe.toFixed(2)}R) — this is an entry-quality question, not exit-quality`);
    return { rating: "INSUFFICIENT_DATA", capturedPctOfMfe: null, exitedAtR, exitReason: rec.outcome.exitReason, leftOnTableR: 0, reasons };
  }

  // ── Special-case: kill switch ───────────────────────────────────────────
  if (rec.outcome.exitReason === "EMERGENCY_KILL") {
    reasons.push("closed by emergency kill switch — system-driven, not a discretionary exit");
    return { rating: "MIXED", capturedPctOfMfe, exitedAtR, exitReason: rec.outcome.exitReason, leftOnTableR, reasons };
  }

  // ── General case: judge by capture % and absolute leftover ─────────────
  if (capturedPctOfMfe === null) {
    reasons.push(`MFE was ${mfe.toFixed(2)}R — no positive capture window`);
    return { rating: "POOR", capturedPctOfMfe, exitedAtR, exitReason: rec.outcome.exitReason, leftOnTableR, reasons };
  }

  let rating: QualityRating;
  if (capturedPctOfMfe >= T.goodCapturePct && leftOnTableR < T.leftOnTableR) {
    rating = "GOOD";
    reasons.push(`captured ${capturedPctOfMfe.toFixed(0)}% of MFE (${mfe.toFixed(2)}R), left ${leftOnTableR.toFixed(2)}R on table`);
  } else if (capturedPctOfMfe <= T.poorCapturePct || leftOnTableR >= T.leftOnTableR * 2) {
    rating = "POOR";
    reasons.push(`captured only ${capturedPctOfMfe.toFixed(0)}% of MFE (${mfe.toFixed(2)}R) — left ${leftOnTableR.toFixed(2)}R on table`);
  } else {
    rating = "MIXED";
    reasons.push(`captured ${capturedPctOfMfe.toFixed(0)}% of MFE — neither great nor terrible`);
  }

  if (rec.outcome.exitReason === "MANUAL_EXIT" && rating !== "GOOD") {
    reasons.push("exit was manual — discretionary decision contributed to suboptimal capture");
  }
  if (rec.outcome.exitReason === "TIME_STOP") {
    reasons.push("closed by time stop — duration limit reached");
  }
  if (rec.outcome.exitReason === "TRAIL_STOP" && rating === "GOOD") {
    reasons.push("trailing stop did its job");
  }

  return { rating, capturedPctOfMfe, exitedAtR, exitReason: rec.outcome.exitReason, leftOnTableR, reasons };
}
