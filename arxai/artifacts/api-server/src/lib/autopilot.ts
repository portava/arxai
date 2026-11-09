// AI Autopilot Orchestrator + Human Control Layer.
//
// SAFETY:
// - Never calls placeLiveOrderGuarded(). Never writes live_positions /
//   mt5_commands. Never claims real broker execution.
// - LIVE_INTENT_AUTO_TESTER mode creates orders in environment
//   LIVE_TESTER_INTENT, which the OMS parks at PENDING_MT5_CONNECTION.
// - FUTURE_MT5_LIVE_AUTO is rejected at the entrypoint — visible but locked.
// - All scans/decisions go through Risk Governor 2.0 + Market Data Layer.
// - Pure in-memory state — no DB schema changes.

import { marketSimulator } from "./marketSimulator.js";
import {
  evaluateRisk, dataQuality, sessionClock, currentNewsRisk, marketHealth,
} from "./marketDataLayer.js";
import { pushDecision } from "./marketScanner.js";
import { placeOrder, fillOrder, listOrders, listPositions, pnlSummary } from "./oms.js";
import {
  platformStop, platformStopForVenue,
  type PlatformStopReaders, type PlatformStopSource,
} from "./safety/platformSwitches.js";

export type AutopilotMode =
  | "OFF" | "OBSERVE_ONLY" | "AI_ASSIST"
  | "DEMO_AUTO_SIMULATOR" | "LIVE_INTENT_AUTO_TESTER"
  | "FUTURE_MT5_LIVE_AUTO_LOCKED";

export type AutopilotState =
  | "IDLE" | "SCANNING" | "ANALYZING" | "CANDIDATE_FOUND" | "STRATEGY_MATCHING"
  | "RISK_CHECKING" | "WAITING_FOR_CONFIRMATION" | "APPROVED_FOR_SIMULATION"
  | "SUBMITTING_SIMULATOR_ORDER" | "POSITION_MONITORING" | "EXIT_MANAGEMENT"
  | "LEARNING_UPDATE" | "COOLDOWN" | "PAUSED" | "STOPPED"
  | "BLOCKED_BY_RISK" | "BLOCKED_BY_NEWS" | "BLOCKED_BY_SPREAD"
  | "BLOCKED_BY_DRAWDOWN" | "PENDING_MT5_CONNECTION";

export type DecisionAction =
  | "WAIT" | "REJECT" | "ASK_USER_APPROVAL"
  | "SUBMIT_SIMULATOR" | "CREATE_LIVE_INTENT_PENDING_MT5";

export interface AutopilotRules {
  symbols: string[];
  timeframes: string[];
  maxTrades: number;
  maxOpenPositions: number;
  maxRiskPerTradePct: number;
  maxDailyLossUsd: number;
  maxWeeklyLossUsd: number;
  minConfidence: number;
  minOpportunity: number;
  minEntrySniper: number;
  minTradeGrade: number;     // 0..100
  minRiskReward: number;
  cooldownAfterWinSec: number;
  cooldownAfterLossSec: number;
  stopAfterConsecutiveLosses: number;
  noMartingale: boolean;
  noAveragingDown: boolean;
  noRevengeTrading: boolean;
  noDuplicates: boolean;
  noTradeWithoutSL: boolean;
  noTradeWithoutTP: boolean;
}

export const DEFAULT_RULES: AutopilotRules = {
  symbols: ["EURUSD", "GBPUSD"], timeframes: ["M15"],
  maxTrades: 3, maxOpenPositions: 1,
  maxRiskPerTradePct: 0.25,
  maxDailyLossUsd: 50, maxWeeklyLossUsd: 200,
  minConfidence: 65, minOpportunity: 60, minEntrySniper: 60,
  minTradeGrade: 60, minRiskReward: 1.5,
  cooldownAfterWinSec: 300, cooldownAfterLossSec: 900,
  stopAfterConsecutiveLosses: 2,
  noMartingale: true, noAveragingDown: true, noRevengeTrading: true,
  noDuplicates: true, noTradeWithoutSL: true, noTradeWithoutTP: true,
};

export interface AutopilotSession {
  sessionId: string;
  name: string;
  mode: AutopilotMode;
  strategy: string;
  rules: AutopilotRules;
  requireApproval: boolean;
  simulatorBalance: number;
  notes?: string;
  startedAt: string;
  endedAt?: string;
  status: "ACTIVE" | "PAUSED" | "STOPPED";
}

