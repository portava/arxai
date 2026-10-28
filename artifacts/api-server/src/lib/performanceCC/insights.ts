// Build GG — Insight generator (text-based summaries, no guarantees).

interface InsightInputs {
  bestSymbol: string | null;
  worstSymbol: string | null;
  mostRepeatedMistake: string | null;
  totalTrades: number;
  winRate: number;
  netPnl: number;
  /** Decisions that said to trade. */
  tradeCalls: number;
  /** Trade calls with no paper order; the reason is not recorded per decision. */
  tradeCallsWithoutOrder: number;
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
  if (i.tradeCallsWithoutOrder > 0 && i.tradeCalls > 0) {
    // Not "blocked by safety filters": no safety-filter outcome is stored per
    // decision, so the reason a call has no order is unknown.
    insights.push(`${i.tradeCallsWithoutOrder} of ${i.tradeCalls} AI trade calls have no demo order. Why is not recorded per call (a safety filter, a setting, or it was never sent), so this is not a count of safety blocks.`);
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

  // No improving / declining insight: change over time is not measured
  // (strategy edges keep only their current score, not a history).

  // Always-on safety reminder.
  nextBestActions.push("Keep paper-practicing until performance is consistent before discussing live trading.");

  return { insights, nextBestActions, warnings };
}
