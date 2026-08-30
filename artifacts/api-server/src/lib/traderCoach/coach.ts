// Build II — Trader Coach Engine.
//
// SAFETY (strict freeze):
//   - Coaching/playbook/review/planning ONLY.
//   - NEVER places trades, NEVER calls MT5, NEVER enables canPlaceTrades.
//   - NEVER recommends live trading. liveTradingStatus is hardcoded
//     "DISABLED" and liveTradingAllowed is hardcoded false everywhere.

import { randomUUID } from "node:crypto";
import {
  db,
  paperOrdersTable,
  tradeDecisionLogsTable,
  postTradeDebriefsTable,
  learningEventsTable,
  strategyEdgesTable,
  mistakePatternsTable,
  autopilotCyclesTable,
  performanceDailySnapshotsTable,
  traderCoachReportsTable,
  traderCoachLogsTable,
} from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { evaluateGovernor } from "../riskGovernor/governor.js";
import { getOrCreateUserRiskSettings } from "../risk/userRiskSettings.js";
import { generatePlaybook, type PlaybookUpdateSummary } from "./playbook.js";
import {
  evaluateAutoChecklist,
  type PreSessionChecklistItem,
} from "./autoChecklist.js";

export {
  evaluateAutoChecklist,
  type AutoCheckGovernorView,
  type AutoCheckResult,
  type PreSessionChecklistItem,
} from "./autoChecklist.js";

export type CoachReportType = "DAILY" | "WEEKLY" | "SESSION" | "PLAYBOOK";

export interface CoachReport {
  coach_report_id: string;
  generated_at: string;
  mode: "PAPER_ONLY";
  liveTradingStatus: "DISABLED";
  reportType: CoachReportType;
  traderStatus: {
    readinessScore: number;
    readinessGrade: string;
    readinessLevel: string;
    governorStatus: string;
    paperTradingAllowed: boolean;
    autopilotAllowed: boolean;
    liveTradingAllowed: false;
  };
  performanceSummary: {
    totalTrades: number;
    closedTrades: number;
    winRate: number;
    netPnl: number;
    bestSymbol: string | null;
    worstSymbol: string | null;
    bestSetup: string | null;
    weakestSetup: string | null;
    decisionToWinRate: number;
    learningConfidence: number;
  };
  topStrengths: string[];
  topWeaknesses: string[];
  repeatedMistakes: { tag: string; count: number; severity: number; symbol: string; recommendedGuardrail: string }[];
  activeRiskFlags: { code: string; message: string; severity?: string }[];
  currentFocusAreas: string[];
  nextBestActions: string[];
  preSessionChecklist: PreSessionChecklistItem[];
  postSessionReviewQuestions: string[];
  /**
   * The trader's OWN session limits. Previously the coach's daily view shipped
   * a hardcoded `{ maxTradesPerDay: 5, maxLossPerDay: 100 }` next to the line
   * "Stop paper trading immediately if today's net P&L breaches the daily loss
   * limit" — two invented numbers presented as the reader's limits.
   *
   * `maxTradesPerDay` comes from the trader's risk_settings row.
   * `maxLossPerDayUsd` is the dollar figure the Risk Governor actually
   * enforces (their configured % applied to their own paper-account equity).
   * When the governor could not derive it, the value is `null` and `basis` is
   * "UNKNOWN" — never a filled-in default.
   */
  sessionLimits: {
    maxTradesPerDay: number | null;
    maxDailyLossPct: number | null;
    maxLossPerDayUsd: number | null;
    basis: string;
    note: string;
  };
  playbookUpdates: PlaybookUpdateSummary[];
  warnings: string[];
  coachingSummary: string;
  generatedBy: "SYSTEM_TRADER_COACH";
  dataSourcesRead: string[];
  missingDataSources: string[];
}

