import { buildVote, signalDirectionAsVote, type AgentContext, type AgentVote } from "./agents.types";

const EXPIRATION_SEC = 60;

export function riskAgent(ctx: AgentContext): AgentVote {
  const acc = ctx.account.account;
  const limits = ctx.baselineRiskLimits;
  const evidence: string[] = [];
  const blockers: string[] = [];

  if (!acc) {
    blockers.push("no connected account");
    return buildVote({ vote: "BLOCK", confidence: 100, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (acc.balance <= 0) {
    blockers.push(`balance ${acc.balance}`);
    return buildVote({ vote: "BLOCK", confidence: 100, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }

  const dailyLossPct = ctx.account.startingDailyBalance > 0
    ? -(ctx.account.realizedPnLToday / ctx.account.startingDailyBalance) * 100 : 0;
  const weeklyLossPct = ctx.account.startingWeeklyBalance > 0
    ? -(ctx.account.realizedPnLWeek / ctx.account.startingWeeklyBalance) * 100 : 0;

  if (dailyLossPct >= limits.maxDailyLossPct) {
    blockers.push(`daily loss ${dailyLossPct.toFixed(2)}% ≥ cap ${limits.maxDailyLossPct}%`);
  }
  if (weeklyLossPct >= limits.maxWeeklyLossPct) {
    blockers.push(`weekly loss ${weeklyLossPct.toFixed(2)}% ≥ cap ${limits.maxWeeklyLossPct}%`);
  }
  if (ctx.account.openTradeCount >= limits.maxOpenTrades) {
    blockers.push(`open trades ${ctx.account.openTradeCount} ≥ cap ${limits.maxOpenTrades}`);
  }
  if (ctx.signal.confidence < limits.minConfidenceScore) {
    blockers.push(`signal confidence ${ctx.signal.confidence} < risk floor ${limits.minConfidenceScore}`);
  }
  const dd = ctx.risk.drawdown as { exceeded?: boolean } | null;
  if (dd?.exceeded) blockers.push("drawdown guard exceeded");

  if (blockers.length > 0) {
    return buildVote({ vote: "BLOCK", confidence: 100, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }

  const dailyHead = headroom(dailyLossPct, limits.maxDailyLossPct);
  const slotHead  = headroom(ctx.account.openTradeCount, limits.maxOpenTrades);
  evidence.push(`daily headroom ${(dailyHead * 100).toFixed(0)}%`);
  evidence.push(`slot headroom ${(slotHead * 100).toFixed(0)}%`);
  const score = Math.round((dailyHead * 0.6 + slotHead * 0.4) * 100);

  if (score < 40) {
    return buildVote({ vote: "WAIT", confidence: score, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  return buildVote({
    vote: signalDirectionAsVote(ctx.signal.direction),
    confidence: score, evidence, expirationSeconds: EXPIRATION_SEC,
  });
}

function headroom(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - used / cap));
}