export interface AutopilotDecision {
  decisionId: string;
  sessionId: string;
  ts: string;
  symbol: string;
  timeframe: string;
  strategy: string;
  considered: string;
  action: DecisionAction;
  reason: string;
  confidenceScore: number;
  opportunityScore: number;
  entrySniperScore: number;
  tradeGrade: number;
  riskScore: number;
  direction: "BUY" | "SELL";
  entryPrice: number; stopLoss: number; takeProfit: number; lotSize: number;
  rulesPassed: string[];
  rulesFailed: string[];
  marketHealth: string;
  newsRisk: string;
  sessionRisk: string;
  finalDecision: string;
  nextAction: string;
  orderId?: string;
  humanOverride?: { mark: "GOOD" | "BAD"; note?: string; ts: string };
  dataSource: "SIMULATOR";
  /**
   * Where the scores come from. Always SIMULATED_PRICE_DRIFT: confidence,
   * opportunity, sniper and grade are computed from the simulator's price
   * drift against its 30-bar average (scoreSetup), not by a model. riskScore
   * is 100 - grade.
   */
  scoreBasis: "SIMULATED_PRICE_DRIFT";
  /** Where newsRisk comes from: the simulator's news list, not a live calendar. */
  newsBasis: "SIMULATOR_NEWS_LIST";
  /** Plain English: the event behind newsRisk and its source, or that none was in an avoid window. */
  newsDetail: string;
}

export interface AutopilotStateLog {
  ts: string; from: AutopilotState; to: AutopilotState; reason: string;
}

export interface SafetyLock {
  code: string;
  tripped: boolean;
  reason?: string;
  ts?: string;
  /**
   * True only for a lock some autopilot code path can set. A lock nothing
   * sets was never checked, so it must not read as "clear".
   */
  evaluated: boolean;
  /** When the autopilot last checked this lock's condition; null = not checked yet. */
  lastCheckedAt: string | null;
  /** Plain English: what sets this lock, or that nothing does. */
  checks: string;
}

const sessions = new Map<string, AutopilotSession>();
const decisions: AutopilotDecision[] = [];
const stateLogs: AutopilotStateLog[] = [];

let currentMode: AutopilotMode = "OFF";
let currentState: AutopilotState = "IDLE";
let activeSessionId: string | null = null;
let lastScanTs: string | null = null;
let nextScanInSec = 30;
let cooldownUntil: number | null = null;
let consecutiveLosses = 0;

// Only KILL_SWITCH, DAILY_LOSS and WEEKLY_LOSS have a code path that sets
// them (tripLock). CONSECUTIVE_LOSSES has a tripLock call, but its counter is
// fed only by recordTradeOutcome, which nothing calls, so it can never trip.
// Every other lock is listed so the page can say it is not checked. Only
// KILL_SWITCH is read by a gate (startSession, runDecisionPipeline). A set
// lock stays set until the API server restarts: nothing calls clearLock
// outside setKillSwitch(false), which has no caller.
const NEVER_SET = "Not checked: no autopilot code sets this lock.";
function lock(code: string, evaluated: boolean, checks: string): SafetyLock {
  return { code, tripped: false, evaluated, lastCheckedAt: null, checks };
}
const safetyLocks: Record<string, SafetyLock> = {
  KILL_SWITCH: lock("KILL_SWITCH", true,
    "The autopilot's own emergency stop, set by Emergency Stop on this page. While set, new sessions and scans are refused. Nothing releases it; it clears only when the API server restarts. It is not the platform kill switch."),
  RISK_BLOCK: lock("RISK_BLOCK", false,
    `${NEVER_SET} Each scan runs the risk guard; a refusal shows in State (BLOCKED_BY_RISK) and on the decision row, not here.`),
  DAILY_LOSS: lock("DAILY_LOSS", true,
    "Set when a scan that finds a setup sees today's simulator P/L at or below the session's daily loss limit. Stays set until the API server restarts."),
  WEEKLY_LOSS: lock("WEEKLY_LOSS", true,
    "Set when a scan that finds a setup sees this week's simulator P/L at or below the session's weekly loss limit. Stays set until the API server restarts."),
  MAX_DRAWDOWN: lock("MAX_DRAWDOWN", false, `${NEVER_SET} Drawdown is not measured by the autopilot.`),
  MT5_STATUS: lock("MT5_STATUS", false, `${NEVER_SET} The autopilot does not read the MT5 connection.`),
  STALE_DATA: lock("STALE_DATA", false,
    `${NEVER_SET} Scans read data quality, but no rule or lock acts on it.`),
  WIDE_SPREAD: lock("WIDE_SPREAD", false,
    `${NEVER_SET} A wide spread on a scan shows in State (BLOCKED_BY_SPREAD) and in the decision's market health, not here.`),
  NEWS_WINDOW: lock("NEWS_WINDOW", false,
    `${NEVER_SET} A blocking news window on a scan shows in State (BLOCKED_BY_NEWS) and on the decision row, not here.`),
  CONSECUTIVE_LOSSES: lock("CONSECUTIVE_LOSSES", false,
    `${NEVER_SET} Closed trade results are not reported to the autopilot, so its losing-streak count stays 0 and this lock cannot be set.`),
  DUPLICATE_ORDER: lock("DUPLICATE_ORDER", false,
    `${NEVER_SET} A duplicate order on a scan is refused and named on the decision row, not here.`),
  AUDIT_FAIL: lock("AUDIT_FAIL", false, `${NEVER_SET} The audit trail is not watched by the autopilot.`),
  OMS_FAIL: lock("OMS_FAIL", false, `${NEVER_SET} An OMS refusal is named on the decision row, not here.`),
  POSITION_MGR_FAIL: lock("POSITION_MGR_FAIL", false, `${NEVER_SET} The position manager is not watched by the autopilot.`),
};

