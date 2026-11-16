// Build J — Pure goal generator. Produces 1–3 actionable improvement goals
// per week based on the calculated metrics. All advisory; no execution
// governance (Safety Core remains the sole authority for that).

import type { WeeklyMetrics } from "./calculator.js";

export interface ProposedGoal {
  goalTitle: string;
  goalDescription: string;
  targetMetric: string;
  startingValue: number;
  targetValue: number;
}

export function proposeWeeklyGoals(m: WeeklyMetrics): ProposedGoal[] {
  const goals: ProposedGoal[] = [];

  // 1. Mistake-pattern goal — always first if a pattern exists.
  if (m.biggestMistakePattern) {
    const startCount = m.topMistakeCounts.find((c) => c.tag === m.biggestMistakePattern)?.count ?? 0;
    goals.push({
      goalTitle: humanizeMistakeGoal(m.biggestMistakePattern),
      goalDescription: `${humanize(m.biggestMistakePattern)} appeared ${startCount} time${startCount === 1 ? "" : "s"} this week. Cut it in half.`,
      targetMetric: `MISTAKE_TAG:${m.biggestMistakePattern}`,
      startingValue: startCount,
      targetValue: Math.max(0, Math.floor(startCount / 2)),
    });
  }

  // 2. R:R discipline goal.
  if (m.averageRr > 0 && m.averageRr < 2 && m.totalTrades >= 3) {
    goals.push({
      goalTitle: "Only take setups with 2:1 R:R or better.",
      goalDescription: `Average R:R was ${m.averageRr.toFixed(2)}. Skip setups below 2:1 next week.`,
      targetMetric: "AVERAGE_RR",
      startingValue: Number(m.averageRr.toFixed(2)),
      targetValue: 2.0,
    });
  }

  // 3. Win-rate / overtrading goal — pick whichever applies.
  if (m.winRate < 0.45 && m.totalTrades >= 5) {
    goals.push({
      goalTitle: "Trade fewer setups; aim for higher quality.",
      goalDescription: `Win rate was ${(m.winRate * 100).toFixed(0)}%. Limit to your strongest setups only.`,
      targetMetric: "WIN_RATE",
      startingValue: Number((m.winRate * 100).toFixed(0)),
      targetValue: 50,
    });
  } else if (m.totalTrades >= 25) {
    goals.push({
      goalTitle: "Limit trades to 3 per day.",
      goalDescription: `${m.totalTrades} trades in one week suggests overtrading. Cap at 3/day next week.`,
      targetMetric: "TRADES_PER_WEEK",
      startingValue: m.totalTrades,
      targetValue: 15,
    });
  }

  // 4. If there are no problems detected at all, propose a maintenance goal.
  if (goals.length === 0) {
    goals.push({
      goalTitle: "Maintain process — journal every trade.",
      goalDescription: "No major issues detected. Keep journaling every entry to preserve the trend.",
      targetMetric: "JOURNAL_ENTRIES_PER_WEEK",
      startingValue: 0,
      targetValue: m.totalTrades,
    });
  }

  return goals.slice(0, 3);
}

function humanize(t: string): string {
  return t.toLowerCase().split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}
function humanizeMistakeGoal(tag: string): string {
  switch (tag) {
    case "EARLY_ENTRY":             return "Wait for confirmation before entering.";
    case "LATE_ENTRY":              return "Enter at the planned trigger, not after.";
    case "REVENGE_TRADE":           return "Avoid trading after 2 consecutive losses.";
    case "FOMO_ENTRY":              return "Skip late breakouts you didn't plan.";
    case "OVERSIZED_POSITION":      return "Respect max lot size on every entry.";
    case "POOR_STOP_LOSS":          return "Use a structure-based stop on every trade.";
    case "MOVED_STOP_LOSS":         return "Never widen a stop loss intra-trade.";
    case "EXITED_TOO_EARLY":        return "Hold winners to the planned target.";
    case "HELD_TOO_LONG":           return "Exit at the planned target, not on hope.";
    case "IGNORED_MARKET_CONDITION":return "Run the market filter before every entry.";
    case "STRATEGY_MISMATCH":       return "Use only the strategy that matches the regime.";
    case "OVERTRADING":             return "Limit trades to 3 per day.";
    default:                        return `Reduce ${humanize(tag).toLowerCase()}.`;
  }
}
