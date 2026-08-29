// Risk Governor 2.0 — Account Protection layer.
//
// SAFETY:
// - Never calls placeLiveOrderGuarded(). Never writes live_positions /
//   mt5_commands. Pure in-memory state.
// - Sits ABOVE the existing per-trade evaluateRisk(); cannot bypass it.
// - For LIVE_TESTER_INTENT, rejection here returns REJECTED_BY_RISK; the OMS
//   never sends to a broker either way.
// - For FUTURE_MT5_*, every check returns BLOCK with reason
//   FUTURE_MT5_NOT_PERMITTED.
// - dataSource is always "SIMULATOR".

import { listOrders, listPositions, pnlSummary } from "./oms.js";
import { currentNewsRisk, marketHealth } from "./marketDataLayer.js";

export type RiskStatus = "OK" | "CAUTION" | "BLOCK";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "BLOCK";

export interface RiskProfile {
  profileName: string;
  preset: "ULTRA_CONSERVATIVE" | "CONSERVATIVE" | "BALANCED_TESTER" | "AGGRESSIVE_SIMULATOR" | "PROP_FIRM_CHALLENGE" | "CUSTOM";
  startingBalance: number;
  currentBalance: number;
  maxRiskPerTradeUsd: number;
  maxDailyLossUsd: number;
  maxWeeklyLossUsd: number;
  maxMonthlyDrawdownUsd: number;
  maxOpenPositions: number;
  maxOpenPerSymbol: number;
  maxTradesPerDay: number;
  maxAiTradesPerSession: number;
  maxAiTradesPerDay: number;
  maxLotSize: number;
  minRiskReward: number;
  minAiConfidence: number;
  minEntrySniper: number;
  minOpportunity: number;
  stopAfterConsecutiveLosses: number;
  cooldownAfterLossSec: number;
  cooldownAfterWinSec: number;
  allowedSymbols: string[];
  blockedSymbols: string[];
  allowedSessions: string[];
  blockedSessions: string[];
}

const PRESETS: Record<RiskProfile["preset"], Partial<RiskProfile>> = {
  ULTRA_CONSERVATIVE: { maxRiskPerTradeUsd: 5, maxDailyLossUsd: 15, maxWeeklyLossUsd: 50, maxMonthlyDrawdownUsd: 100,
    maxOpenPositions: 1, maxOpenPerSymbol: 1, maxTradesPerDay: 2, maxAiTradesPerSession: 1, maxAiTradesPerDay: 2,
    maxLotSize: 0.02, minRiskReward: 2.5, minAiConfidence: 80, minEntrySniper: 75, minOpportunity: 75,
    stopAfterConsecutiveLosses: 1, cooldownAfterLossSec: 1800, cooldownAfterWinSec: 600 },
  CONSERVATIVE: { maxRiskPerTradeUsd: 15, maxDailyLossUsd: 50, maxWeeklyLossUsd: 200, maxMonthlyDrawdownUsd: 500,
    maxOpenPositions: 2, maxOpenPerSymbol: 1, maxTradesPerDay: 5, maxAiTradesPerSession: 3, maxAiTradesPerDay: 5,
    maxLotSize: 0.05, minRiskReward: 1.8, minAiConfidence: 70, minEntrySniper: 65, minOpportunity: 65,
    stopAfterConsecutiveLosses: 2, cooldownAfterLossSec: 900, cooldownAfterWinSec: 300 },
  BALANCED_TESTER: { maxRiskPerTradeUsd: 30, maxDailyLossUsd: 150, maxWeeklyLossUsd: 500, maxMonthlyDrawdownUsd: 1500,
    maxOpenPositions: 3, maxOpenPerSymbol: 2, maxTradesPerDay: 10, maxAiTradesPerSession: 5, maxAiTradesPerDay: 10,
    maxLotSize: 0.10, minRiskReward: 1.5, minAiConfidence: 60, minEntrySniper: 55, minOpportunity: 55,
    stopAfterConsecutiveLosses: 3, cooldownAfterLossSec: 600, cooldownAfterWinSec: 120 },
  AGGRESSIVE_SIMULATOR: { maxRiskPerTradeUsd: 100, maxDailyLossUsd: 500, maxWeeklyLossUsd: 2000, maxMonthlyDrawdownUsd: 5000,
    maxOpenPositions: 5, maxOpenPerSymbol: 3, maxTradesPerDay: 25, maxAiTradesPerSession: 10, maxAiTradesPerDay: 25,
    maxLotSize: 0.50, minRiskReward: 1.2, minAiConfidence: 55, minEntrySniper: 50, minOpportunity: 50,
    stopAfterConsecutiveLosses: 5, cooldownAfterLossSec: 120, cooldownAfterWinSec: 30 },
  PROP_FIRM_CHALLENGE: { maxRiskPerTradeUsd: 50, maxDailyLossUsd: 250, maxWeeklyLossUsd: 750, maxMonthlyDrawdownUsd: 1000,
    maxOpenPositions: 3, maxOpenPerSymbol: 1, maxTradesPerDay: 8, maxAiTradesPerSession: 4, maxAiTradesPerDay: 8,
    maxLotSize: 0.20, minRiskReward: 2.0, minAiConfidence: 70, minEntrySniper: 65, minOpportunity: 65,
    stopAfterConsecutiveLosses: 2, cooldownAfterLossSec: 1200, cooldownAfterWinSec: 300 },
  CUSTOM: {},
};