function newId(prefix: string) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function nowIso() { return new Date().toISOString(); }

function transition(to: AutopilotState, reason: string) {
  const from = currentState;
  if (from === to) return;
  currentState = to;
  stateLogs.push({ ts: nowIso(), from, to, reason });
  if (stateLogs.length > 1000) stateLogs.shift();
  pushDecision({ type: "AUTOPILOT_STATE", summary: `${from} → ${to}: ${reason}`, payload: { from, to } });
}

function markChecked(code: string) { const l = safetyLocks[code]; if (l) l.lastCheckedAt = nowIso(); }
function tripLock(code: string, reason: string) {
  const l = safetyLocks[code]; if (!l) return;
  l.lastCheckedAt = nowIso();
  if (!l.tripped) {
    l.tripped = true; l.reason = reason; l.ts = nowIso();
    pushDecision({ type: "AUTOPILOT_LOCK_TRIPPED", summary: `Safety lock ${code}: ${reason}`, payload: l });
    transition("PAUSED", `Autopilot paused by safety system: ${reason}`);
  }
}
function clearLock(code: string) { const l = safetyLocks[code]; if (l) { l.tripped = false; l.reason = undefined; l.ts = nowIso(); } }

export function setKillSwitch(on: boolean) {
  if (on) tripLock("KILL_SWITCH", "Emergency kill switch engaged");
  else clearLock("KILL_SWITCH");
}

// ── Session lifecycle ──────────────────────────────────────────────────────
export interface StartSessionInput {
  name: string;
  mode: AutopilotMode;
  strategy?: string;
  rules?: Partial<AutopilotRules>;
  requireApproval?: boolean;
  simulatorBalance?: number;
  notes?: string;
}

export function startSession(input: StartSessionInput): AutopilotSession | { error: string } {
  if (input.mode === "FUTURE_MT5_LIVE_AUTO_LOCKED") {
    return { error: "FUTURE_MT5_LIVE_AUTO_LOCKED is locked until MT5 bridge is connected, verified, risk approved, and manually armed." };
  }
  if (safetyLocks.KILL_SWITCH.tripped) return { error: "Kill switch active." };
  // Stop any prior session.
  if (activeSessionId) stopSession();
  const s: AutopilotSession = {
    sessionId: newId("aps"),
    name: input.name,
    mode: input.mode,
    strategy: input.strategy ?? "trend",
    rules: { ...DEFAULT_RULES, ...(input.rules ?? {}) },
    requireApproval: input.requireApproval ?? (input.mode === "AI_ASSIST"),
    simulatorBalance: input.simulatorBalance ?? 10_000,
    notes: input.notes,
    startedAt: nowIso(),
    status: "ACTIVE",
  };
  sessions.set(s.sessionId, s);
  activeSessionId = s.sessionId;
  currentMode = s.mode;
  consecutiveLosses = 0; cooldownUntil = null;
  transition("SCANNING", `Session ${s.sessionId} started in ${s.mode}`);
  return s;
}

export function pauseSession(): AutopilotSession | { error: string } {
  if (!activeSessionId) return { error: "No active session." };
  const s = sessions.get(activeSessionId)!;
  s.status = "PAUSED";
  transition("PAUSED", "Pause requested");
  return s;
}
export function resumeSession(): AutopilotSession | { error: string } {
  if (!activeSessionId) return { error: "No active session." };
  const s = sessions.get(activeSessionId)!;
  s.status = "ACTIVE";
  transition("SCANNING", "Resume requested");
  return s;
}
export function stopSession(): AutopilotSession | { error: string } {
  if (!activeSessionId) return { error: "No active session." };
  const s = sessions.get(activeSessionId)!;
  s.status = "STOPPED"; s.endedAt = nowIso();
  transition("STOPPED", "Stop requested");
  currentMode = "OFF";
  activeSessionId = null;
  return s;
}

export function listSessions() { return Array.from(sessions.values()).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)); }
export function getSession(id: string) { return sessions.get(id) ?? null; }