interface Logger {
  info: (m: string, x?: Record<string, unknown>) => void;
  warn: (m: string, x?: Record<string, unknown>) => void;
  error: (m: string, x?: Record<string, unknown>) => void;
}
const NOOP_LOG: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// HONESTY: this sentence is about what the COACH does, not about whether live
// trading is enabled on the reader's account — Build II has no authority over
// that and does not read it. The previous wording ("Live trading remains
// DISABLED") asserted the reader's account state, which this surface cannot
// know. `CoachReport.liveTradingStatus: "DISABLED"` is likewise the coach's own
// authority (it can never authorize a live trade), not an account reading.
const LIVE_DISABLED_REMINDER = "This coaching is PAPER-ONLY: it never authorizes, enables or recommends live execution. It does not report whether live trading is enabled on your account.";
const PAPER_MODE_REMINDER = "All guidance applies to PAPER mode only.";

const SAFE_DEFAULT_CHECKLIST: CoachReport["preSessionChecklist"] = [
  { id: "governor_ok", label: "Risk Governor status checked and not LOCKED", required: true, auto: true },
  { id: "daily_loss_ok", label: "Daily paper loss limit not yet hit", required: true, auto: true },
  { id: "no_cooldown", label: "No active per-symbol revenge cooldown", required: true, auto: true },
  { id: "data_quality", label: "Market data quality is GOOD (not DEGRADED/FALLBACK)", required: true, auto: true },
  { id: "spread_ok", label: "Spread is acceptable for the chosen symbol", required: true, auto: false },
  { id: "no_same_symbol_conflict", label: "No conflicting open paper trade on the same symbol", required: true, auto: false },
  { id: "trade_window_good", label: "Trading window is GOOD per the calendar", required: true, auto: false },
  { id: "sniper_pass", label: "Sniper score passes the configured threshold", required: true, auto: false },
  { id: "confidence_threshold", label: "AI decision confidence meets your minimum", required: true, auto: false },
  { id: "risk_score_ok", label: "AI decision risk score is below your maximum", required: true, auto: false },
  { id: "sl_tp_set", label: "Stop loss and take profit are explicitly defined", required: true, auto: false },
  { id: "live_disabled", label: "Live trading is DISABLED (Build HH check)", required: true, auto: true },
  { id: "paper_only", label: "Mode is PAPER_ONLY (no live execution attempted)", required: true, auto: true },
];

const SAFE_DEFAULT_REVIEW_QUESTIONS = [
  "Did I follow the AI decision exactly, or override it?",
  "Did I obey every Risk Governor block and warning?",
  "Did I take any trade during degraded market data or wide spread?",
  "Did I overtrade beyond the daily session plan?",
  "Did I respect every active per-symbol cooldown?",
  "Did the setup actually match a playbook entry, or was it improvised?",
  "What single mistake repeated again today?",
  "What concrete lesson should the system learn from this session?",
  "What rule should be added or tightened in the playbook?",
];

export interface GenerateCoachOptions {
  reportType?: CoachReportType;
  persist?: boolean;
  log?: Logger;
  generatePlaybookEntries?: boolean;
}

