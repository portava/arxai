// Build II — Weekly Improvement Plan.
//
// SAFETY: pure planning and review. NEVER places trades, NEVER recommends
// live trading.

import {
  db,
  weeklyImprovementPlansTable,
  paperOrdersTable,
  mistakePatternsTable,
  strategyEdgesTable,
} from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import { evaluateGovernor } from "../riskGovernor/governor.js";
import { getOrCreateUserRiskSettings } from "../risk/userRiskSettings.js";

export interface WeeklyPlan {
  week_start: string;
  week_end: string;
  mainGoal: string;
  focusAreas: string[];
  rulesToPractice: string[];
  mistakesToReduce: string[];
  setupsToStudy: string[];
  setupsToAvoid: string[];
  /**
   * `maxTradesPerDay` / `maxLossPerDayUsd` are the trader's OWN limits, not
   * targets this planner invents. They were hardcoded `5` and `100`. When the
   * governor cannot derive the dollar limit the value is `null` and `basis` is
   * "UNKNOWN" — the plan says so instead of printing a number.
   *
   * `requiredDebriefs` / `minQualityScore` / `reviewDays` ARE deliberate
   * coaching targets set by this planner; `targetsNote` says which is which.
   */
  paperTradingTargets: {
    maxTradesPerDay: number | null;
    maxDailyLossPct: number | null;
    maxLossPerDayUsd: number | null;
    limitBasis: string;
    requiredDebriefs: number;
    minQualityScore: number;
    reviewDays: string[];
    targetsNote: string;
  };
  progressMetrics: string[];
  reviewQuestions: string[];
  successCriteria: string[];
  warnings: string[];
  /** Whether this plan was written to weekly_improvement_plans. See the
   *  persistence block below — the table is keyed one-row-per-week with no
   *  owner column, so a per-user plan currently cannot be stored. */
  persisted: boolean;
  persistenceNote: string | null;
}

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = x.getUTCDay();
  const diff = (day + 6) % 7; // Monday-start
  x.setUTCDate(x.getUTCDate() - diff);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