// ── Synthetic scoring (mock AI signal until real model wired) ──────────────
function scoreSetup(symbol: string) {
  const q = marketSimulator.quote(symbol);
  if (!q) return null;
  const candles = marketSimulator.candlesFor(symbol, 30);
  if (candles.length < 20) return null;
  const closes = candles.map((c) => c.c);
  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
  const last = closes[closes.length - 1];
  const direction: "BUY" | "SELL" = last > sma ? "BUY" : "SELL";
  // mock scores deterministic-ish on price.
  const drift = Math.abs(last - sma) / sma;
  const conf = Math.min(95, 60 + Math.round(drift * 50_000));
  const opp = Math.min(95, 55 + Math.round(drift * 60_000));
  const sniper = Math.min(95, 50 + Math.round(drift * 70_000));
  const grade = Math.round((conf + opp + sniper) / 3);
  // SL/TP from ATR-ish.
  const range = candles.slice(-14).reduce((a, c) => a + (c.h - c.l), 0) / 14;
  const sl = direction === "BUY" ? Number((q.bid - 1.2 * range).toFixed(5)) : Number((q.ask + 1.2 * range).toFixed(5));
  const tp = direction === "BUY" ? Number((q.bid + 2.4 * range).toFixed(5)) : Number((q.ask - 2.4 * range).toFixed(5));
  return { symbol, direction, entryPrice: q.mid, stopLoss: sl, takeProfit: tp, confidence: conf, opportunity: opp, sniper, grade };
}

/**
 * Orders the MAX_TRADES rule counts: every non-MANUAL simulator order created
 * today (UTC), from any user and any source. status() reports the same count
 * so "trades remaining" agrees with the rule.
 */
function ordersCountedTowardMaxTrades(): number {
  const today = new Date().toISOString().slice(0, 10);
  return listOrders({}).filter((o) => o.createdAt.slice(0, 10) === today && o.source !== "MANUAL").length;
}

// ── Decision pipeline ──────────────────────────────────────────────────────
export interface RunPipelineOptions {
  force?: boolean;
  symbol?: string;
  /**
   * The operator driving this run. Simulator orders are evaluated by the
   * pre-trade Risk Governor against this user's limits and stop switches; a
   * run with no accountable user decides but never places an order.
   */
  actorUserId?: number;
}

