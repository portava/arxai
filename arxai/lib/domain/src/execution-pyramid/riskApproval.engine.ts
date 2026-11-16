import type { ExecutionPyramidContext, PyramidScoreReport } from "./executionPyramid.types";
import { PYRAMID_CATEGORY_WEIGHT } from "./executionPyramid.types";

// Risk dimension on the pyramid uses the same headroom logic as the
// confidence-gate's risk scorer but expressed on a 0..10 scale.

export function scoreRiskApproval(ctx: ExecutionPyramidContext): PyramidScoreReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const acc = ctx.account.account;
  const limits = ctx.baselineRiskLimits;

  if (!acc) blockers.push("No connected account");
  else if (acc.balance <= 0) blockers.push(`Account balance non-positive (${acc.balance})`);

  const dailyLossPct = ctx.account.startingDailyBalance > 0
    ? -(ctx.account.realizedPnLToday / ctx.account.startingDailyBalance) * 100 : 0;
  const weeklyLossPct = ctx.account.startingWeeklyBalance > 0
    ? -(ctx.account.realizedPnLWeek / ctx.account.startingWeeklyBalance) * 100 : 0;

  if (dailyLossPct  >= limits.maxDailyLossPct)  blockers.push(`Daily loss ${dailyLossPct.toFixed(2)}% ≥ ${limits.maxDailyLossPct}%`);
  if (weeklyLossPct >= limits.maxWeeklyLossPct) blockers.push(`Weekly loss ${weeklyLossPct.toFixed(2)}% ≥ ${limits.maxWeeklyLossPct}%`);
  if (ctx.account.openTradeCount >= limits.maxOpenTrades) {
    blockers.push(`Open trades ${ctx.account.openTradeCount} ≥ ${limits.maxOpenTrades}`);
  }
  if (ctx.signal.confidence < limits.minConfidenceScore) {
    blockers.push(`Signal confidence ${ctx.signal.confidence} < risk floor ${limits.minConfidenceScore}`);
  }
  const dd = ctx.risk.drawdown as { exceeded?: boolean } | null;
  if (dd?.exceeded) blockers.push("Drawdown guard exceeded");

  const dailyHead  = headroom(dailyLossPct,  limits.maxDailyLossPct);
  const weeklyHead = headroom(weeklyLossPct, limits.maxWeeklyLossPct);
  const slotHead   = headroom(ctx.account.openTradeCount, limits.maxOpenTrades);
  const confHead   = Math.max(0, Math.min(1,
    (ctx.signal.confidence - limits.minConfidenceScore) / Math.max(1, 100 - limits.minConfidenceScore)));

  const score = Math.round((dailyHead * 3) + (weeklyHead * 2.5) + (slotHead * 2.5) + (confHead * 2));

  if (dailyHead  < 0.25) warnings.push(`Daily cap headroom ${(dailyHead  * 100).toFixed(0)}%`);
  if (weeklyHead < 0.25) warnings.push(`Weekly cap headroom ${(weeklyHead * 100).toFixed(0)}%`);
  if (slotHead   < 0.25) warnings.push(`Slot headroom ${(slotHead   * 100).toFixed(0)}%`);

  return {
    category: "riskApproval",
    score: Math.max(0, Math.min(10, score)),
    warnings, blockers,
    explanation: `Headroom — daily ${(dailyHead*100).toFixed(0)}%, weekly ${(weeklyHead*100).toFixed(0)}%, slots ${(slotHead*100).toFixed(0)}%, conf ${(confHead*100).toFixed(0)}% — ${score}/10`,
    confidenceContribution: Math.max(0, Math.min(10, score)) * (PYRAMID_CATEGORY_WEIGHT / 10),
  };
}

function headroom(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - used / cap));
}
