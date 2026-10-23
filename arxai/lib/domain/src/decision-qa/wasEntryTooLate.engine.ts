import {
  type ExecutionQAContext, type QTimingAnswer, DECISION_QA_THRESHOLDS,
} from "./decisionQA.types";

// Q4: Was the entry too late?
//
// "Too late" = we chased — a meaningful favorable move happened BEFORE
// our fill. Two signals:
//   (a) adverse fill slippage from intendedEntryPrice — we got worse fill
//       than intended (BUY filled higher / SELL filled lower)
//   (b) pre-entry favorable move from signal-time start price to actual
//       entry price — the price ran in our trade direction before we got in
//
// Either ≥ lateSlippagePips → TOO_LATE. Both small → TIMELY.
//
// Defenses:
//   • pipSize ≤ 0  → INCONCLUSIVE
export function wasEntryTooLate(ctx: ExecutionQAContext): QTimingAnswer {
  const T = DECISION_QA_THRESHOLDS;
  if (ctx.pipSize <= 0) {
    return { verdict: "INCONCLUSIVE", confidence: 0, evidence: {}, reasons: ["pipSize ≤ 0"] };
  }
  const dir = ctx.setup.direction;
  const entry = ctx.setup.entryPrice;
  const intended = ctx.intendedEntryPrice;
  const pip = ctx.pipSize;
  const preStart = ctx.preEntryWindow.startPrice;

  // Adverse slippage: positive = we got worse fill than intended.
  const slippagePips = dir === "BUY" ? (entry - intended) / pip : (intended - entry) / pip;

  // Pre-entry favorable move: how far the trade direction ran from
  // signal-time start price to actual entry price (chase distance).
  const preFavorablePips = dir === "BUY"
    ? Math.max(0, entry - preStart) / pip
    : Math.max(0, preStart - entry) / pip;

  const evidence = { entrySlippagePips: slippagePips, preEntryFavorableMovePips: preFavorablePips };

  if (slippagePips >= T.lateSlippagePips || preFavorablePips >= T.lateSlippagePips) {
    const worst = Math.max(slippagePips, preFavorablePips);
    const conf = Math.min(100, 40 + worst * 5);
    const reasons: string[] = [];
    if (slippagePips >= T.lateSlippagePips) reasons.push(`adverse slippage ${slippagePips.toFixed(1)}p ≥ ${T.lateSlippagePips}p`);
    if (preFavorablePips >= T.lateSlippagePips) reasons.push(`pre-entry favorable move ${preFavorablePips.toFixed(1)}p ≥ ${T.lateSlippagePips}p (chased)`);
    return { verdict: "TOO_LATE", confidence: conf, evidence, reasons };
  }

  return { verdict: "TIMELY", confidence: 70, evidence,
    reasons: [`slippage ${slippagePips.toFixed(1)}p, pre-entry move ${preFavorablePips.toFixed(1)}p — both within ${T.lateSlippagePips}p tolerance`] };
}
