// Build GG — Insight generator (text-based summaries, no guarantees).

interface InsightInputs {
  bestSymbol: string | null;
  worstSymbol: string | null;
  mostRepeatedMistake: string | null;
  totalTrades: number;
  winRate: number;
  netPnl: number;
  improvementScore: number;
  blockedTrades: number;
  decisionsCreated: number;
  learningEvents: number;
}

export function generateInsights(i: InsightInputs): { insights: string[]; nextBestActions: string[]; warnings: string[] } {
  const insights: string[] = [];
  const nextBestActions: string[] = [];
  const warnings: string[] = [];

  if (i.totalTrades === 0) {
    insights.push("No closed paper trades yet — start practicing in paper mode to gather data.");
    nextBestActions.push("Run a Paper Autopilot cycle or open a paper trade manually.");
    warnings.push("Sample size is zero — all metrics below are placeholders until trades close.");
    return { insights, nextBestActions, warnings };
  }

  if (i.bestSymbol) {
    insights.push(`Strongest performance is on ${i.bestSymbol} based on net paper P&L.`);
  }
  if (i.worstSymbol && i.worstSymbol !== i.bestSymbol) {
    insights.push(`Weakest performance is on ${i.worstSymbol} — review setups before trading it.`);
  }
  if (i.mostRepeatedMistake) {
    insights.push(`Most repeated mistake tag: "${i.mostRepeatedMistake}" — focus drill on avoiding it.`);
    nextBestActions.push(`Add a checklist item to catch "${i.mostRepeatedMistake}" before next entry.`);
  }
  if (i.blockedTrades > 0 && i.decisionsCreated > 0) {
    const pct = Math.round((i.blockedTrades / i.decisionsCreated) * 100);
    insights.push(`${pct}% of AI decisions were blocked by safety filters — guardrails are active.`);
  }
  if (i.winRate >= 60 && i.netPnl > 0) {
    insights.push(`Paper win rate is healthy at ${i.winRate.toFixed(1)}% with positive net P&L.`);
  } else if (i.winRate < 40) {
    insights.push(`Paper win rate is low at ${i.winRate.toFixed(1)}% — review entries and risk.`);
    nextBestActions.push("Tighten the sniper-entry threshold or increase the minimum confidence.");
  }

  if (i.totalTrades < 30) {
    warnings.push(`Sample size is small (${i.totalTrades} trades) — interpret results with caution.`);
    insights.push("Learning confidence is still low because the sample size is small.");
  }
  if (i.learningEvents > 0 && i.totalTrades > 0) {
    const ratio = i.learningEvents / i.totalTrades;
    if (ratio < 0.5) warnings.push("Some closed trades did not produce a learning event — check BB→CC handoff.");
  }

  if (i.improvementScore > 5) {
    insights.push("AI is showing signs of improvement after Build CC learning.");
  } else if (i.improvementScore < -5) {
    insights.push("Recent AI performance trend is declining — review learning adjustments.");
    nextBestActions.push("Inspect recent strategy_edge changes that may have over-corrected.");
  }

  // Always-on safety reminder.
  nextBestActions.push("Keep paper-practicing until performance is consistent before discussing live trading.");

  return { insights, nextBestActions, warnings };
}
