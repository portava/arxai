// Profit Mission Phase 9 — Daily briefing, end-of-day review & post-mission report.
//
// Pure, deterministic, IO-free builders. They turn a mission's state plus closed-
// trade aggregates into honest, plain-language narratives. No guaranteed-profit
// vocabulary; every projection is framed as a goal/estimate, never a promise.
// These are DISPLAY artifacts — they never execute or gate anything.

export interface ClosedTradeAggregate {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  netPnl: number;
  /** Realised P/L over just the period being reviewed (day / mission). */
  bestTradePnl: number;
  worstTradePnl: number;
}

export interface MissionBriefingState {
  missionId: number;
  status: string;
  startingAmount: number;
  targetAmount: number;
  currentValue: number;
  requiredProfit: number;
  /** Whole days remaining until the deadline (may be 0 or negative if past). */
  daysRemaining: number;
  automationLevel: number;
  promotionPaused: boolean;
}

export interface DailyBriefing {
  kind: "daily_briefing";
  missionId: number;
  generatedAt: string;
  headline: string;
  lines: string[];
  /** Today's plan items derived from state (advisory). */
  plan: string[];
  cautions: string[];
}

function progressPct(s: MissionBriefingState): number {
  const denom = s.targetAmount - s.startingAmount;
  if (denom <= 0) return 0;
  return Math.max(0, Math.min(100, ((s.currentValue - s.startingAmount) / denom) * 100));
}

export function buildDailyBriefing(state: MissionBriefingState, nowMs: number): DailyBriefing {
  const pct = progressPct(state);
  const remainingProfit = Math.max(0, state.targetAmount - state.currentValue);
  const lines: string[] = [
    `Status: ${state.status}. Progress: ${pct.toFixed(1)}% toward the goal.`,
    `Account value ${state.currentValue} of target ${state.targetAmount} — ${remainingProfit} still to go.`,
    `Time left: ${state.daysRemaining} day(s). Automation level ${state.automationLevel}.`,
  ];
  const plan: string[] = [];
  const cautions: string[] = [];

  if (state.status !== "active") {
    plan.push(`Mission is ${state.status} — resume it to trade today.`);
  } else {
    plan.push("Focus on the highest-quality setups your agents surface; skip marginal ones.");
    if (state.daysRemaining > 0 && remainingProfit > 0) {
      const perDay = remainingProfit / Math.max(1, state.daysRemaining);
      plan.push(`To stay on pace you would need about ${perDay.toFixed(2)} per remaining day — a guide, not a quota.`);
    }
  }
  if (state.promotionPaused) cautions.push("Promotion is paused — automation cannot be raised until this clears.");
  if (state.daysRemaining <= 0) cautions.push("The mission deadline has passed; review or extend before trading.");
  cautions.push("Outcomes are uncertain and losses are possible; the safety gates can refuse a trade at any time.");

  return {
    kind: "daily_briefing",
    missionId: state.missionId,
    generatedAt: new Date(nowMs).toISOString(),
    headline: `Daily briefing — ${pct.toFixed(0)}% to goal, ${state.daysRemaining} day(s) left`,
    lines,
    plan,
    cautions,
  };
}

export interface EndOfDayReview {
  kind: "eod_review";
  missionId: number;
  generatedAt: string;
  headline: string;
  lines: string[];
  observations: string[];
}

export function buildEndOfDayReview(
  state: MissionBriefingState,
  today: ClosedTradeAggregate,
  nowMs: number,
): EndOfDayReview {
  const winRate = today.totalTrades > 0 ? (today.winningTrades / today.totalTrades) * 100 : 0;
  const lines: string[] = [
    `Trades today: ${today.totalTrades} (${today.winningTrades}W / ${today.losingTrades}L, ${winRate.toFixed(0)}% win).`,
    `Net result today: ${today.netPnl}.`,
    `Best: ${today.bestTradePnl}; worst: ${today.worstTradePnl}.`,
    `Progress now: ${progressPct(state).toFixed(1)}% of the goal.`,
  ];
  const observations: string[] = [];
  if (today.totalTrades === 0) observations.push("No trades closed today — patience is a valid result.");
  if (today.netPnl < 0) observations.push("Net negative today; review whether risk rules held and avoid chasing it back.");
  if (today.netPnl > 0) observations.push("Net positive today; protect gains and keep position sizing disciplined.");
  observations.push("One day is a small sample — judge the strategy over many trades, not one session.");

  return {
    kind: "eod_review",
    missionId: state.missionId,
    generatedAt: new Date(nowMs).toISOString(),
    headline: `End-of-day review — ${today.netPnl >= 0 ? "+" : ""}${today.netPnl} across ${today.totalTrades} trade(s)`,
    lines,
    observations,
  };
}

export interface MissionReport {
  kind: "mission_report";
  missionId: number;
  generatedAt: string;
  outcome: "reached" | "fell_short" | "in_progress";
  headline: string;
  lines: string[];
  lessons: string[];
}

export function buildMissionReport(
  state: MissionBriefingState,
  overall: ClosedTradeAggregate,
  nowMs: number,
): MissionReport {
  const reached = state.currentValue >= state.targetAmount;
  const ended = state.status === "completed" || state.status === "failed" || state.status === "cancelled";
  const outcome: MissionReport["outcome"] = reached ? "reached" : ended ? "fell_short" : "in_progress";
  const winRate = overall.totalTrades > 0 ? (overall.winningTrades / overall.totalTrades) * 100 : 0;
  const netResult = state.currentValue - state.startingAmount;

  const lines: string[] = [
    `Final status: ${state.status}.`,
    `Account moved from ${state.startingAmount} to ${state.currentValue} (net ${netResult >= 0 ? "+" : ""}${netResult}).`,
    `Trades: ${overall.totalTrades} (${overall.winningTrades}W / ${overall.losingTrades}L, ${winRate.toFixed(0)}% win).`,
    `Net realised across the mission: ${overall.netPnl}.`,
  ];
  const lessons: string[] = [];
  if (outcome === "reached") lessons.push("Goal reached — record what worked, but do not assume it repeats.");
  if (outcome === "fell_short") lessons.push("Goal not reached — review sizing, drift, and which setups underperformed.");
  if (overall.totalTrades < 30) lessons.push("Sample is small; conclusions are tentative.");
  lessons.push("These results are history, not a forecast; future missions carry their own risk of loss.");

  return {
    kind: "mission_report",
    missionId: state.missionId,
    generatedAt: new Date(nowMs).toISOString(),
    outcome,
    headline: outcome === "reached"
      ? "Mission report — goal reached"
      : outcome === "fell_short"
        ? "Mission report — goal not reached"
        : "Mission report — in progress",
    lines,
    lessons,
  };
}
