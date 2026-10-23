import {
  type ExecutionQAContext, type QTimingAnswer, DECISION_QA_THRESHOLDS,
} from "./decisionQA.types";

// Q3: Was the entry too early?
//
// "Too early" = a meaningful adverse move occurred AFTER entry — a better
// entry was available later. Operational measure: post-entry MAE ≥ 0.5R.
//
// Note: this question is independent of whether the trade ultimately won.
// A winner with high MAE = "too early but worked out." A loser with high
// MAE = "too early AND wrong." Both are TOO_EARLY answers; consumers
// read realizedPnlR from evidence to interpret.
//
// Defenses:
//   • riskPerUnitPrice ≤ 0          → INCONCLUSIVE
//   • windowSeconds too short       → INCONCLUSIVE
export function wasEntryTooEarly(ctx: ExecutionQAContext): QTimingAnswer {
  const T = DECISION_QA_THRESHOLDS;
  const r = ctx.setup.riskPerUnitPrice;
  const w = ctx.postEntryWindow;

  if (r <= 0 || w.windowSeconds < T.minWindowSeconds) {
    return { verdict: "INCONCLUSIVE", confidence: 0, evidence: { realizedPnlR: ctx.realizedPnlR },
      reasons: ["insufficient post-entry window or invalid riskPerUnitPrice"] };
  }

  const dir = ctx.setup.direction;
  const entry = ctx.setup.entryPrice;
  const maePrice = dir === "BUY" ? Math.max(0, entry - w.lowSinceStart)  : Math.max(0, w.highSinceStart - entry);
  const mfePrice = dir === "BUY" ? Math.max(0, w.highSinceStart - entry) : Math.max(0, entry - w.lowSinceStart);
  const maeR = maePrice / r;
  const mfeR = mfePrice / r;

  const evidence = { maeR, mfeR, realizedPnlR: ctx.realizedPnlR };

  if (maeR >= T.earlyMaeR) {
    const conf = Math.min(100, 40 + maeR * 30);
    const interp = ctx.realizedPnlR > 0 ? "trade won — could have entered cheaper" : "trade lost — entry was premature";
    return { verdict: "TOO_EARLY", confidence: conf, evidence,
      reasons: [`post-entry MAE ${maeR.toFixed(2)}R ≥ ${T.earlyMaeR}R — ${interp}`] };
  }
  return { verdict: "TIMELY", confidence: 70, evidence,
    reasons: [`post-entry MAE ${maeR.toFixed(2)}R < ${T.earlyMaeR}R — entry timing was reasonable`] };
}