function basePreset(): RiskProfile {
  return {
    profileName: "Default Conservative",
    preset: "CONSERVATIVE",
    startingBalance: 10_000, currentBalance: 10_000,
    maxRiskPerTradeUsd: 15, maxDailyLossUsd: 50, maxWeeklyLossUsd: 200, maxMonthlyDrawdownUsd: 500,
    maxOpenPositions: 2, maxOpenPerSymbol: 1, maxTradesPerDay: 5,
    maxAiTradesPerSession: 3, maxAiTradesPerDay: 5,
    maxLotSize: 0.05, minRiskReward: 1.8,
    minAiConfidence: 70, minEntrySniper: 65, minOpportunity: 65,
    stopAfterConsecutiveLosses: 2, cooldownAfterLossSec: 900, cooldownAfterWinSec: 300,
    allowedSymbols: [], blockedSymbols: [],
    allowedSessions: [], blockedSessions: [],
  };
}

let profile: RiskProfile = basePreset();
let tradingPaused = false;
let pauseReason: string | null = null;
let simulatorDayResetAt: string | null = null;

export function getProfile(): RiskProfile { return profile; }
export function setProfile(input: Partial<RiskProfile> & { preset?: RiskProfile["preset"] }): RiskProfile {
  if (input.preset && input.preset !== "CUSTOM") {
    profile = { ...basePreset(), ...PRESETS[input.preset], ...input, preset: input.preset };
  } else {
    profile = { ...profile, ...input };
  }
  emitEvent({ severity: "INFO", rule: "PROFILE_UPDATED", decision: "OK", explanation: `Profile set to ${profile.preset}` });
  return profile;
}
export function applyPreset(preset: RiskProfile["preset"]): RiskProfile { return setProfile({ preset }); }

