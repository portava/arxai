import type { ConfidenceGateContext, ScoreReport, Blocker } from "./confidenceGate.types";
import { SCORE_WEIGHTS } from "./confidenceGate.types";

// Risk dimension is the second-highest in the hierarchy — only broker outranks
// it. AI can never override a RISK blocker.

export function scoreRiskApproval(ctx: ConfidenceGateContext): ScoreReport {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const blockers: Blocker[] = [];

  const acc = ctx.account.account;
  const limits = ctx.baselineRiskLimits;

  // Hard blockers
  if (!acc) {
    blockers.push({ severity: "RISK", dimension: "riskApproval", message: "No connected account" });
  } else if (acc.balance <= 0) {
    blockers.push({ severity: "RISK", dimension: "riskApproval",
      message: `Account balance non-positive (${acc.balance})` });
  }

  const dailyLossPct = ctx.account.startingDailyBalance > 0
    ? -(ctx.account.realizedPnLToday / ctx.account.startingDailyBalance) * 100 : 0;
  const weeklyLossPct = ctx.account.startingWeeklyBalance > 0
    ? -(ctx.account.realizedPnLWeek / ctx.account.startingWeeklyBalance) * 100 : 0;

  if (dailyLossPct >= limits.maxDailyLossPct) {
    blockers.push({ severity: "RISK", dimension: "riskApproval",
      message: `Daily loss ${dailyLossPct.toFixed(2)}% ≥ cap ${limits.maxDailyLossPct}%` });
  }
  if (weeklyLossPct >= limits.maxWeeklyLossPct) {
    blockers.push({ severity: "RISK", dimension: "riskApproval",
      message: `Weekly loss ${weeklyLossPct.toFixed(2)}% ≥ cap ${limits.maxWeeklyLossPct}%` });
  }
  if (ctx.account.openTradeCount >= limits.maxOpenTrades) {
    blockers.push({ severity: "RISK", dimension: "riskApproval",
      message: `Open trades ${ctx.account.openTradeCount} ≥ cap ${limits.maxOpenTrades}` });
  }
  if (ctx.signal.confidence < limits.minConfidenceScore) {
    blockers.push({ severity: "RISK", dimension: "riskApproval",
      message: `Signal confidence ${ctx.signal.confidence} < risk floor ${limits.minConfidenceScore}` });
  }

  // Score — headroom under each cap.
  const dailyHeadroom  = pctHeadroom(dailyLossPct,  limits.maxDailyLossPct);    // 0..1
  const weeklyHeadroom = pctHeadroom(weeklyLossPct, limits.maxWeeklyLossPct);
  const slotHeadroom   = pctHeadroom(ctx.account.openTradeCount, limits.maxOpenTrades);
  const confHeadroom   = Math.max(0, Math.min(1,
    (ctx.signal.confidence - limits.minConfidenceScore) / Math.max(1, 100 - limits.minConfidenceScore)));

  const dailyScore  = Math.round(dailyHeadroom  * 30);
  const weeklyScore = Math.round(weeklyHeadroom * 25);
  const slotScore   = Math.round(slotHeadroom   * 25);
  const confScore   = Math.round(confHeadroom   * 20);

  // Soft warnings
  if (dailyHeadroom < 0.25)  warnings.push(`Daily cap headroom ${(dailyHeadroom * 100).toFixed(0)}%`);
  if (weeklyHeadroom < 0.25) warnings.push(`Weekly cap headroom ${(weeklyHeadroom * 100).toFixed(0)}%`);
  if (slotHeadroom < 0.25)   warnings.push(`Open-trade slot headroom ${(slotHeadroom * 100).toFixed(0)}%`);

  // Drawdown report (if computed)
  const dd = ctx.risk.drawdown as { exceeded?: boolean; currentPct?: number } | null;
  if (dd?.exceeded) {
    blockers.push({ severity: "RISK", dimension: "riskApproval",
      message: `Drawdown guard exceeded${dd.currentPct != null ? ` (${dd.currentPct.toFixed(2)}%)` : ""}` });
  }

  const score = Math.round(dailyScore + weeklyScore + slotScore + confScore);
  reasons.push(`Daily headroom ${(dailyHeadroom * 100).toFixed(0)}% → ${dailyScore}/30`);
  reasons.push(`Weekly headroom ${(weeklyHeadroom * 100).toFixed(0)}% → ${weeklyScore}/25`);
  reasons.push(`Slot headroom ${(slotHeadroom * 100).toFixed(0)}% → ${slotScore}/25`);
  reasons.push(`Conf headroom ${(confHeadroom * 100).toFixed(0)}% → ${confScore}/20`);

  return {
    dimension: "riskApproval",
    score, weight: SCORE_WEIGHTS.riskApproval,
    blockers, warnings, reasons,
    evidence: {
      dailyLossPct, weeklyLossPct,
      openTradeCount: ctx.account.openTradeCount,
      maxOpenTrades: limits.maxOpenTrades,
      signalConfidence: ctx.signal.confidence,
      minConfidenceScore: limits.minConfidenceScore,
      drawdown: dd,
    },
  };
}

function pctHeadroom(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - used / cap));
}