// ISOLATION: `userId` is required. Every "your win rate / your best symbol /
// your repeated mistake" sentence below is a claim about ONE trader, so every
// source that carries an owner is filtered by it. Sources that have NO owner
// column are deliberately NOT consumed — see the block marked
// INSTANCE_WIDE_SOURCES_WITHHELD.
export async function generateCoachReport(userId: number, opts: GenerateCoachOptions = {}): Promise<CoachReport> {
  const reportType: CoachReportType = opts.reportType ?? "DAILY";
  const persist = opts.persist ?? false;
  const log = opts.log ?? NOOP_LOG;
  const coachReportId = `coach_${randomUUID()}`;

  log.info("Build II: coach generation started", { coachReportId, reportType, userId });

  const dataSourcesRead: string[] = [];
  const missingDataSources: string[] = [];
  const warnings: string[] = [];

  // ── Build HH governor (read-only) ───────────────────────────────────────
  let governor: Awaited<ReturnType<typeof evaluateGovernor>> | null = null;
  try {
    governor = await evaluateGovernor({ persist: false, userId });
    dataSourcesRead.push("risk_governor_evaluations");
    log.info("Build II: governor status read", {
      governor_id: governor.governor_id,
      overallStatus: governor.overallStatus,
      paperTradingAllowed: governor.paperTradingAllowed,
    });
  } catch (e) {
    missingDataSources.push("risk_governor_evaluations");
    warnings.push("Risk Governor unavailable; coaching defaults to cautious WATCH_ONLY tone.");
    log.warn("Build II: governor unavailable", { err: String(e).slice(0, 200) });
  }

  // ── Performance data (paper trades + decisions + debriefs) ──────────────
  const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let trades: { id: number; symbol: string; status: string; pnl: number | null; decisionId: number | null; createdAt: Date }[] = [];
  let closed: typeof trades = [];
  let decisions: { id: number; symbol: string; action: string; confidence: number | null; riskScore: number | null }[] = [];
  let debriefs: { id: number; tradeId: number; result: string; biggestMistake: string | null }[] = [];
  let learnings: { id: number; symbol: string; result: string }[] = [];
  let edges: { id: number; symbol: string; signalName: string; action: string; sampleCount: number; winCount: number; lossCount: number; netPnl: number; avgPnl: number; edgeScore: number }[] = [];
  let mistakes: { id: number; tag: string; symbol: string; action: string; count: number; severityScore: number; recommendedGuardrail: string }[] = [];
  let cyclesRecent: { id: number; status: string; createdAt: Date }[] = [];

  try {
    const rows = await db.select().from(paperOrdersTable)
      .where(eq(paperOrdersTable.userId, userId));
    trades = rows.map(r => ({ id: r.id, symbol: r.symbol, status: r.status, pnl: r.profitLoss ?? null, decisionId: r.decisionId ?? null, createdAt: r.createdAt }));
    closed = trades.filter(t => t.status !== "OPEN");
    dataSourcesRead.push("paper_orders");
  } catch { missingDataSources.push("paper_orders"); }

  try {
    const rows = await db.select().from(tradeDecisionLogsTable)
      .where(and(eq(tradeDecisionLogsTable.userId, userId), gte(tradeDecisionLogsTable.createdAt, thirtyAgo)));
    decisions = rows.map(r => ({ id: r.id, symbol: r.symbol, action: r.action, confidence: r.confidence, riskScore: r.riskScore }));
    dataSourcesRead.push("trade_decision_logs");
  } catch { missingDataSources.push("trade_decision_logs"); }

  try {
    const rows = await db.select().from(postTradeDebriefsTable)
      .where(and(eq(postTradeDebriefsTable.userId, userId), gte(postTradeDebriefsTable.createdAt, thirtyAgo)));
    debriefs = rows.map(r => ({ id: r.id, tradeId: r.tradeId, result: r.result, biggestMistake: r.biggestMistake ?? null }));
    dataSourcesRead.push("post_trade_debriefs");
  } catch { missingDataSources.push("post_trade_debriefs"); }

  try {
    const rows = await db.select().from(learningEventsTable)
      .where(and(eq(learningEventsTable.userId, userId), gte(learningEventsTable.createdAt, thirtyAgo)));
    learnings = rows.map(r => ({ id: r.id, symbol: r.symbol, result: r.result }));
    dataSourcesRead.push("learning_events");
  } catch { missingDataSources.push("learning_events"); }

  try {
    edges = await db.select().from(strategyEdgesTable)
      .where(eq(strategyEdgesTable.userId, userId));
    dataSourcesRead.push("strategy_edges");
  } catch { missingDataSources.push("strategy_edges"); }

  try {
    mistakes = await db.select().from(mistakePatternsTable)
      .where(eq(mistakePatternsTable.userId, userId));
    dataSourcesRead.push("mistake_patterns");
  } catch { missingDataSources.push("mistake_patterns"); }

  try {
    const rows = await db.select().from(autopilotCyclesTable)
      .where(eq(autopilotCyclesTable.userId, userId))
      .orderBy(desc(autopilotCyclesTable.createdAt)).limit(50);
    cyclesRecent = rows.map(r => ({ id: r.id, status: r.status, createdAt: r.createdAt }));
    dataSourcesRead.push("autopilot_cycles");
  } catch { missingDataSources.push("autopilot_cycles"); }

  // ── Build GG performance snapshots (read-only) ──────────────────────────
  let dailySnaps: { date: string; netPnl: number; winRate: number; dayRating: string; dayStatus: string }[] = [];
  let symbolSnaps: { symbol: string; rangeKey: string; netPnl: number; winRate: number; edgeScore: number; learningConfidence: number }[] = [];
  let aiSnaps: { rangeKey: string; avgConfidence: number; avgRiskScore: number; avgEdgeScore: number }[] = [];
  try {
    const rows = await db.select().from(performanceDailySnapshotsTable)
      .where(eq(performanceDailySnapshotsTable.userId, userId))
      .orderBy(desc(performanceDailySnapshotsTable.date)).limit(14);
    dailySnaps = rows.map(r => ({ date: r.date, netPnl: r.netPnl, winRate: r.winRate, dayRating: r.dayRating, dayStatus: r.dayStatus }));
    dataSourcesRead.push("performance_daily_snapshots");
  } catch { missingDataSources.push("performance_daily_snapshots"); }

  // ── INSTANCE_WIDE_SOURCES_WITHHELD ──────────────────────────────────────
  // `performance_symbol_snapshots` and `ai_performance_snapshots` have NO
  // user_id column: every row is an instance-wide aggregate. They used to
  // feed sentences like "<SYMBOL> (30d snapshot): net X" straight into this
  // trader's strengths/weaknesses, which is a claim about them built from
  // everyone's trades. There is no per-user row to read, so the honest answer
  // is to withhold the claim and say why — not to keep printing a number
  // that is true of nobody. `symbolSnaps`/`aiSnaps` stay empty.
  missingDataSources.push("performance_symbol_snapshots (no per-user rows exist — withheld)");
  missingDataSources.push("ai_performance_snapshots (no per-user rows exist — withheld)");
  warnings.push(
    "Symbol-level and AI-quality snapshot sources are instance-wide (they carry no owner) and are therefore "
    + "NOT used in this report. Strengths and weaknesses below are computed only from your own paper orders, "
    + "debriefs, edges and mistake patterns.",
  );

  log.info("Build II: data sources read", { dataSourcesRead, missingDataSources });
  log.info("Build II: performance data read", { dailySnaps: dailySnaps.length, symbolSnaps: symbolSnaps.length, aiSnaps: aiSnaps.length });
  log.info("Build II: mistake patterns read", { count: mistakes.length });

  // ── Compute performance metrics ─────────────────────────────────────────
  const wins = closed.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = closed.filter(t => (t.pnl ?? 0) < 0).length;
  const netPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winRate = closed.length > 0 ? Number(((wins / closed.length) * 100).toFixed(2)) : 0;

  const bySymbolPnl = new Map<string, number>();
  for (const t of closed) bySymbolPnl.set(t.symbol, (bySymbolPnl.get(t.symbol) ?? 0) + (t.pnl ?? 0));
  const symbolEntries = [...bySymbolPnl.entries()];
  const bestSymbol = symbolEntries.length > 0 ? symbolEntries.reduce((a, b) => (a[1] >= b[1] ? a : b))[0] : null;
  const worstSymbol = symbolEntries.length > 0 ? symbolEntries.reduce((a, b) => (a[1] <= b[1] ? a : b))[0] : null;

  const edgesSorted = [...edges].sort((a, b) => b.edgeScore - a.edgeScore);
  const bestEdge = edgesSorted[0];
  const weakestEdge = edgesSorted[edgesSorted.length - 1];
  const bestSetup = bestEdge ? `${bestEdge.symbol}:${bestEdge.signalName}:${bestEdge.action}` : null;
  const weakestSetup = weakestEdge && weakestEdge !== bestEdge ? `${weakestEdge.symbol}:${weakestEdge.signalName}:${weakestEdge.action}` : null;

  // Correct linkage: paper_orders.decisionId -> trade_decision_logs.id.
  const closedDecisionIds = new Set(closed.map(t => t.decisionId).filter((x): x is number => typeof x === "number"));
  const tradedDecisions = decisions.filter(d => closedDecisionIds.has(d.id));
  const tradedDecisionWins = closed.filter(t => (t.pnl ?? 0) > 0 && t.decisionId != null && closedDecisionIds.has(t.decisionId)).length;
  const decisionToWinRate = tradedDecisions.length > 0
    ? Number(((tradedDecisionWins / tradedDecisions.length) * 100).toFixed(2))
    : 0;

  const learningConfidence = learnings.length >= 30 ? 80 : learnings.length >= 10 ? 50 : learnings.length >= 3 ? 25 : 10;

  // ── Repeated mistakes (top 5 by severity*count) ─────────────────────────
  const repeatedMistakesRanked = [...mistakes]
    .filter(m => m.count >= 2)
    .sort((a, b) => (b.severityScore * b.count) - (a.severityScore * a.count))
    .slice(0, 5)
    .map(m => ({
      tag: m.tag,
      count: m.count,
      severity: Number(m.severityScore.toFixed(1)),
      symbol: m.symbol || "ALL",
      recommendedGuardrail: m.recommendedGuardrail || `Pause and review every ${m.tag} occurrence before opening the next paper trade.`,
    }));

  // ── Top strengths / weaknesses ──────────────────────────────────────────
  const topStrengths: string[] = [];
  const topWeaknesses: string[] = [];

  if (bestEdge && bestEdge.sampleCount >= 5 && bestEdge.edgeScore > 5) {
    topStrengths.push(`${bestEdge.symbol} ${bestEdge.signalName} (${bestEdge.action}) — edge ${bestEdge.edgeScore.toFixed(1)} on ${bestEdge.sampleCount} trades.`);
  }
  if (winRate >= 55 && closed.length >= 10) topStrengths.push(`Paper win rate ${winRate}% on ${closed.length} closed trades.`);
  if (decisionToWinRate >= 55 && tradedDecisions.length >= 10) topStrengths.push(`AI decision-to-win rate ${decisionToWinRate}%.`);
  if (cyclesRecent.length > 0 && cyclesRecent.filter(c => c.status === "FAILED").length === 0) {
    topStrengths.push("Autopilot has no FAILED cycles in recent history.");
  }
  // GG-derived signals.
  const recentRatedDays = dailySnaps.filter(d => ["A", "B"].includes(d.dayRating));
  if (recentRatedDays.length >= 3) topStrengths.push(`${recentRatedDays.length} A/B-rated paper days in last ${dailySnaps.length}.`);
  const positiveSymbol30d = symbolSnaps.filter(s => s.rangeKey === "30d" && s.netPnl > 0 && s.learningConfidence >= 50).sort((a, b) => b.netPnl - a.netPnl)[0];
  if (positiveSymbol30d) topStrengths.push(`${positiveSymbol30d.symbol} (30d snapshot): net ${positiveSymbol30d.netPnl.toFixed(2)} with learning confidence ${positiveSymbol30d.learningConfidence.toFixed(0)}.`);
  const negativeSymbol30d = symbolSnaps.filter(s => s.rangeKey === "30d" && s.netPnl < 0).sort((a, b) => a.netPnl - b.netPnl)[0];
  if (negativeSymbol30d) topWeaknesses.push(`${negativeSymbol30d.symbol} (30d snapshot): net ${negativeSymbol30d.netPnl.toFixed(2)}, edge ${negativeSymbol30d.edgeScore.toFixed(1)}.`);
  const ai30 = aiSnaps.find(a => a.rangeKey === "30d");
  if (ai30 && ai30.avgRiskScore >= 60) topWeaknesses.push(`AI decisions over 30d run high-risk on average (avgRiskScore ${ai30.avgRiskScore.toFixed(1)}).`);

  if (weakestEdge && weakestEdge.sampleCount >= 5 && weakestEdge.edgeScore < -5) {
    topWeaknesses.push(`${weakestEdge.symbol} ${weakestEdge.signalName} (${weakestEdge.action}) — edge ${weakestEdge.edgeScore.toFixed(1)} on ${weakestEdge.sampleCount} trades.`);
  }
  if (closed.length >= 5 && winRate < 45) topWeaknesses.push(`Paper win rate ${winRate}% is below 45% over ${closed.length} closed trades.`);
  if (netPnl < 0 && closed.length >= 5) topWeaknesses.push(`Cumulative paper P&L is negative (${netPnl.toFixed(2)}).`);
  if (worstSymbol && (bySymbolPnl.get(worstSymbol) ?? 0) < 0) topWeaknesses.push(`${worstSymbol} is the weakest symbol with cumulative P&L ${(bySymbolPnl.get(worstSymbol) ?? 0).toFixed(2)}.`);

  // ── Active risk flags (from governor) ───────────────────────────────────
  const activeRiskFlags: CoachReport["activeRiskFlags"] = governor
    ? [
        ...governor.hardBlocks.map(b => ({ code: b.code, message: b.message, severity: b.severity })),
        ...governor.softWarnings.map(w => ({ code: w.code, message: w.message, severity: "WARN" })),
        ...governor.riskFlags.map(f => ({ code: f.code, message: f.message })),
      ]
    : [{ code: "GOVERNOR_UNAVAILABLE", message: "Risk Governor unavailable; defaulting to WATCH_ONLY guidance.", severity: "WARN" }];

  // ── Coaching tone driven by governor status ─────────────────────────────
  const govStatus = governor?.overallStatus ?? "UNKNOWN";
  const currentFocusAreas: string[] = [];
  const nextBestActions: string[] = [];

  if (govStatus === "LOCKED") {
    currentFocusAreas.push("System is LOCKED. Do not open any new paper trade. Investigate the live-trading flag immediately.");
    nextBestActions.push("Disable any live-trading flags and re-evaluate the Risk Governor before doing anything else.");
    nextBestActions.push("Switch to observe-only mode: read-only review of recent trades, debriefs, and learning events.");
  } else if (govStatus === "WATCH_ONLY") {
    currentFocusAreas.push("Watch-only mode: pause new paper trades and study what the system has already produced.");
    nextBestActions.push("Review today's debriefs and the most recent learning events before opening another paper trade.");
  } else if (govStatus === "PAPER_PAUSED") {
    currentFocusAreas.push("Paper trading is paused (cooldown or degraded data). Wait it out and rehearse the playbook.");
    nextBestActions.push("Wait out any active cooldowns and confirm market data quality is GOOD before resuming.");
  } else if (govStatus === "PAPER_CAUTION") {
    currentFocusAreas.push("Paper trading is allowed with caution. Stick to your strongest setups only.");
    nextBestActions.push("Trade only setups that already appear in the playbook with WATCHLIST or ACTIVE status.");
  } else if (govStatus === "PAPER_ALLOWED") {
    currentFocusAreas.push("Paper conditions are healthy. Continue executing the plan and capturing post-trade debriefs.");
    nextBestActions.push("Keep capturing a structured debrief for every closed paper trade — that feeds the learning engine.");
  } else {
    currentFocusAreas.push("Governor status is UNKNOWN. Default to a watch-only routine until status is confirmed.");
    nextBestActions.push("Re-run the Risk Governor evaluation and review the result before any new paper activity.");
  }

  if (repeatedMistakesRanked.length > 0) {
    currentFocusAreas.push(`Repeated mistake to fix: ${repeatedMistakesRanked[0].tag} (${repeatedMistakesRanked[0].count}× on ${repeatedMistakesRanked[0].symbol}).`);
    nextBestActions.push(`Add a hard rule: if you see ${repeatedMistakesRanked[0].tag} forming, STOP and run the post-session checklist before continuing.`);
  }

  if (learningConfidence < 30) {
    currentFocusAreas.push("Learning confidence is LOW — sample size is small. Treat all conclusions as provisional.");
    nextBestActions.push("Continue paper trading to grow the sample size before drawing strategy conclusions.");
  }

  if (weakestEdge && weakestEdge.sampleCount >= 5 && weakestEdge.edgeScore < -5) {
    nextBestActions.push(`Stop taking ${weakestEdge.symbol} ${weakestEdge.signalName} ${weakestEdge.action} setups until the edge recovers above 0.`);
  }

  // ── Always-on safety reminders ──────────────────────────────────────────
  warnings.push(LIVE_DISABLED_REMINDER);
  warnings.push(PAPER_MODE_REMINDER);
  if (learningConfidence < 30) warnings.push(`Learning confidence is ${learningConfidence}/100 — conclusions are provisional.`);
  if (governor && !governor.paperTradingAllowed) warnings.push(`Risk Governor currently blocks new paper trades (${govStatus}).`);

  // ── Pre-session checklist (governor-driven extras) ──────────────────────
  const preSessionChecklist = evaluateAutoChecklist(SAFE_DEFAULT_CHECKLIST, governor);
  if (govStatus === "LOCKED") {
    preSessionChecklist.unshift({
      id: "system_locked",
      label: "STOP — Risk Governor is LOCKED. Do NOT proceed.",
      required: true, auto: true,
      autoResult: "FAIL",
      autoDetail: "Risk Governor overall status is LOCKED.",
    });
  }

  // ── Playbook updates (optional; cheap by default) ───────────────────────
  let playbookUpdates: PlaybookUpdateSummary[] = [];
  if (opts.generatePlaybookEntries) {
    try {
      // `trading_playbook_entries` is keyed UNIQUE on (symbol, setupName,
      // actionBias) with no owner column — it is one shared library, not a
      // per-trader one. We therefore let generatePlaybook read its own
      // instance-wide sources instead of pushing THIS user's scoped edges and
      // mistakes into the shared rows (which would make the last trader to
      // press the button overwrite everyone else's entries).
      playbookUpdates = await generatePlaybook({ log });
      log.info("Build II: playbook updates created/updated", { count: playbookUpdates.length });
      warnings.push(
        "Playbook entries are a shared, platform-wide setup library (the table has no per-trader rows) — "
        + "they are not derived from your data alone.",
      );
    } catch (e) {
      warnings.push("Playbook generation failed; existing entries are unchanged.");
      log.warn("Build II: playbook generation failed", { err: String(e).slice(0, 200) });
    }
  }

  // ── Coaching summary string ─────────────────────────────────────────────
  const coachingSummary = [
    `Coach report (${reportType}) — Risk Governor status: ${govStatus}.`,
    governor ? `Readiness ${governor.readinessScore}/${governor.readinessGrade} (${governor.readinessLevel}).` : "Readiness unavailable.",
    closed.length > 0 ? `Recent paper performance: ${wins}W/${losses}L on ${closed.length} closed trades, win rate ${winRate}%, net P&L ${netPnl.toFixed(2)}.` : "No closed paper trades yet — focus on building a sample.",
    repeatedMistakesRanked.length > 0 ? `Top repeated mistake: ${repeatedMistakesRanked[0].tag} (${repeatedMistakesRanked[0].count}×).` : "No high-frequency mistake patterns detected.",
    LIVE_DISABLED_REMINDER,
  ].join(" ");

  // ── Session limits — the trader's real numbers, or an honest UNKNOWN ─────
  const gm = governor?.metrics ?? null;
  const limitDerived = gm != null && gm.dailyLossLimitBasis !== "UNKNOWN" && gm.dailyLossLimit > 0;
  let maxTradesPerDay: number | null = null;
  try {
    const rs = await getOrCreateUserRiskSettings(userId);
    maxTradesPerDay = rs.maxTradesPerDay ?? null;
    dataSourcesRead.push("risk_settings");
  } catch {
    missingDataSources.push("risk_settings");
  }
  const sessionLimits: CoachReport["sessionLimits"] = {
    maxTradesPerDay,
    maxDailyLossPct: gm?.maxDailyLossPct ?? null,
    maxLossPerDayUsd: limitDerived ? gm!.dailyLossLimit : null,
    basis: gm?.dailyLossLimitBasis ?? "UNKNOWN",
    note: limitDerived
      ? `Your configured ${gm!.maxDailyLossPct ?? "?"}% daily loss limit applied to your own paper-account equity.`
      : "Your daily loss limit could not be derived — there is no paper-account equity to apply your configured percentage to. No dollar figure is shown because none is known.",
  };
  if (!limitDerived) {
    warnings.push("Daily loss limit is UNKNOWN — the coach cannot tell you the dollar figure to stop at.");
  }
  if (maxTradesPerDay == null) {
    warnings.push("Max trades per day is UNKNOWN — your risk settings could not be read.");
  }

  log.info("Build II: warnings generated", { count: warnings.length });

  const report: CoachReport = {
    coach_report_id: coachReportId,
    generated_at: new Date().toISOString(),
    mode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED",
    reportType,
    traderStatus: {
      readinessScore: governor?.readinessScore ?? 0,
      readinessGrade: governor?.readinessGrade ?? "F",
      readinessLevel: governor?.readinessLevel ?? "NOT_READY",
      governorStatus: govStatus,
      paperTradingAllowed: governor?.paperTradingAllowed ?? false,
      autopilotAllowed: governor?.autopilotAllowed ?? false,
      liveTradingAllowed: false,
    },
    performanceSummary: {
      totalTrades: trades.length,
      closedTrades: closed.length,
      winRate,
      netPnl: Number(netPnl.toFixed(2)),
      bestSymbol,
      worstSymbol,
      bestSetup,
      weakestSetup,
      decisionToWinRate,
      learningConfidence,
    },
    topStrengths,
    topWeaknesses,
    repeatedMistakes: repeatedMistakesRanked,
    activeRiskFlags,
    currentFocusAreas,
    nextBestActions,
    preSessionChecklist,
    postSessionReviewQuestions: SAFE_DEFAULT_REVIEW_QUESTIONS,
    sessionLimits,
    playbookUpdates,
    warnings,
    coachingSummary,
    generatedBy: "SYSTEM_TRADER_COACH",
    dataSourcesRead,
    missingDataSources,
  };

  // ── Persist (optional) ──────────────────────────────────────────────────
  if (persist) {
    try {
      await db.insert(traderCoachReportsTable).values({
        userId,
        coachReportId,
        reportType,
        readinessScore: report.traderStatus.readinessScore,
        readinessGrade: report.traderStatus.readinessGrade,
        readinessLevel: report.traderStatus.readinessLevel,
        governorStatus: govStatus,
        performanceSummary: report.performanceSummary as unknown as Record<string, unknown>,
        topStrengths,
        topWeaknesses,
        repeatedMistakes: repeatedMistakesRanked as unknown as Record<string, unknown>[],
        activeRiskFlags: activeRiskFlags as unknown as Record<string, unknown>[],
        currentFocusAreas,
        nextBestActions,
        preSessionChecklist: preSessionChecklist as unknown as Record<string, unknown>[],
        postSessionReviewQuestions: SAFE_DEFAULT_REVIEW_QUESTIONS,
        playbookUpdates: playbookUpdates as unknown as Record<string, unknown>[],
        warnings,
        coachingSummary,
      });
      await db.insert(traderCoachLogsTable).values({
        coachReportId, eventType: "COACH_REPORT_STORED", severity: "INFO",
        message: `Coach report ${coachReportId} stored (${reportType}, governor=${govStatus}).`,
        details: { dataSourcesRead, missingDataSources, playbookUpdates: playbookUpdates.length } as unknown as Record<string, unknown>,
      });
      log.info("Build II: report stored", { coachReportId });
    } catch (e) {
      warnings.push("Coach report could not be persisted; returned in-memory only.");
      log.warn("Build II: persist failed", { err: String(e).slice(0, 200) });
    }
  }

  log.info("Build II: coach generation completed", { coachReportId, reportType, governorStatus: govStatus });
  return report;
}