// ── Risk events ────────────────────────────────────────────────────────────
export interface RiskEvent {
  eventId: string; ts: string;
  environment?: string; symbol?: string; source?: string; orderId?: string;
  rule: string; severity: "INFO" | "WARN" | "BLOCK";
  decision: string; explanation: string; auditLogId?: string;
}
const events: RiskEvent[] = [];
function emitEvent(e: Omit<RiskEvent, "eventId" | "ts">): RiskEvent {
  const r: RiskEvent = { eventId: `re_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), ...e };
  events.unshift(r);
  if (events.length > 1000) events.pop();
  return r;
}
export function listEvents(limit = 200) { return events.slice(0, limit); }

// ── Risk budget engine ─────────────────────────────────────────────────────
export interface RiskBudget {
  dailyRiskLimit: number; dailyRiskUsed: number; dailyRiskRemaining: number;
  weeklyRiskLimit: number; weeklyRiskUsed: number; weeklyRiskRemaining: number;
  openRisk: number;
  perEnvironment: Record<string, number>;
  perSymbol: Record<string, number>;
  perStrategy: Record<string, number>;
  aiVsManual: { ai: number; manual: number };
  currentDrawdownUsd: number; peakEquity: number; maxDrawdownAllowed: number;
  riskStatus: RiskStatus;
}

export function riskBudget(): RiskBudget {
  const summary = pnlSummary();
  const dailyLost = Math.max(0, -summary.dailyPnL);
  const weeklyLost = Math.max(0, -summary.weeklyPnL);
  const openPositions = listPositions({ status: "OPEN" });
  // USD risk per open = lots × |entry - SL| × pipValuePerLot. Falls back to a
  // conservative 100 USD/lot estimate if SL or entry is missing.
  const openRisk = openPositions.reduce((a, p) => {
    if (p.stopLoss == null || p.entryPrice == null) return a + p.lotSize * 100;
    const dist = Math.abs(p.entryPrice - p.stopLoss);
    const pipVal = p.symbol.includes("JPY") ? 9.0 : p.symbol.startsWith("XAU") ? 10.0 : 10.0;
    return a + p.lotSize * dist * pipVal * 10_000; // approx; SIMULATOR-only
  }, 0);
  const perEnv: Record<string, number> = {};
  const perSym: Record<string, number> = {};
  const perStrat: Record<string, number> = {};
  let aiPnL = 0, manualPnL = 0;
  for (const o of listOrders({})) {
    const env = o.environment; perEnv[env] = (perEnv[env] ?? 0) + (o.riskAmount ?? 0);
    perSym[o.symbol] = (perSym[o.symbol] ?? 0) + (o.riskAmount ?? 0);
    if (o.strategyId) perStrat[String(o.strategyId)] = (perStrat[String(o.strategyId)] ?? 0) + (o.riskAmount ?? 0);
    if (o.source === "AI_AUTO" || o.source === "AI_ASSIST") aiPnL += o.riskAmount ?? 0; else manualPnL += o.riskAmount ?? 0;
  }
  const peakEquity = profile.startingBalance + Math.max(0, summary.closedRealizedPnL);
  const currentEquity = profile.startingBalance + summary.closedRealizedPnL + summary.openUnrealizedPnL;
  const dd = Math.max(0, peakEquity - currentEquity);

  let riskStatus: RiskStatus = "OK";
  if (dailyLost >= profile.maxDailyLossUsd || weeklyLost >= profile.maxWeeklyLossUsd ||
      dd >= profile.maxMonthlyDrawdownUsd) riskStatus = "BLOCK";
  else if (dailyLost > profile.maxDailyLossUsd * 0.7 || dd > profile.maxMonthlyDrawdownUsd * 0.5) riskStatus = "CAUTION";

  return {
    dailyRiskLimit: profile.maxDailyLossUsd, dailyRiskUsed: Number(dailyLost.toFixed(2)),
    dailyRiskRemaining: Number((profile.maxDailyLossUsd - dailyLost).toFixed(2)),
    weeklyRiskLimit: profile.maxWeeklyLossUsd, weeklyRiskUsed: Number(weeklyLost.toFixed(2)),
    weeklyRiskRemaining: Number((profile.maxWeeklyLossUsd - weeklyLost).toFixed(2)),
    openRisk: Number(openRisk.toFixed(2)),
    perEnvironment: perEnv, perSymbol: perSym, perStrategy: perStrat,
    aiVsManual: { ai: Number(aiPnL.toFixed(2)), manual: Number(manualPnL.toFixed(2)) },
    currentDrawdownUsd: Number(dd.toFixed(2)),
    peakEquity: Number(peakEquity.toFixed(2)),
    maxDrawdownAllowed: profile.maxMonthlyDrawdownUsd,
    riskStatus,
  };
}

// ── Exposure manager ───────────────────────────────────────────────────────
const CORRELATION_GROUPS: Record<string, string> = {
  EURUSD: "USD_MAJORS", GBPUSD: "USD_MAJORS", AUDUSD: "USD_MAJORS",
  USDJPY: "USD_INVERSE", USDCHF: "USD_INVERSE", USDCAD: "USD_INVERSE",
  XAUUSD: "USD_METALS",
  BTCUSDT: "CRYPTO_MAJORS", ETHUSDT: "CRYPTO_MAJORS",
  AAPL: "TECH_EQUITIES", TSLA: "TECH_EQUITIES", NASDAQ: "TECH_EQUITIES",
};

export interface ExposureReport {
  perSymbol: Record<string, number>;
  perDirection: Record<string, number>;
  perStrategy: Record<string, number>;
  perGroup: Record<string, number>;
  signals: Array<{ kind: string; severity: "WARN" | "BLOCK"; message: string }>;
  status: RiskStatus;
}

export function exposure(): ExposureReport {
  const open = listPositions({ status: "OPEN" });
  const perSymbol: Record<string, number> = {};
  const perDirection: Record<string, number> = { BUY: 0, SELL: 0 };
  const perStrategy: Record<string, number> = {};
  const perGroup: Record<string, number> = {};
  for (const p of open) {
    perSymbol[p.symbol] = (perSymbol[p.symbol] ?? 0) + 1;
    perDirection[p.direction] = (perDirection[p.direction] ?? 0) + 1;
    const g = CORRELATION_GROUPS[p.symbol]; if (g) perGroup[g] = (perGroup[g] ?? 0) + 1;
  }
  const signals: ExposureReport["signals"] = [];
  if (open.length > profile.maxOpenPositions) signals.push({ kind: "TOO_MANY_OPEN", severity: "BLOCK", message: `${open.length} > max ${profile.maxOpenPositions}` });
  for (const [sym, n] of Object.entries(perSymbol)) {
    if (n > profile.maxOpenPerSymbol) signals.push({ kind: "SYMBOL_OVER_EXPOSED", severity: "BLOCK", message: `${sym}: ${n} > ${profile.maxOpenPerSymbol}` });
  }
  for (const [grp, n] of Object.entries(perGroup)) {
    if (n >= 3) signals.push({ kind: "CORRELATED_GROUP", severity: "WARN", message: `${grp} has ${n} open` });
  }
  const status: RiskStatus = signals.some((s) => s.severity === "BLOCK") ? "BLOCK"
    : signals.length ? "CAUTION" : "OK";
  return { perSymbol, perDirection, perStrategy, perGroup, signals, status };
}

// ── Drawdown protection ────────────────────────────────────────────────────
export interface DrawdownReport {
  dailyDrawdownUsd: number; weeklyDrawdownUsd: number;
  monthlyDrawdownUsd: number; consecutiveLosses: number;
  locks: Array<{ code: string; tripped: boolean; reason?: string }>;
  status: RiskStatus;
}
function consecutiveLosses(): number {
  const closed = listPositions({}).filter((p) => p.status !== "OPEN")
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  let n = 0; for (const p of closed) { if (p.realizedPnL < 0) n++; else break; }
  return n;
}
export function drawdown(): DrawdownReport {
  const b = riskBudget();
  const cl = consecutiveLosses();
  const locks: DrawdownReport["locks"] = [
    { code: "DAILY_LOSS", tripped: b.dailyRiskUsed >= profile.maxDailyLossUsd, reason: `used ${b.dailyRiskUsed}/${profile.maxDailyLossUsd}` },
    { code: "WEEKLY_LOSS", tripped: b.weeklyRiskUsed >= profile.maxWeeklyLossUsd, reason: `used ${b.weeklyRiskUsed}/${profile.maxWeeklyLossUsd}` },
    { code: "MONTHLY_DRAWDOWN", tripped: b.currentDrawdownUsd >= profile.maxMonthlyDrawdownUsd, reason: `dd ${b.currentDrawdownUsd}/${profile.maxMonthlyDrawdownUsd}` },
    { code: "CONSECUTIVE_LOSSES", tripped: cl >= profile.stopAfterConsecutiveLosses, reason: `${cl} losses in a row` },
  ];
  const status: RiskStatus = locks.some((l) => l.tripped) ? "BLOCK"
    : b.currentDrawdownUsd > profile.maxMonthlyDrawdownUsd * 0.5 ? "CAUTION" : "OK";
  return { dailyDrawdownUsd: b.dailyRiskUsed, weeklyDrawdownUsd: b.weeklyRiskUsed,
    monthlyDrawdownUsd: b.currentDrawdownUsd, consecutiveLosses: cl, locks, status };
}

// ── Overtrading + revenge detector ────────────────────────────────────────
export type OvertradingLabel = "NORMAL" | "CAUTION" | "OVERTRADING_RISK" | "REVENGE_TRADING_RISK" | "HARD_BLOCK";
export interface OvertradingReport {
  label: OvertradingLabel;
  tradesLast15m: number; tradesLastHour: number; tradesToday: number;
  rapidReentryAfterLoss: boolean;
  increasingLotSize: boolean;
  repeatedSetupAfterReject: number;
  reasons: string[];
}
export function overtrading(): OvertradingReport {
  const now = Date.now();
  const ord = listOrders({}).filter((o) => o.source !== "MANUAL" || true);
  const last15m = ord.filter((o) => now - Date.parse(o.createdAt) <= 15 * 60_000).length;
  const lastHour = ord.filter((o) => now - Date.parse(o.createdAt) <= 60 * 60_000).length;
  const today = ord.filter((o) => o.createdAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const closed = listPositions({}).filter((p) => p.status !== "OPEN")
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  let rapid = false;
  if (closed.length > 0 && closed[0].realizedPnL < 0) {
    const newest = ord[0];
    if (newest && Date.parse(newest.createdAt) - Date.parse(closed[0].openedAt) < 60_000) rapid = true;
  }
  let increasingLot = false;
  if (closed.length >= 2 && closed[0].lotSize > closed[1].lotSize && closed[1].realizedPnL < 0) increasingLot = true;
  const rejected = listOrders({ status: "RISK_REJECTED" }).slice(0, 10);
  const repeats: Record<string, number> = {};
  for (const r of rejected) repeats[`${r.symbol}-${r.direction}`] = (repeats[`${r.symbol}-${r.direction}`] ?? 0) + 1;
  const repeatedSetup = Math.max(0, ...Object.values(repeats));

  const reasons: string[] = [];
  let label: OvertradingLabel = "NORMAL";
  if (today >= profile.maxTradesPerDay) { reasons.push("DAILY_LIMIT"); label = "HARD_BLOCK"; }
  if (last15m >= 5) { reasons.push("RAPID_TRADING"); label = label === "HARD_BLOCK" ? label : "OVERTRADING_RISK"; }
  if (rapid) { reasons.push("RAPID_REENTRY_AFTER_LOSS"); label = label === "HARD_BLOCK" ? label : "REVENGE_TRADING_RISK"; }
  if (increasingLot) { reasons.push("INCREASING_LOT_AFTER_LOSS"); label = label === "HARD_BLOCK" ? label : "REVENGE_TRADING_RISK"; }
  if (repeatedSetup >= 3) { reasons.push("REPEATED_REJECTED_SETUP"); label = label === "HARD_BLOCK" ? label : "OVERTRADING_RISK"; }
  if (lastHour >= 8 && label === "NORMAL") label = "CAUTION";
  return { label, tradesLast15m: last15m, tradesLastHour: lastHour, tradesToday: today,
    rapidReentryAfterLoss: rapid, increasingLotSize: increasingLot, repeatedSetupAfterReject: repeatedSetup, reasons };
}

// ── Pre-trade checklist ────────────────────────────────────────────────────
export interface PreTradeInput {
  environment: string; source: string; symbol: string; direction: "BUY" | "SELL";
  lotSize: number; entryPrice?: number; stopLoss?: number; takeProfit?: number;
  riskAmount?: number; confidenceScore?: number; entrySniperScore?: number; opportunityScore?: number;
  idempotencyKey?: string;
}
export interface PreTradeResult {
  approved: boolean;
  riskLevel: RiskLevel;
  hardBlocks: string[]; warnings: string[];
  riskBudget: RiskBudget; exposure: ExposureReport; drawdown: DrawdownReport; overtrading: OvertradingReport;
  requiredChanges: string[];
  dataSource: "SIMULATOR";
}

export function preTradeCheck(t: PreTradeInput): PreTradeResult {
  const hard: string[] = []; const warn: string[] = []; const need: string[] = [];

  if (t.environment.startsWith("FUTURE_MT5")) hard.push("FUTURE_MT5_NOT_PERMITTED");
  if (tradingPaused) hard.push(`TRADING_PAUSED:${pauseReason ?? ""}`);

  if (profile.allowedSymbols.length && !profile.allowedSymbols.includes(t.symbol)) hard.push("SYMBOL_NOT_ALLOWED");
  if (profile.blockedSymbols.includes(t.symbol)) hard.push("SYMBOL_BLOCKED");

  if (t.lotSize > profile.maxLotSize) { hard.push("MAX_LOT_EXCEEDED"); need.push(`Reduce lot to ≤ ${profile.maxLotSize}`); }
  if ((t.riskAmount ?? 0) > profile.maxRiskPerTradeUsd) { hard.push("MAX_RISK_PER_TRADE"); need.push(`Reduce risk to ≤ $${profile.maxRiskPerTradeUsd}`); }
  if (t.stopLoss == null) { hard.push("MISSING_STOP_LOSS"); need.push("Add stop-loss"); }
  if (t.takeProfit == null) { hard.push("MISSING_TAKE_PROFIT"); need.push("Add take-profit or exit logic"); }

  if (t.stopLoss != null && t.takeProfit != null && t.entryPrice != null) {
    const r = Math.abs(t.takeProfit - t.entryPrice) / Math.max(0.0000001, Math.abs(t.entryPrice - t.stopLoss));
    if (r < profile.minRiskReward) { hard.push("RR_TOO_LOW"); need.push(`R:R ≥ ${profile.minRiskReward}`); }
  }

  const mh = marketHealth(t.symbol, "M15");
  if (mh.labels.includes("HIGH_SPREAD")) warn.push("WIDE_SPREAD");
  if (mh.labels.includes("HIGH_VOLATILITY")) warn.push("HIGH_VOLATILITY");

  const news = currentNewsRisk(t.symbol);
  if (news.blocking) hard.push("NEWS_RISK_WINDOW");
  if (propFirm.enabled && !propFirm.newsTradingAllowed && news.blocking) hard.push("PROP_FIRM_NEWS_VIOLATION");
  if (propFirm.enabled && t.lotSize > propFirm.maxLotSize) hard.push("PROP_FIRM_MAX_LOT");

  const exp = exposure();
  for (const s of exp.signals) if (s.severity === "BLOCK") hard.push(`EXPOSURE:${s.kind}`); else warn.push(`EXPOSURE:${s.kind}`);

  const dd = drawdown();
  for (const l of dd.locks) if (l.tripped) hard.push(`DRAWDOWN:${l.code}`);

  const ot = overtrading();
  if (ot.label === "HARD_BLOCK") hard.push(`OVERTRADING:${ot.reasons.join(",")}`);
  else if (ot.label !== "NORMAL") warn.push(`OVERTRADING:${ot.label}`);

  if (t.source === "AI_AUTO" || t.source === "AI_ASSIST") {
    if ((t.confidenceScore ?? 0) < profile.minAiConfidence) hard.push("AI_CONFIDENCE_TOO_LOW");
    if ((t.entrySniperScore ?? 0) < profile.minEntrySniper) warn.push("ENTRY_SNIPER_BELOW_MIN");
    if ((t.opportunityScore ?? 0) < profile.minOpportunity) warn.push("OPPORTUNITY_BELOW_MIN");
  }

  if (t.idempotencyKey) {
    const dup = listOrders({}).find((o) => o.idempotencyKey === t.idempotencyKey);
    if (dup) hard.push("DUPLICATE_IDEMPOTENCY_KEY");
  } else {
    const recent = listOrders({}).find((o) => o.symbol === t.symbol && o.direction === t.direction
      && Date.now() - Date.parse(o.createdAt) < 30_000 && o.lotSize === t.lotSize);
    if (recent) warn.push("DUPLICATE_RECENT_ORDER");
  }

  const budget = riskBudget();
  if (budget.riskStatus === "BLOCK") hard.push(`BUDGET:${budget.riskStatus}`);
  else if (budget.riskStatus === "CAUTION") warn.push("BUDGET_CAUTION");

  const approved = hard.length === 0;
  const riskLevel: RiskLevel = !approved ? "BLOCK"
    : warn.length >= 3 ? "HIGH"
    : warn.length >= 1 ? "MEDIUM" : "LOW";

  emitEvent({
    environment: t.environment, symbol: t.symbol, source: t.source,
    rule: "PRE_TRADE_CHECK",
    severity: approved ? "INFO" : "BLOCK",
    decision: approved ? `APPROVED_${riskLevel}` : "REJECTED",
    explanation: approved ? `Warnings: ${warn.join(", ") || "none"}` : `Blocks: ${hard.join(", ")}`,
  });

  return { approved, riskLevel, hardBlocks: hard, warnings: warn,
    riskBudget: budget, exposure: exp, drawdown: dd, overtrading: ot,
    requiredChanges: need, dataSource: "SIMULATOR" };
}

// ── Trading pause / resume ────────────────────────────────────────────────
//
// SCOPE (do not overstate this in any UI copy — the audit caught the Risk
// Command Center claiming "Pause/resume halts every dispatch surface"):
//   `tradingPaused` is a MODULE-LEVEL boolean. Its only readers are
//   lib/acceptance.ts and this file's own preTradeCheck — i.e. the in-memory
//   simulator OMS and shadow mode. NOTHING in lib/live/ or lib/phase6/ imports
//   this module, so pausing here does NOT stop MT5 live dispatch or the Deriv
//   guided path. It is process-wide (not per user) and is lost on restart.
//   The control that halts live dispatch is the safety-core kill switch
//   (/emergency → safety_core.kill_switch_engaged), which liveCommandPipeline
//   and guidedDispatchEntry both read fail-closed.
export function pauseTrading(reason: string) { tradingPaused = true; pauseReason = reason; emitEvent({ rule: "PAUSE", severity: "BLOCK", decision: "PAUSED", explanation: reason }); return { paused: tradingPaused, reason }; }
export function resumeTrading() { tradingPaused = false; pauseReason = null; emitEvent({ rule: "RESUME", severity: "INFO", decision: "RESUMED", explanation: "Trading resumed" }); return { paused: false }; }
export function isPaused() { return { paused: tradingPaused, reason: pauseReason }; }
export function resetSimulatorDay() {
  simulatorDayResetAt = new Date().toISOString();
  emitEvent({ rule: "SIMULATOR_DAY_RESET", severity: "INFO", decision: "RESET", explanation: `Reset at ${simulatorDayResetAt}` });
  return { reset: true, ts: simulatorDayResetAt };
}

// ── Permissions ───────────────────────────────────────────────────────────
export function permissions() {
  const dd = drawdown();
  const blocked = tradingPaused || dd.status === "BLOCK";
  return {
    aiTrading: !blocked,
    manualTrading: !blocked,
    simulator: !blocked,
    liveTesterIntent: !blocked, // OMS still parks at PENDING_MT5
    futureMt5: false, // permanently false until bridge implemented
    pauseReason: pauseReason ?? (dd.status === "BLOCK" ? "DRAWDOWN_LOCK" : null),
  };
}

// ── Prop Firm Mode ────────────────────────────────────────────────────────
export interface PropFirmConfig {
  enabled: boolean;
  startingBalance: number;
  profitTarget: number;
  maxDailyDrawdownUsd: number;
  maxTotalDrawdownUsd: number;
  minTradingDays: number;
  maxLotSize: number;
  maxPositions: number;
  newsTradingAllowed: boolean;
  weekendHoldingAllowed: boolean;
  consistencyRulePctOfTotal: number;
}
let propFirm: PropFirmConfig = {
  enabled: false, startingBalance: 100_000, profitTarget: 8_000,
  maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 10_000, minTradingDays: 5,
  maxLotSize: 1.0, maxPositions: 3, newsTradingAllowed: false,
  weekendHoldingAllowed: false, consistencyRulePctOfTotal: 40,
};
export function propFirmConfigure(p: Partial<PropFirmConfig>): PropFirmConfig { propFirm = { ...propFirm, ...p, enabled: p.enabled ?? propFirm.enabled }; return propFirm; }
export function propFirmReset(): PropFirmConfig { propFirm = { ...propFirm, enabled: true }; return propFirm; }
export function propFirmStatus() {
  const summary = pnlSummary();
  const profit = summary.closedRealizedPnL;
  const profitPct = profit / propFirm.profitTarget;
  const dailyDD = Math.max(0, -summary.dailyPnL);
  const totalDD = Math.max(0, -profit);
  const passed: string[] = []; const failed: string[] = [];
  if (profit >= propFirm.profitTarget) passed.push("PROFIT_TARGET"); else if (profit < 0) failed.push("PROFIT_NEGATIVE");
  if (dailyDD >= propFirm.maxDailyDrawdownUsd) failed.push("DAILY_DD"); else passed.push("DAILY_DD");
  if (totalDD >= propFirm.maxTotalDrawdownUsd) failed.push("TOTAL_DD"); else passed.push("TOTAL_DD");
  let status: "ACTIVE" | "WARNING" | "FAILED" | "PASSED" = "ACTIVE";
  if (failed.length) status = "FAILED";
  else if (profit >= propFirm.profitTarget) status = "PASSED";
  else if (dailyDD > propFirm.maxDailyDrawdownUsd * 0.7 || totalDD > propFirm.maxTotalDrawdownUsd * 0.7) status = "WARNING";
  return {
    config: propFirm, profitUsd: Number(profit.toFixed(2)),
    profitTargetProgress: Number((profitPct * 100).toFixed(1)),
    dailyDrawdownRemainingUsd: Number((propFirm.maxDailyDrawdownUsd - dailyDD).toFixed(2)),
    totalDrawdownRemainingUsd: Number((propFirm.maxTotalDrawdownUsd - totalDD).toFixed(2)),
    passed, failed, status, dataSource: "SIMULATOR" as const,
  };
}

export function dashboardCards() {
  const b = riskBudget();
  const dd = drawdown();
  const exp = exposure();
  const ot = overtrading();
  const perm = permissions();
  const decisions = events.slice(0, 50);
  const aiBlocks = decisions.filter((e) => e.severity === "BLOCK" && e.source && e.source.startsWith("AI")).length;
  const aiTotal = decisions.filter((e) => e.source && e.source.startsWith("AI")).length || 1;
  const aiDiscipline = Math.max(0, 100 - Math.round((aiBlocks / aiTotal) * 100));
  return {
    riskStatus: b.riskStatus,
    dailyRiskRemaining: b.dailyRiskRemaining,
    openRisk: b.openRisk,
    drawdownStatus: dd.status,
    exposureStatus: exp.status,
    overtradingRisk: ot.label,
    activeRiskLocks: dd.locks.filter((l) => l.tripped).map((l) => l.code),
    propFirm: propFirm.enabled ? propFirmStatus() : null,
    aiRiskDiscipline: aiDiscipline,
    permissions: perm,
    dataSource: "SIMULATOR" as const,
  };
}

// Hook called by OMS to log every order outcome.
export function logOrderOutcome(args: { orderId: string; symbol: string; environment: string; source: string; status: string; reason?: string; auditLogId?: string | number }) {
  emitEvent({
    orderId: args.orderId, symbol: args.symbol, environment: args.environment, source: args.source,
    rule: "ORDER_OUTCOME",
    severity: args.status === "RISK_REJECTED" || args.status === "REJECTED_BY_RISK" ? "BLOCK" : "INFO",
    decision: args.status, explanation: args.reason ?? "OK", auditLogId: args.auditLogId != null ? String(args.auditLogId) : undefined,
  });
}
