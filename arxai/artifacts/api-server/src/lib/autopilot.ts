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
import { createOrder, submitToSimulator, listOrders, listPositions, pnlSummary } from "./oms.js";

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
}

export interface AutopilotStateLog {
  ts: string; from: AutopilotState; to: AutopilotState; reason: string;
}

export interface SafetyLock { code: string; tripped: boolean; reason?: string; ts?: string; }

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

const safetyLocks: Record<string, SafetyLock> = {
  KILL_SWITCH: { code: "KILL_SWITCH", tripped: false },
  RISK_BLOCK: { code: "RISK_BLOCK", tripped: false },
  DAILY_LOSS: { code: "DAILY_LOSS", tripped: false },
  WEEKLY_LOSS: { code: "WEEKLY_LOSS", tripped: false },
  MAX_DRAWDOWN: { code: "MAX_DRAWDOWN", tripped: false },
  MT5_STATUS: { code: "MT5_STATUS", tripped: false, reason: "MT5 deferred — not active" },
  STALE_DATA: { code: "STALE_DATA", tripped: false },
  WIDE_SPREAD: { code: "WIDE_SPREAD", tripped: false },
  NEWS_WINDOW: { code: "NEWS_WINDOW", tripped: false },
  CONSECUTIVE_LOSSES: { code: "CONSECUTIVE_LOSSES", tripped: false },
  DUPLICATE_ORDER: { code: "DUPLICATE_ORDER", tripped: false },
  AUDIT_FAIL: { code: "AUDIT_FAIL", tripped: false },
  OMS_FAIL: { code: "OMS_FAIL", tripped: false },
  POSITION_MGR_FAIL: { code: "POSITION_MGR_FAIL", tripped: false },
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

function tripLock(code: string, reason: string) {
  const l = safetyLocks[code]; if (!l) return;
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

// ── Decision pipeline ──────────────────────────────────────────────────────
export interface RunPipelineOptions { force?: boolean; symbol?: string; }

export function runDecisionPipeline(opts: RunPipelineOptions = {}): AutopilotDecision | { error: string } {
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
  const todayOrders = listOrders({}).filter((o) => o.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10) && o.source !== "MANUAL").length;
  if (todayOrders >= session.rules.maxTrades) rulesFailed.push("MAX_TRADES"); else rulesPassed.push("MAX_TRADES");

  const pnl = pnlSummary();
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

  let orderId: string | undefined;
  if (action === "SUBMIT_SIMULATOR") {
    transition("SUBMITTING_SIMULATOR_ORDER", "Submit simulator");
    const o = createOrder({
      environment: "DEMO_SIMULATOR", source: "AI_AUTO",
      symbol: setup.symbol, direction: setup.direction, lotSize: 0.05,
      entryPrice: setup.entryPrice, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit,
      riskAmount: 15, confidenceScore: setup.confidence, opportunityScore: setup.opportunity,
      entrySniperScore: setup.sniper, strategyId: session.strategy,
    });
    if (o.status === "APPROVED_FOR_SIMULATION") { submitToSimulator(o.orderId); }
    orderId = o.orderId;
    transition("POSITION_MONITORING", "Order submitted");
  } else if (action === "CREATE_LIVE_INTENT_PENDING_MT5") {
    const o = createOrder({
      environment: "LIVE_TESTER_INTENT", source: "AI_AUTO",
      symbol: setup.symbol, direction: setup.direction, lotSize: 0.01,
      entryPrice: setup.entryPrice, stopLoss: setup.stopLoss, takeProfit: setup.takeProfit,
      riskAmount: 15, confidenceScore: setup.confidence, opportunityScore: setup.opportunity,
      entrySniperScore: setup.sniper, strategyId: session.strategy,
    });
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
  };
  decisions.unshift(d);
  if (decisions.length > 500) decisions.pop();
  pushDecision({ type: "AUTOPILOT_DECISION", summary: `${d.symbol} ${d.action} — ${d.reason}`, payload: { id: d.decisionId, action: d.action } });
  return d;
}

// ── Human override ─────────────────────────────────────────────────────────
export function humanOverride(input: { kind: "APPROVE" | "REJECT" | "PAUSE" | "RESUME" | "STOP" | "EMERGENCY_STOP" | "FORCE_SCAN"; decisionId?: string; note?: string }) {
  pushDecision({ type: "HUMAN_OVERRIDE", summary: `Override ${input.kind}${input.decisionId ? " on " + input.decisionId : ""}`, payload: input });
  switch (input.kind) {
    case "PAUSE": return pauseSession();
    case "RESUME": return resumeSession();
    case "STOP": return stopSession();
    case "EMERGENCY_STOP": setKillSwitch(true); return stopSession();
    case "FORCE_SCAN": return runDecisionPipeline({ force: true });
    case "APPROVE": case "REJECT": {
      if (!input.decisionId) return { error: "decisionId required" };
      const d = decisions.find((x) => x.decisionId === input.decisionId);
      if (!d) return { error: "decision not found" };
      if (input.kind === "APPROVE" && d.action === "ASK_USER_APPROVAL") {
        const o = createOrder({
          environment: "DEMO_SIMULATOR", source: "AI_ASSIST",
          symbol: d.symbol, direction: d.direction, lotSize: d.lotSize || 0.05,
          entryPrice: d.entryPrice, stopLoss: d.stopLoss, takeProfit: d.takeProfit,
          riskAmount: 15, confidenceScore: d.confidenceScore,
          opportunityScore: d.opportunityScore, entrySniperScore: d.entrySniperScore,
          strategyId: d.strategy,
        });
        d.orderId = o.orderId;
        if (o.status === "APPROVED_FOR_SIMULATION") {
          submitToSimulator(o.orderId);
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
  const todayAuto = listOrders({}).filter((o) => o.source === "AI_AUTO" && o.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const remaining = session ? Math.max(0, session.rules.maxTrades - todayAuto) : 0;
  const dailyRiskRemaining = session ? Math.max(0, session.rules.maxDailyLossUsd + Math.min(0, pnl.dailyPnL)) : 0;
  return {
    mode: currentMode, state: currentState,
    session, activeSessionId,
    lastScanTs, nextScanInSec,
    cooldownUntil,
    consecutiveLosses,
    openSimulatedPositions: openPos.length,
    dailyRiskRemainingUsd: dailyRiskRemaining,
    dailyTradesRemaining: remaining,
    activeRiskLocks: Object.values(safetyLocks).filter((l) => l.tripped).map((l) => l.code),
    mt5Connected: false,
    killSwitchEngaged: safetyLocks.KILL_SWITCH.tripped,
    lastDecision,
    discipline: discipline(),
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
export function getSafetyLocks() { return Object.values(safetyLocks); }

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
