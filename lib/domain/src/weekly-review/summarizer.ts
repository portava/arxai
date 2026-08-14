// Build J — Pure summarizer + goal generator. Tone: professional, direct,
// calm. No hype, no guaranteed-profit language, no LIVE-execution policy
// (Safety Core is the sole authority for execution governance).

import type { WeeklyMetrics } from "./calculator.js";

export interface WeeklySummary {
  aiSummary: string;
  nextWeekFocus: string;
}

export function summarizeWeek(m: WeeklyMetrics): WeeklySummary {
  if (m.totalTrades === 0) {
    return {
      aiSummary: "No closed trades in this week. Use the time for replay drills and journal review before re-engaging.",
      nextWeekFocus: "Run three replay drills and log a reflection note for each.",
    };
  }
  const wr = (m.winRate * 100).toFixed(0);
  const pnl = m.netProfitLoss >= 0 ? `+${m.netProfitLoss.toFixed(2)}` : m.netProfitLoss.toFixed(2);
  const parts: string[] = [];

  parts.push(`Closed ${m.totalTrades} trade${m.totalTrades === 1 ? "" : "s"}: ${m.winningTrades} winning, ${m.losingTrades} losing.`);
  parts.push(`Net result ${pnl}. Win rate ${wr}%. Average R:R ${m.averageRr.toFixed(2)}.`);

  if (m.bestStrategy && m.worstStrategy && m.bestStrategy !== m.worstStrategy) {
    parts.push(`Best contributor was ${m.bestStrategy}. Weakest was ${m.worstStrategy} — review whether its setup criteria still match current conditions.`);
  } else if (m.bestStrategy) {
    parts.push(`${m.bestStrategy} produced the strongest net contribution.`);
  }

  if (m.bestSession && m.worstSession && m.bestSession !== m.worstSession) {
    parts.push(`${m.bestSession} session was your strongest window. ${m.worstSession} session underperformed.`);
  }

  if (m.biggestMistakePattern) {
    parts.push(`Most common mistake pattern: ${humanize(m.biggestMistakePattern)}.`);
  }
  if (m.biggestStrengthPattern) {
    parts.push(`Most consistent strength: ${humanize(m.biggestStrengthPattern)}.`);
  }
  if (m.weakestScoreArea && m.scoreTrends[m.weakestScoreArea] < 0) {
    parts.push(`${labelArea(m.weakestScoreArea)} score trended down by ${Math.abs(m.scoreTrends[m.weakestScoreArea])} this week.`);
  }
  if (m.strongestScoreArea && m.scoreTrends[m.strongestScoreArea] > 0) {
    parts.push(`${labelArea(m.strongestScoreArea)} score improved by ${m.scoreTrends[m.strongestScoreArea]}.`);
  }

  // Single, clear next-week focus — no LIVE governance.
  let focus: string;
  if (m.biggestMistakePattern) {
    focus = `Stop repeating ${humanize(m.biggestMistakePattern).toLowerCase()}.`;
  } else if (m.weakestScoreArea && m.scoreTrends[m.weakestScoreArea] < 0) {
    focus = `Rebuild ${labelArea(m.weakestScoreArea).toLowerCase()} — review every trade where it slipped.`;
  } else if (m.averageRr < 1.5 && m.totalTrades >= 3) {
    focus = "Only take setups offering 1.5R or better. Skip marginal entries.";
  } else if (m.winRate < 0.4 && m.totalTrades >= 5) {
    focus = "Tighten setup criteria. Fewer trades, higher quality.";
  } else if (m.bestStrategy) {
    focus = `Lean into ${m.bestStrategy}. It is producing your best edge.`;
  } else {
    focus = "Maintain current discipline and journal every trade for at least one more week.";
  }

  return { aiSummary: parts.join(" "), nextWeekFocus: focus };
}

function humanize(t: string): string {
  return t.toLowerCase().split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
function labelArea(a: string): string {
  switch (a) {
    case "discipline":       return "Discipline";
    case "execution":        return "Execution";
    case "emotionalControl": return "Emotional control";
    case "consistency":      return "Consistency";
    default:                 return a;
  }
}
