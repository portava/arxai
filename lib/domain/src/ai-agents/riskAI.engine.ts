import type { AgentVote, AiAgentContext } from "./aiAgents.types";

// riskAI represents the financial constraint viewpoint. Cap breaches are
// hard vetoes — risk cannot be overruled by AI consensus.
export function riskAI(ctx: AiAgentContext): AgentVote {
  const acc = ctx.account.account;
  const limits = ctx.baselineRiskLimits;
  if (!acc) return vote("BLOCK", 100, "NEUTRAL", "No connected account", {}, true);
  if (acc.balance <= 0) return vote("BLOCK", 100, "NEUTRAL", `Balance ${acc.balance}`, {}, true);

  const dailyLossPct = ctx.account.startingDailyBalance > 0
    ? -(ctx.account.realizedPnLToday / ctx.account.startingDailyBalance) * 100 : 0;
  const weeklyLossPct = ctx.account.startingWeeklyBalance > 0
    ? -(ctx.account.realizedPnLWeek / ctx.account.startingWeeklyBalance) * 100 : 0;

  if (dailyLossPct  >= limits.maxDailyLossPct)
    return vote("BLOCK", 100, "NEUTRAL", `Daily loss ${dailyLossPct.toFixed(2)}% ≥ ${limits.maxDailyLossPct}%`, {}, true);
  if (weeklyLossPct >= limits.maxWeeklyLossPct)
    return vote("BLOCK", 100, "NEUTRAL", `Weekly loss ${weeklyLossPct.toFixed(2)}% ≥ ${limits.maxWeeklyLossPct}%`, {}, true);
  if (ctx.account.openTradeCount >= limits.maxOpenTrades)
    return vote("BLOCK", 100, "NEUTRAL",
      `Open trades ${ctx.account.openTradeCount} ≥ ${limits.maxOpenTrades}`, {}, true);
  if (ctx.signal.confidence < limits.minConfidenceScore)
    return vote("BLOCK", 95, "NEUTRAL",
      `Signal confidence ${ctx.signal.confidence} < risk floor ${limits.minConfidenceScore}`, {}, true);

  const dailyHead = headroom(dailyLossPct, limits.maxDailyLossPct);
  const slotHead  = headroom(ctx.account.openTradeCount, limits.maxOpenTrades);
  const score = Math.round((dailyHead * 0.6 + slotHead * 0.4) * 100);

  const reasons = [`daily headroom ${(dailyHead * 100).toFixed(0)}%`, `slot headroom ${(slotHead * 100).toFixed(0)}%`];
  if (score >= 70) return vote("EXECUTE", score, "NEUTRAL", reasons.join("; "), { dailyLossPct, slotHead });
  if (score >= 40) return vote("WAIT",    score, "NEUTRAL", reasons.join("; "), { dailyLossPct, slotHead });
  return vote("BLOCK", 100 - score, "NEUTRAL", reasons.join("; "), { dailyLossPct, slotHead });
}

function headroom(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - used / cap));
}

function vote(v: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>, veto = false): AgentVote {
  return { agent: "riskAI", vote: v, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: veto };
}