// ISOLATION: `userId` is required — the plan is built from this trader's own
// paper orders, mistake patterns and strategy edges.
export async function generateWeeklyPlan(userId: number, opts: { persist?: boolean } = {}): Promise<WeeklyPlan> {
  const persist = opts.persist ?? false;
  const today = new Date();
  const weekStartDate = startOfWeek(today);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setUTCDate(weekStartDate.getUTCDate() + 6);
  const weekStart = isoDateOnly(weekStartDate);
  const weekEnd = isoDateOnly(weekEndDate);

  // Pull supporting data.
  const sevenAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let lastWeekTrades: { id: number; status: string; pnl: number | null }[] = [];
  try {
    const rows = await db.select().from(paperOrdersTable)
      .where(and(eq(paperOrdersTable.userId, userId), gte(paperOrdersTable.createdAt, sevenAgo)));
    lastWeekTrades = rows.map(r => ({ id: r.id, status: r.status, pnl: r.profitLoss ?? null }));
  } catch { /* empty */ }

  let mistakes: { tag: string; symbol: string; action: string; count: number; severityScore: number }[] = [];
  try { mistakes = await db.select().from(mistakePatternsTable)
    .where(eq(mistakePatternsTable.userId, userId)); } catch { /* empty */ }

  let edges: { symbol: string; signalName: string; action: string; sampleCount: number; edgeScore: number; winCount: number }[] = [];
  try { edges = await db.select().from(strategyEdgesTable)
    .where(eq(strategyEdgesTable.userId, userId)); } catch { /* empty */ }

  let governor: Awaited<ReturnType<typeof evaluateGovernor>> | null = null;
  try { governor = await evaluateGovernor({ persist: false, userId }); } catch { /* empty */ }

  const closedLastWeek = lastWeekTrades.filter(t => t.status !== "OPEN");
  const wins = closedLastWeek.filter(t => (t.pnl ?? 0) > 0).length;
  const lastWeekWinRate = closedLastWeek.length > 0 ? Math.round((wins / closedLastWeek.length) * 100) : 0;

  // Top mistakes by severity*count (top 3).
  const topMistakes = [...mistakes]
    .filter(m => m.count >= 2)
    .sort((a, b) => (b.severityScore * b.count) - (a.severityScore * a.count))
    .slice(0, 3);

  // Top winning + losing setups.
  const winning = [...edges].filter(e => e.sampleCount >= 5 && e.edgeScore >= 10).sort((a, b) => b.edgeScore - a.edgeScore).slice(0, 3);
  const losing = [...edges].filter(e => e.sampleCount >= 5 && e.edgeScore <= -10).sort((a, b) => a.edgeScore - b.edgeScore).slice(0, 3);

  const govStatus = governor?.overallStatus ?? "UNKNOWN";

  // Main goal driven by current state.
  let mainGoal: string;
  if (govStatus === "LOCKED") {
    mainGoal = "Resolve the live-trading flag and return the Risk Governor to a safe state. Do not paper trade until cleared.";
  } else if (govStatus === "WATCH_ONLY") {
    mainGoal = "Recover from drawdown / hard-block conditions. Observe-only week — no new paper executions until governor clears.";
  } else if (closedLastWeek.length < 10) {
    mainGoal = "Build a real sample size — capture at least 20 quality paper trades with full debriefs this week.";
  } else if (lastWeekWinRate < 45) {
    mainGoal = "Improve trade quality. Skip every borderline setup and only trade ACTIVE/WATCHLIST playbook entries.";
  } else {
    mainGoal = "Reinforce the strongest setups, eliminate the top repeated mistake, and grow learning confidence.";
  }

  const focusAreas: string[] = [];
  if (topMistakes[0]) focusAreas.push(`Eliminate "${topMistakes[0].tag}" (${topMistakes[0].count}× last 30d).`);
  if (winning[0]) focusAreas.push(`Master ${winning[0].symbol} ${winning[0].signalName} (${winning[0].action}) — current edge ${winning[0].edgeScore.toFixed(1)}.`);
  if (losing[0]) focusAreas.push(`Stop trading ${losing[0].symbol} ${losing[0].signalName} (${losing[0].action}) — current edge ${losing[0].edgeScore.toFixed(1)}.`);
  if (focusAreas.length === 0) focusAreas.push("Capture more paper trades and debriefs to make focus areas data-driven.");

  const rulesToPractice = [
    "Run the pre-session checklist before every paper session.",
    "Capture a structured post-trade debrief for every closed paper trade.",
    "If the Risk Governor blocks or pauses, stop trading immediately and review.",
    "Never override the AI decision without writing the reason in the debrief.",
    "Stop loss and take profit must be set before opening any paper trade.",
  ];

  const mistakesToReduce = topMistakes.length > 0
    ? topMistakes.map(m => `${m.tag} on ${m.symbol || "ALL"} (${m.action || "ANY"}) — ${m.count}× / severity ${m.severityScore.toFixed(1)}.`)
    : ["No high-frequency mistake patterns yet — keep capturing debriefs to build the dataset."];

  const setupsToStudy = winning.length > 0
    ? winning.map(e => `${e.symbol} ${e.signalName} (${e.action}) — edge ${e.edgeScore.toFixed(1)} on ${e.sampleCount} trades.`)
    : ["Sample size is too small to identify winning setups — focus on volume and consistency."];

  const setupsToAvoid = losing.length > 0
    ? losing.map(e => `${e.symbol} ${e.signalName} (${e.action}) — edge ${e.edgeScore.toFixed(1)} on ${e.sampleCount} trades.`)
    : ["No clearly losing setups identified yet — keep tracking edge scores."];

  let maxTradesPerDay: number | null = null;
  try {
    const rs = await getOrCreateUserRiskSettings(userId);
    maxTradesPerDay = rs.maxTradesPerDay ?? null;
  } catch { /* leave UNKNOWN rather than substituting a default */ }
  const gm = governor?.metrics ?? null;
  const limitDerived = gm != null && gm.dailyLossLimitBasis !== "UNKNOWN" && gm.dailyLossLimit > 0;
  const paperTradingTargets: WeeklyPlan["paperTradingTargets"] = {
    maxTradesPerDay,
    maxDailyLossPct: gm?.maxDailyLossPct ?? null,
    maxLossPerDayUsd: limitDerived ? gm!.dailyLossLimit : null,
    limitBasis: gm?.dailyLossLimitBasis ?? "UNKNOWN",
    requiredDebriefs: 20,
    minQualityScore: 60,
    reviewDays: ["Wednesday", "Sunday"],
    targetsNote:
      "maxTradesPerDay and maxLossPerDayUsd are YOUR configured limits read from your risk settings and paper-account equity"
      + (limitDerived ? "" : " (the dollar limit could not be derived, so it is reported as unknown rather than filled in)")
      + ". requiredDebriefs, minQualityScore and reviewDays are coaching targets set by this plan, not limits you configured.",
  };

  const progressMetrics = [
    `Closed paper trades this week: aim ≥ ${paperTradingTargets.requiredDebriefs}.`,
    "Win rate target: ≥ 50% (paper, not live).",
    "Repeated-mistake count: should drop week-over-week for the top mistake.",
    "Edge score for the focus setup: should trend upward.",
    "Risk Governor status: should remain in PAPER_ALLOWED or PAPER_CAUTION.",
  ];

  const reviewQuestions = [
    "How many sessions did I complete a full pre-session checklist?",
    "How many trades closed without a structured debrief? (Target: 0.)",
    "Which mistake repeated most often this week?",
    "Did I follow every Risk Governor block without arguing with it?",
    "Did I take any setup that was NOT in the playbook?",
    "What is the single best lesson from the week?",
  ];

  const successCriteria = [
    `At least ${paperTradingTargets.requiredDebriefs} paper trades closed and debriefed.`,
    "Top repeated mistake count down by at least 30% versus last week.",
    "No Risk Governor LOCKED events.",
    "At least one ACTIVE playbook entry confirmed by data.",
    "Live trading remained DISABLED all week (must always be true).",
  ];

  const warnings: string[] = [
    "All targets are paper-only. This plan never authorizes live trading.",
    "Live trading remains DISABLED. Build II is coaching/review only.",
  ];
  if (govStatus === "LOCKED") warnings.push("Risk Governor is LOCKED — do not paper trade until cleared.");
  if (closedLastWeek.length < 5) warnings.push("Sample size is very small — treat this plan as exploratory.");

  const plan: WeeklyPlan = {
    week_start: weekStart,
    week_end: weekEnd,
    mainGoal,
    focusAreas,
    rulesToPractice,
    mistakesToReduce,
    setupsToStudy,
    setupsToAvoid,
    paperTradingTargets,
    progressMetrics,
    reviewQuestions,
    successCriteria,
    warnings,
    persisted: false,
    persistenceNote: null,
  };

  // PERSISTENCE WITHHELD — deliberately, and reported rather than hidden.
  //
  // `weekly_improvement_plans` is UNIQUE on week_start alone and has no
  // user_id column: it can hold exactly ONE plan per calendar week for the
  // whole instance. Writing this trader's plan there would overwrite whichever
  // trader saved last, and the next reader would be shown a stranger's goals
  // as their own. Since the plan is now correctly per-user, storing it is not
  // possible without a schema change (add user_id + move the unique key to
  // (user_id, week_start)); until then the plan is computed and returned
  // live, and the caller is told plainly that it was not saved.
  if (persist) {
    plan.persistenceNote =
      "Not saved. The weekly-plan table stores one plan per week for the whole platform (no per-trader column), "
      + "so saving your plan would overwrite another trader's. This plan is generated fresh each time you open it.";
    plan.warnings = [...warnings, plan.persistenceNote];
  }
  void weeklyImprovementPlansTable;

  return plan;
}