export async function runDecisionPipeline(opts: RunPipelineOptions = {}): Promise<AutopilotDecision | { error: string }> {
  if (!activeSessionId) return { error: "No active session." };
  const session = sessions.get(activeSessionId)!;
  if (session.status === "STOPPED") return { error: "Session stopped." };
  if (session.status === "PAUSED" && !opts.force) return { error: "Session paused." };
  if (currentMode === "OFF") return { error: "Autopilot OFF." };
  if (safetyLocks.KILL_SWITCH.tripped) return { error: "Kill switch active." };

  if (cooldownUntil && Date.now() < cooldownUntil && !opts.force) {
    transition("COOLDOWN", "Cooldown in effect");
    return { error: `Cooldown for ${Math.round((cooldownUntil - Date.now()) / 1000)}s` };
  }
  transition("SCANNING", "Pipeline tick");

  const symbol = opts.symbol ?? session.rules.symbols[Math.floor(Math.random() * session.rules.symbols.length)];
  const tf = session.rules.timeframes[0];
  lastScanTs = nowIso();

  // 1-4: market data, quality, session, news
  const dq = dataQuality(symbol, tf);
  const sc = sessionClock();
  const nr = currentNewsRisk(symbol);
  const mh = marketHealth(symbol, tf);

  const rulesPassed: string[] = []; const rulesFailed: string[] = [];

  // 5-7: pick a candidate.
  transition("ANALYZING", `Score ${symbol}`);
  const setup = scoreSetup(symbol);
  if (!setup) {
    return finalize({
      session, symbol, tf, action: "WAIT", reason: "No setup data",
      confidence: 0, opportunity: 0, sniper: 0, grade: 0,
      direction: "BUY", entryPrice: 0, stopLoss: 0, takeProfit: 0, lotSize: 0,
      rulesPassed, rulesFailed: ["NO_DATA"], dq, mh, nr, sc,
      next: "Wait for next tick",
    });
  }
  transition("CANDIDATE_FOUND", `${symbol} ${setup.direction}`);

  // 8-11: trade card score & grade (already in setup).
  // 12: pre-checks against rules.
  if (setup.confidence < session.rules.minConfidence) rulesFailed.push("MIN_CONFIDENCE"); else rulesPassed.push("MIN_CONFIDENCE");
  if (setup.opportunity < session.rules.minOpportunity) rulesFailed.push("MIN_OPPORTUNITY"); else rulesPassed.push("MIN_OPPORTUNITY");
  if (setup.sniper < session.rules.minEntrySniper) rulesFailed.push("MIN_ENTRY_SNIPER"); else rulesPassed.push("MIN_ENTRY_SNIPER");
  if (setup.grade < session.rules.minTradeGrade) rulesFailed.push("MIN_TRADE_GRADE"); else rulesPassed.push("MIN_TRADE_GRADE");
  if (session.rules.noTradeWithoutSL && setup.stopLoss == null) rulesFailed.push("REQUIRE_SL"); else rulesPassed.push("REQUIRE_SL");
  if (session.rules.noTradeWithoutTP && setup.takeProfit == null) rulesFailed.push("REQUIRE_TP"); else rulesPassed.push("REQUIRE_TP");

  // capacity rules
  const openPos = listPositions({ status: "OPEN" }).length;
  if (openPos >= session.rules.maxOpenPositions) rulesFailed.push("MAX_OPEN_POSITIONS"); else rulesPassed.push("MAX_OPEN_POSITIONS");
  const todayOrders = ordersCountedTowardMaxTrades();
  if (todayOrders >= session.rules.maxTrades) rulesFailed.push("MAX_TRADES"); else rulesPassed.push("MAX_TRADES");

  const pnl = pnlSummary();
  markChecked("DAILY_LOSS"); markChecked("WEEKLY_LOSS");
  if (pnl.dailyPnL <= -session.rules.maxDailyLossUsd) { rulesFailed.push("DAILY_LOSS"); tripLock("DAILY_LOSS", `Daily loss ${pnl.dailyPnL}`); }
  if (pnl.weeklyPnL <= -session.rules.maxWeeklyLossUsd) { rulesFailed.push("WEEKLY_LOSS"); tripLock("WEEKLY_LOSS", `Weekly loss ${pnl.weeklyPnL}`); }
  if (consecutiveLosses >= session.rules.stopAfterConsecutiveLosses) { rulesFailed.push("CONSECUTIVE_LOSSES"); tripLock("CONSECUTIVE_LOSSES", `${consecutiveLosses} losses in a row`); }

  // Run Risk Governor 2.0
  transition("RISK_CHECKING", "Risk governor");
  const guard = evaluateRisk({
    symbol: setup.symbol, direction: setup.direction, entryPrice: setup.entryPrice,
    stopLoss: setup.stopLoss, takeProfit: setup.takeProfit, lotSize: 0.05,
    confidenceScore: setup.confidence, maxLossUsd: 15,
  });
  for (const r of guard.reasons) rulesFailed.push(`RISK:${r}`);

  // Block-categorising state
  if (nr.blocking) { transition("BLOCKED_BY_NEWS", "News risk window"); }
  else if (mh.labels.includes("HIGH_SPREAD")) { transition("BLOCKED_BY_SPREAD", "Spread too wide"); }
  else if (rulesFailed.includes("DAILY_LOSS") || rulesFailed.includes("WEEKLY_LOSS")) { transition("BLOCKED_BY_DRAWDOWN", "Loss limit"); }
  else if (!guard.approved) { transition("BLOCKED_BY_RISK", guard.reasons.join("; ")); }

  // 14: decide action
  let action: DecisionAction;
  if (currentMode === "OBSERVE_ONLY") action = "WAIT";
  else if (rulesFailed.length > 0) action = "REJECT";
  else if (currentMode === "AI_ASSIST" || session.requireApproval) action = "ASK_USER_APPROVAL";
  else if (currentMode === "DEMO_AUTO_SIMULATOR") action = "SUBMIT_SIMULATOR";
  else if (currentMode === "LIVE_INTENT_AUTO_TESTER") action = "CREATE_LIVE_INTENT_PENDING_MT5";
  else action = "WAIT";

  // 13: duplicate guard
  if ((action === "SUBMIT_SIMULATOR" || action === "CREATE_LIVE_INTENT_PENDING_MT5") && session.rules.noDuplicates) {
    const recent = listOrders({}).find((o) =>
      o.symbol === setup.symbol && o.direction === setup.direction &&
      Date.now() - Date.parse(o.createdAt) < 60_000);
    if (recent) { rulesFailed.push("DUPLICATE_ORDER"); action = "REJECT"; }
  }

  if ((action === "SUBMIT_SIMULATOR" || action === "CREATE_LIVE_INTENT_PENDING_MT5") && opts.actorUserId == null) {
    rulesFailed.push("NO_ACCOUNTABLE_OPERATOR");
    action = "REJECT";
  }
  const actor = { userId: opts.actorUserId ?? 0 };

  let orderId: string | undefined;
  if (action === "SUBMIT_SIMULATOR") {
    transition("SUBMITTING_SIMULATOR_ORDER", "Submit simulator");
    const { order: o } = await placeOrder({
      environment: "DEMO_SIMULATOR", source: "AI_AUTO",
      symbol: setup.symbol, direction: setup.direction, lotSize: 0.05,
      entryPrice: setup.entryPrice, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit,
      riskAmount: 15, confidenceScore: setup.confidence, opportunityScore: setup.opportunity,
      entrySniperScore: setup.sniper, strategyId: session.strategy,
    }, actor);
    if (o.status === "APPROVED_FOR_SIMULATION") { await fillOrder(o.orderId, actor); }
    if (o.status === "RISK_REJECTED") rulesFailed.push(`OMS:${o.rejectionReason ?? o.status}`);
    orderId = o.orderId;
    transition("POSITION_MONITORING", "Order submitted");
  } else if (action === "CREATE_LIVE_INTENT_PENDING_MT5") {
    const { order: o } = await placeOrder({
      environment: "LIVE_TESTER_INTENT", source: "AI_AUTO",
      symbol: setup.symbol, direction: setup.direction, lotSize: 0.01,
      entryPrice: setup.entryPrice, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit,
      riskAmount: 15, confidenceScore: setup.confidence, opportunityScore: setup.opportunity,
      entrySniperScore: setup.sniper, strategyId: session.strategy,
    }, actor);
    orderId = o.orderId;
    transition("PENDING_MT5_CONNECTION", "Live intent parked");
  } else if (action === "ASK_USER_APPROVAL") {
    transition("WAITING_FOR_CONFIRMATION", "Awaiting human approval");
  } else if (action === "REJECT") {
    transition("LEARNING_UPDATE", "Rejected → log");
  } else {
    transition("LEARNING_UPDATE", "Wait");
  }

  const lotSizeUsed = currentMode === "LIVE_INTENT_AUTO_TESTER" ? 0.01 : 0.05;
  return finalize({
    session, symbol: setup.symbol, tf, action,
    reason: rulesFailed.length ? rulesFailed.join("; ") : `Setup ${setup.direction} confidence=${setup.confidence}`,
    confidence: setup.confidence, opportunity: setup.opportunity, sniper: setup.sniper, grade: setup.grade,
    direction: setup.direction,
    entryPrice: setup.entryPrice, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit, lotSize: lotSizeUsed,
    rulesPassed, rulesFailed, dq, mh, nr, sc,
    next: action === "SUBMIT_SIMULATOR" ? "Monitor simulator position"
        : action === "CREATE_LIVE_INTENT_PENDING_MT5" ? "Wait for MT5 bridge"
        : action === "ASK_USER_APPROVAL" ? "Awaiting human approval"
        : "Wait for next tick",
    orderId,
  });
}

interface FinalizeArgs {
  session: AutopilotSession; symbol: string; tf: string;
  action: DecisionAction; reason: string;
  confidence: number; opportunity: number; sniper: number; grade: number;
  direction: "BUY" | "SELL";
  entryPrice: number; stopLoss: number; takeProfit: number; lotSize: number;
  rulesPassed: string[]; rulesFailed: string[];
  dq: ReturnType<typeof dataQuality>; mh: ReturnType<typeof marketHealth>;
  nr: ReturnType<typeof currentNewsRisk>; sc: ReturnType<typeof sessionClock>;
  next: string; orderId?: string;
}
function newsDetailOf(nr: ReturnType<typeof currentNewsRisk>): string {
  const hit = nr.events.find((e) => e.inWindow && e.event.impact === "high");
  if (hit) {
    const src = hit.event.source === "SIMULATED" ? "simulated event" : hit.event.source === "MANUAL" ? "added by hand" : "external event";
    return `${hit.event.eventName} (${src}) is in its avoid window. Source: the simulator's news list, not a live economic calendar.`;
  }
  return "No high-impact event in an avoid window on the simulator's news list. This is not a live economic calendar.";
}

function finalize(a: FinalizeArgs): AutopilotDecision {
  const d: AutopilotDecision = {
    decisionId: newId("apd"),
    sessionId: a.session.sessionId,
    ts: nowIso(),
    symbol: a.symbol, timeframe: a.tf, strategy: a.session.strategy,
    considered: `Score conf=${a.confidence} opp=${a.opportunity} sniper=${a.sniper} grade=${a.grade}`,
    action: a.action, reason: a.reason,
    confidenceScore: a.confidence, opportunityScore: a.opportunity,
    entrySniperScore: a.sniper, tradeGrade: a.grade,
    riskScore: Math.max(0, 100 - a.grade),
    direction: a.direction,
    entryPrice: a.entryPrice, stopLoss: a.stopLoss, takeProfit: a.takeProfit, lotSize: a.lotSize,
    rulesPassed: a.rulesPassed, rulesFailed: a.rulesFailed,
    marketHealth: a.mh.labels.join(","),
    newsRisk: a.nr.blocking ? "BLOCKING" : "CLEAR",
    sessionRisk: a.sc.sessionLabel,
    finalDecision: a.action, nextAction: a.next,
    orderId: a.orderId,
    dataSource: "SIMULATOR",
    scoreBasis: "SIMULATED_PRICE_DRIFT",
    newsBasis: "SIMULATOR_NEWS_LIST",
    newsDetail: newsDetailOf(a.nr),
  };
  decisions.unshift(d);
  if (decisions.length > 500) decisions.pop();
  pushDecision({ type: "AUTOPILOT_DECISION", summary: `${d.symbol} ${d.action} — ${d.reason}`, payload: { id: d.decisionId, action: d.action } });
  return d;
}

// ── Human override ─────────────────────────────────────────────────────────
export async function humanOverride(input: { kind: "APPROVE" | "REJECT" | "PAUSE" | "RESUME" | "STOP" | "EMERGENCY_STOP" | "FORCE_SCAN"; decisionId?: string; note?: string; actorUserId?: number }) {
  pushDecision({ type: "HUMAN_OVERRIDE", summary: `Override ${input.kind}${input.decisionId ? " on " + input.decisionId : ""}`, payload: input });
  switch (input.kind) {
    case "PAUSE": return pauseSession();
    case "RESUME": return resumeSession();
    case "STOP": return stopSession();
    case "EMERGENCY_STOP": setKillSwitch(true); return stopSession();
    case "FORCE_SCAN": return runDecisionPipeline({ force: true, actorUserId: input.actorUserId });
    case "APPROVE": case "REJECT": {
      if (!input.decisionId) return { error: "decisionId required" };
      const d = decisions.find((x) => x.decisionId === input.decisionId);
      if (!d) return { error: "decision not found" };
      if (input.kind === "APPROVE" && d.action === "ASK_USER_APPROVAL") {
        if (input.actorUserId == null) return { error: "An operator must approve the order." };
        const actor = { userId: input.actorUserId, origin: "manual" as const };
        const { order: o } = await placeOrder({
          environment: "DEMO_SIMULATOR", source: "AI_ASSIST",
          symbol: d.symbol, direction: d.direction, lotSize: d.lotSize || 0.05,
          entryPrice: d.entryPrice, stopLoss: d.stopLoss, takeProfit: d.takeProfit,
          riskAmount: 15, confidenceScore: d.confidenceScore,
          opportunityScore: d.opportunityScore, entrySniperScore: d.entrySniperScore,
          strategyId: d.strategy,
        }, actor);
        d.orderId = o.orderId;
        if (o.status === "APPROVED_FOR_SIMULATION") {
          await fillOrder(o.orderId, actor);
          d.action = "SUBMIT_SIMULATOR";
          d.finalDecision = "SUBMIT_SIMULATOR";
          d.nextAction = "Monitor simulator position";
        } else {
          d.action = "REJECT";
          d.finalDecision = "REJECT";
          d.nextAction = `OMS rejected: ${o.rejectionReason ?? o.status}`;
          d.rulesFailed = [...d.rulesFailed, `OMS:${o.rejectionReason ?? o.status}`];
        }
      }
      return d;
    }
  }
}
export function markDecision(decisionId: string, mark: "GOOD" | "BAD", note?: string) {
  const d = decisions.find((x) => x.decisionId === decisionId);
  if (!d) return null;
  d.humanOverride = { mark, note, ts: nowIso() };
  pushDecision({ type: "AI_DECISION_MARKED", summary: `Decision ${decisionId} marked ${mark}`, payload: d.humanOverride });
  return d;
}

// ── Status & reporting ─────────────────────────────────────────────────────
export function status() {
  const session = activeSessionId ? sessions.get(activeSessionId) : null;
  const lastDecision = decisions[0] ?? null;
  const pnl = pnlSummary();
  const openPos = listPositions({ status: "OPEN" });
  const counted = ordersCountedTowardMaxTrades();
  const remaining = session ? Math.max(0, session.rules.maxTrades - counted) : 0;
  const dailyRiskRemaining = session ? Math.max(0, session.rules.maxDailyLossUsd + Math.min(0, pnl.dailyPnL)) : 0;
  return {
    mode: currentMode, state: currentState,
    session, activeSessionId,
    lastScanTs, nextScanInSec,
    cooldownUntil,
    consecutiveLosses,
    /** False: nothing reports closed trade results to the autopilot (recordTradeOutcome has no caller), so consecutiveLosses stays 0. */
    consecutiveLossesMeasured: false as const,
    openSimulatedPositions: openPos.length,
    dailyRiskRemainingUsd: dailyRiskRemaining,
    dailyTradesRemaining: remaining,
    /** Today's orders the MAX_TRADES rule counts (every non-manual simulator order, any user). */
    tradesCountedToday: counted,
    /**
     * Open positions and daily P/L (behind dailyRiskRemainingUsd) are the
     * whole simulator book, every user, not the operator's own. With no
     * session, dailyRiskRemainingUsd and dailyTradesRemaining are 0 because
     * there is no limit to measure against, not because it is used up.
     */
    bookScope: "ALL_SIMULATOR_USERS" as const,
    activeRiskLocks: Object.values(safetyLocks).filter((l) => l.tripped).map((l) => l.code),
    mt5Connected: false,
    killSwitchEngaged: safetyLocks.KILL_SWITCH.tripped,
    lastDecision,
    discipline: discipline(),
    /** How many recent decisions (last 50) discipline is based on; 0 = nothing to measure. */
    disciplineDecisions: Math.min(decisions.length, 50),
    dataSource: "SIMULATOR" as const,
  };
}

export function discipline() {
  const recent = decisions.slice(0, 50);
  if (recent.length === 0) return 100;
  const overrides = recent.filter((d) => d.humanOverride?.mark === "BAD").length;
  return Math.max(0, 100 - overrides * 5);
}

export function listDecisions(limit = 100) { return decisions.slice(0, limit); }
export function getStateMachine() { return { current: currentState, log: stateLogs.slice(-100) }; }
export function getSafetyLocks(): SafetyLock[] {
  // The emergency stop is an in-memory flag, so reading it is checking it.
  const now = nowIso();
  return Object.values(safetyLocks).map((l) => (l.code === "KILL_SWITCH" ? { ...l, lastCheckedAt: now } : { ...l }));
}

/** One install-wide stop as it bears on the autopilot. */
export interface AutopilotPlatformStopSource {
  source: PlatformStopSource;
  reason: string | null;
  engagedAt: string | null;
  /** True when the pre-trade Risk Governor refuses the autopilot's simulator (paper) orders because of it. */
  haltsAutopilotOrders: boolean;
}

/**
 * The platform's install-wide stops (emergency stop, safety-core kill switch)
 * as they bear on the autopilot. The autopilot itself does not read them:
 * sessions start and scans decide whatever they say. Its orders are simulator
 * (paper venue) orders, which the pre-trade Risk Governor refuses while the
 * safety-core kill switch is engaged; the emergency stop does not halt paper.
 * Display only — this adds no gate.
 */
export interface AutopilotPlatformStop {
  /** False when either stop could not be read (the Risk Governor then treats it as engaged). */
  readable: boolean;
  engaged: boolean;
  sources: AutopilotPlatformStopSource[];
  haltsAutopilotOrders: boolean;
  /** Always false: no autopilot code reads these stops. */
  readByAutopilot: false;
  checkedAt: string;
}

export async function autopilotPlatformStop(readers: PlatformStopReaders = {}): Promise<AutopilotPlatformStop> {
  const stop = await platformStop(readers);
  const paper = platformStopForVenue(stop, "PAPER");
  return {
    readable: stop.readable,
    engaged: stop.engaged,
    sources: stop.sources.map((source) => ({
      source,
      reason: stop.detail[source] ?? null,
      engagedAt: stop.engagedAt?.[source]?.toISOString() ?? null,
      haltsAutopilotOrders: paper.sources.includes(source),
    })),
    haltsAutopilotOrders: paper.engaged,
    readByAutopilot: false,
    checkedAt: nowIso(),
  };
}

export function generateReport(sessionId?: string) {
  const sid = sessionId ?? activeSessionId; if (!sid) return { error: "no session" };
  const s = sessions.get(sid); if (!s) return { error: "not found" };
  const sd = decisions.filter((d) => d.sessionId === sid);
  const orders = listOrders({}).filter((o) => o.source === "AI_AUTO" || o.source === "AI_ASSIST");
  const closed = listPositions({}).filter((p) => p.status !== "OPEN");
  const wins = closed.filter((p) => p.realizedPnL > 0).length;
  const losses = closed.filter((p) => p.realizedPnL < 0).length;
  const netPnL = Number(closed.reduce((a, b) => a + b.realizedPnL, 0).toFixed(2));
  const avgGrade = sd.length ? Math.round(sd.reduce((a, b) => a + b.tradeGrade, 0) / sd.length) : 0;
  const avgConf = sd.length ? Math.round(sd.reduce((a, b) => a + b.confidenceScore, 0) / sd.length) : 0;
  const avgOpp = sd.length ? Math.round(sd.reduce((a, b) => a + b.opportunityScore, 0) / sd.length) : 0;
  const blocks = sd.filter((d) => d.action === "REJECT").length;
  return {
    sessionId: sid,
    mode: s.mode, strategy: s.strategy, symbols: s.rules.symbols,
    startedAt: s.startedAt, endedAt: s.endedAt,
    totalScans: sd.length,
    candidates: sd.filter((d) => d.action !== "WAIT").length,
    rejected: blocks,
    simulated: orders.filter((o) => o.environment === "DEMO_SIMULATOR").length,
    liveIntents: orders.filter((o) => o.environment === "LIVE_TESTER_INTENT").length,
    wins, losses, netSimulatedPnL: netPnL,
    averageTradeGrade: avgGrade, averageConfidence: avgConf, averageOpportunity: avgOpp,
    riskBlocksTriggered: getSafetyLocks().filter((l) => l.tripped).map((l) => l.code),
    bestDecision: sd.find((d) => d.tradeGrade >= 80)?.decisionId ?? null,
    worstDecision: sd.find((d) => d.tradeGrade < 50)?.decisionId ?? null,
    learning: {
      improveOn: avgGrade < 70 ? "Raise minTradeGrade or refine strategy" : "Continue current approach",
      strongestStrategy: s.strategy,
    },
    recommendedNext: blocks > sd.length / 2 ? "Loosen rules or pick different session window" : "Continue with current session profile",
    dataSource: "SIMULATOR" as const,
  };
}

// Hook position closes into consecutive-loss tracking (called on tick).
export function recordTradeOutcome(realizedPnL: number) {
  if (realizedPnL > 0) { consecutiveLosses = 0; cooldownUntil = Date.now() + DEFAULT_RULES.cooldownAfterWinSec * 1000; }
  else if (realizedPnL < 0) { consecutiveLosses += 1; cooldownUntil = Date.now() + DEFAULT_RULES.cooldownAfterLossSec * 1000; }
}
