// Build PP — Paper Session Manager.
//
// SAFETY: PAPER_ONLY. Never places trades. Never enables live trading.
// Never modifies canPlaceTrades. Never calls broker order functions. Never
// calls MT5 live execution. Never recommends live trading. Reads existing
// AA-OO surfaces to coordinate session lifecycle and reporting.

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  paperSessionsTable,
  paperSessionEventsTable,
  paperSessionTradeLinksTable,
  paperSessionReportsTable,
  notificationsTable,
} from "@workspace/db/schema";
import { sql, desc, eq, and, gte } from "drizzle-orm";

import { getGateStatus } from "../readiness/gate.js";
import { evaluateGovernor } from "../riskGovernor/governor.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SessionStatus = "READY" | "ACTIVE" | "PAUSED" | "ENDED" | "BLOCKED" | "FAILED";

export interface SessionGoals {
  mainGoal: string;
  focusAreas: string[];
  setupsToWatch: string[];
  setupsToAvoid: string[];
  mistakeToAvoid: string[];
  maxRiskPerPaperTrade: number;
  qualityThreshold: number;
  notes: string;
}

export interface SessionRules {
  maxSessionMinutes: number;
  maxPaperTrades: number;
  maxDailyPaperLoss: number;
  maxSessionLoss: number;
  maxConsecutiveLosses: number;
  maxSameSymbolTrades: number;
  requirePreflightPass: boolean;
  requireRiskGovernorPass: boolean;
  requireReadinessGatePass: boolean;
  requireNoCriticalAlerts: boolean;
  requirePaperOnlyMode: boolean;
  allowPaperAutopilot: boolean;
  allowManualPaperTrades: boolean;
  requireDebriefAfterClose: boolean;
  requireSessionReport: boolean;
  liveTradingAllowed: false;
}

export const DEFAULT_RULES: SessionRules = {
  maxSessionMinutes: 120,
  maxPaperTrades: 5,
  maxDailyPaperLoss: 300,
  maxSessionLoss: 150,
  maxConsecutiveLosses: 2,
  maxSameSymbolTrades: 1,
  requirePreflightPass: true,
  requireRiskGovernorPass: true,
  requireReadinessGatePass: true,
  requireNoCriticalAlerts: true,
  requirePaperOnlyMode: true,
  allowPaperAutopilot: true,
  allowManualPaperTrades: true,
  requireDebriefAfterClose: true,
  requireSessionReport: true,
  liveTradingAllowed: false,
};

export const DEFAULT_GOALS: SessionGoals = {
  mainGoal: "Practice only high-quality paper setups",
  focusAreas: [],
  setupsToWatch: [],
  setupsToAvoid: [],
  mistakeToAvoid: [],
  maxRiskPerPaperTrade: 50,
  qualityThreshold: 0.7,
  notes: "",
};

// ── Units ────────────────────────────────────────────────────────────────────
// `paper_sessions.net_pnl` / `paper_session_trade_links.pnl` are stored in
// CENTS (integer columns). `SessionRules.maxSessionLoss` and
// `maxDailyPaperLoss` are DOLLARS. Every comparison between the two must go
// through these two converters — nothing else in this file may mix the units.
export const usdToCents = (usd: number): number => Math.round(usd * 100);
export const centsToUsd = (cents: number): number => cents / 100;

/**
 * Has a session's net P&L breached its session loss limit?
 *
 * The ONE place the two units meet. `netPnlCents` is the stored
 * `paper_sessions.net_pnl` (integer cents, negative when down);
 * `maxSessionLossUsd` is `SessionRules.maxSessionLoss` (dollars, positive).
 *
 * The bug this replaces compared them directly, so a $150 session limit
 * tripped at −$1.50 — the first losing paper trade ended the session, and the
 * report then printed "limit 150 actual 15000" on one line.
 */
export function sessionLossLimitBreached(netPnlCents: number, maxSessionLossUsd: number): boolean {
  return netPnlCents <= -usdToCents(maxSessionLossUsd);
}

/** Map a realized paper P&L (DOLLARS, as stored on paper_orders.profit_loss)
 *  to the trade-link result label. Single source for every close path so the
 *  session's win/loss accounting cannot drift between writers. */
export function closeResultForPnl(pnlUsd: number): "WIN" | "LOSS" | "BREAK_EVEN" {
  return pnlUsd > 0 ? "WIN" : pnlUsd < 0 ? "LOSS" : "BREAK_EVEN";
}

export interface PreflightResult {
  paperTestingAllowed: boolean;
  hardBlocks: Array<{ source: string; code: string; message: string }>;
  warnings: Array<{ source: string; code: string; message: string }>;
  oo: { status: string; canProceedToPaperTesting: boolean; canProceedToLiveTrading: false; score: number; grade: string; criticalFailureCount: number };
  hh: { status: string; paperTradingAllowed: boolean; liveTradingAllowed: false; canPlaceLiveTrade: false };
  nn: { secretsRedacted: boolean; rolesSeeded: boolean; forbiddenLocked: boolean };
  kk: { brokerMode: string; marketDataMode: string; liveTradingDisabled: true };
  ll: { unacknowledgedCriticalCount: number };
  ff: { mode: "PAPER_ONLY"; liveTradingAllowed: false; autopilotAllowed: boolean };
  generatedAt: string;
}

export interface SessionEnvelope {
  paper_session_id: string;
  status: SessionStatus;
  mode: "PAPER_ONLY";
  liveTradingStatus: "DISABLED";
  started_at: string | null;
  ended_at: string | null;
  symbols: string[];
  timeframes: string[];
  sessionGoals: SessionGoals;
  sessionRules: SessionRules;
  preflightStatus: PreflightResult | Record<string, unknown>;
  readinessGateStatus: Record<string, unknown>;
  riskGovernorStatus: Record<string, unknown>;
  securityStatus: Record<string, unknown>;
  activeWarnings: Array<Record<string, unknown>>;
  paperTradesOpened: number;
  paperTradesClosed: number;
  netPnl: number;
  winRate: number;
  mistakesDetected: Array<Record<string, unknown>>;
  lessonsGenerated: Array<Record<string, unknown>>;
  nextBestActions: string[];
  generatedAt: string;
}

// ── Preflight ────────────────────────────────────────────────────────────────

// `userId` scopes the Risk Governor read to the caller's own limits. It is
// optional because preflight is also called from instance-level readiness
// surfaces that have no single owner; when omitted the governor falls back to
// its documented conservative defaults and says so (RISK_LIMITS_UNSCOPED),
// rather than adopting whichever user's limits happen to sort last.
export async function preflight(userId?: number | null): Promise<PreflightResult> {
  const hardBlocks: PreflightResult["hardBlocks"] = [];
  const warnings: PreflightResult["warnings"] = [];

  // OO Readiness Gate
  let oo = { status: "UNKNOWN", canProceedToPaperTesting: false as boolean, canProceedToLiveTrading: false as const, score: 0, grade: "F", criticalFailureCount: 0 };
  try {
    const g = await getGateStatus();
    if (g) {
      oo = {
        status: g.currentStatus,
        canProceedToPaperTesting: g.paperTestingAllowed,
        canProceedToLiveTrading: false,
        score: g.readinessScore,
        grade: g.readinessGrade,
        criticalFailureCount: g.criticalFailureCount,
      };
      if (!(g.currentStatus === "PASS" || g.currentStatus === "PASS_WITH_WARNINGS")) {
        hardBlocks.push({ source: "OO", code: "READINESS_NOT_PASSING", message: `Readiness gate is ${g.currentStatus}` });
      }
      if (!g.paperTestingAllowed) {
        hardBlocks.push({ source: "OO", code: "PAPER_TESTING_NOT_ALLOWED", message: "Readiness gate disallows paper testing" });
      }
    } else {
      warnings.push({ source: "OO", code: "NO_READINESS_RUN", message: "No readiness run on record — recommend running OO gate first" });
    }
  } catch (e) {
    warnings.push({ source: "OO", code: "READINESS_READ_FAILED", message: String(e).slice(0, 160) });
  }

  // HH Risk Governor
  let hh = { status: "UNKNOWN", paperTradingAllowed: false, liveTradingAllowed: false as const, canPlaceLiveTrade: false as const };
  try {
    const e = await evaluateGovernor({ persist: false, userId: userId ?? null });
    hh = {
      status: e.overallStatus,
      paperTradingAllowed: e.paperTradingAllowed,
      liveTradingAllowed: false,
      canPlaceLiveTrade: false,
    };
    if (e.overallStatus === "LOCKED" || e.overallStatus === "WATCH_ONLY") {
      hardBlocks.push({ source: "HH", code: "GOVERNOR_BLOCKED", message: `Risk governor status is ${e.overallStatus}` });
    }
    if (!e.paperTradingAllowed) {
      hardBlocks.push({ source: "HH", code: "PAPER_TRADING_DISALLOWED", message: "Risk governor disallows paper trading" });
    }
  } catch (err) {
    warnings.push({ source: "HH", code: "GOVERNOR_READ_FAILED", message: String(err).slice(0, 160) });
  }

  // NN Security — read-only sanity (rolesSeeded: tables exist + permission rows present).
  let nn = { secretsRedacted: true, rolesSeeded: false, forbiddenLocked: true };
  try {
    const r = await db.execute(sql`select count(*)::int as c from security_permissions where permission_key like 'forbidden:%'`);
    const rows = ((r as unknown as { rows?: Array<{ c: number }> }).rows ?? (r as unknown as Array<{ c: number }>)) as Array<{ c: number }>;
    nn.rolesSeeded = (rows[0]?.c ?? 0) >= 3;
    if (!nn.rolesSeeded) {
      warnings.push({ source: "NN", code: "ROLES_NOT_SEEDED", message: "NN permissions not seeded — call /api/security/seed" });
    }
  } catch (e) {
    warnings.push({ source: "NN", code: "NN_READ_FAILED", message: String(e).slice(0, 160) });
  }

  // KK Broker / Data — read-only mode required.
  const kk = { brokerMode: "READ_ONLY", marketDataMode: "READ_ONLY", liveTradingDisabled: true as const };

  // LL Notifications — count unacknowledged CRITICAL alerts.
  let ll = { unacknowledgedCriticalCount: 0 };
  try {
    const r = await db.execute(sql`
      select count(*)::int as c from notifications
      where severity='CRITICAL' and status in ('UNREAD','READ','SNOOZED')
    `);
    const rows = ((r as unknown as { rows?: Array<{ c: number }> }).rows ?? (r as unknown as Array<{ c: number }>)) as Array<{ c: number }>;
    ll.unacknowledgedCriticalCount = rows[0]?.c ?? 0;
    if (ll.unacknowledgedCriticalCount > 0) {
      hardBlocks.push({ source: "LL", code: "UNACK_CRITICAL", message: `${ll.unacknowledgedCriticalCount} unacknowledged CRITICAL alert(s)` });
    }
  } catch (e) {
    warnings.push({ source: "LL", code: "LL_READ_FAILED", message: String(e).slice(0, 160) });
  }

  // FF Autopilot — paper-only invariant.
  const ff = { mode: "PAPER_ONLY" as const, liveTradingAllowed: false as const, autopilotAllowed: hh.paperTradingAllowed };

  return {
    paperTestingAllowed: hardBlocks.length === 0,
    hardBlocks, warnings,
    oo, hh, nn, kk, ll, ff,
    generatedAt: new Date().toISOString(),
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function emit(paperSessionId: string, eventType: string, message: string, severity = "INFO", details: Record<string, unknown> = {}) {
  try {
    await db.insert(paperSessionEventsTable).values({ paperSessionId, eventType, severity, sourceBuild: "PP", message, details });
  } catch { /* never block on event log */ }
}

async function notify(paperSessionId: string, severity: "INFO"|"WARNING"|"HIGH"|"CRITICAL", title: string, message: string) {
  try {
    await db.insert(notificationsTable).values({
      notificationId: `ntf_${randomUUID()}`,
      type: "SYSTEM",
      severity,
      title,
      message,
      sourceBuild: "PP" as unknown as string,
      dedupeKey: `pp:${paperSessionId}:${title}:${Date.now()}`,
      metadata: { paperSessionId },
    });
  } catch { /* notifications schema differences should not break PP */ }
}

function rowToEnvelope(row: typeof paperSessionsTable.$inferSelect): SessionEnvelope {
  return {
    paper_session_id: row.paperSessionId,
    status: row.status as SessionStatus,
    mode: "PAPER_ONLY",
    liveTradingStatus: "DISABLED",
    started_at: row.startedAt ? row.startedAt.toISOString() : null,
    ended_at: row.endedAt ? row.endedAt.toISOString() : null,
    symbols: (row.symbols as string[]) ?? [],
    timeframes: (row.timeframes as string[]) ?? [],
    sessionGoals: row.sessionGoals as SessionGoals,
    sessionRules: row.sessionRules as SessionRules,
    preflightStatus: row.preflightStatus as PreflightResult,
    readinessGateStatus: row.readinessGateStatus as Record<string, unknown>,
    riskGovernorStatus: row.riskGovernorStatus as Record<string, unknown>,
    securityStatus: row.securityStatus as Record<string, unknown>,
    activeWarnings: row.activeWarnings as Array<Record<string, unknown>>,
    paperTradesOpened: row.paperTradesOpened,
    paperTradesClosed: row.paperTradesClosed,
    netPnl: row.netPnl,
    winRate: row.winRate,
    mistakesDetected: row.mistakesDetected as Array<Record<string, unknown>>,
    lessonsGenerated: row.lessonsGenerated as Array<Record<string, unknown>>,
    nextBestActions: (row.nextBestActions as string[]) ?? [],
    generatedAt: new Date().toISOString(),
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// PER-USER ISOLATION: every function below takes the owning `userId` and puts
// it in the WHERE clause. Before this, the session dropdown listed EVERY
// user's paper sessions and selecting one rendered that stranger's net P&L,
// win rate, rule violations and coach summary. A session id the caller does
// not own now reads exactly like one that does not exist.
export async function getActiveSession(userId: number): Promise<SessionEnvelope | null> {
  const rows = await db.select().from(paperSessionsTable)
    .where(and(
      eq(paperSessionsTable.userId, userId),
      eq(paperSessionsTable.status, "ACTIVE"),
    ))
    .orderBy(desc(paperSessionsTable.startedAt))
    .limit(1);
  return rows[0] ? rowToEnvelope(rows[0]) : null;
}

export async function getSessionById(userId: number, paperSessionId: string): Promise<SessionEnvelope | null> {
  const rows = await db.select().from(paperSessionsTable)
    .where(and(
      eq(paperSessionsTable.userId, userId),
      eq(paperSessionsTable.paperSessionId, paperSessionId),
    ))
    .limit(1);
  return rows[0] ? rowToEnvelope(rows[0]) : null;
}

export async function listSessions(userId: number, limit = 20) {
  const rows = await db.select().from(paperSessionsTable)
    .where(eq(paperSessionsTable.userId, userId))
    .orderBy(desc(paperSessionsTable.createdAt))
    .limit(Math.min(limit, 100));
  return rows.map(rowToEnvelope);
}

export interface StartArgs {
  symbols?: string[];
  timeframes?: string[];
  sessionGoals?: Partial<SessionGoals>;
  sessionRules?: Partial<SessionRules>;
}

export async function startSession(userId: number, args: StartArgs = {}): Promise<{ status: "ACTIVE" | "BLOCKED"; session: SessionEnvelope; reason?: string }> {
  // Reject if THIS USER already has an ACTIVE session. (The single-ACTIVE
  // invariant is per trader, not per instance — one trader's live session must
  // not block every other trader from starting one.)
  const active = await getActiveSession(userId);
  if (active) {
    await emit(active.paper_session_id, "START_REJECTED", "Cannot start a second session while one is ACTIVE", "WARNING");
    return { status: "BLOCKED", session: active, reason: "Another paper session is already ACTIVE" };
  }

  const pre = await preflight(userId);
  const goals: SessionGoals = { ...DEFAULT_GOALS, ...(args.sessionGoals ?? {}) };
  const rules: SessionRules = { ...DEFAULT_RULES, ...(args.sessionRules ?? {}), liveTradingAllowed: false };
  const symbols = args.symbols ?? ["Volatility 75 Index"];
  const timeframes = args.timeframes ?? ["M5"];
  const paperSessionId = `psess_${randomUUID()}`;

  if (!pre.paperTestingAllowed) {
    const [row] = await db.insert(paperSessionsTable).values({
      userId,
      paperSessionId, status: "BLOCKED",
      symbols, timeframes,
      sessionGoals: goals, sessionRules: rules, preflightStatus: pre,
      readinessGateStatus: pre.oo, riskGovernorStatus: pre.hh, securityStatus: pre.nn,
      activeWarnings: pre.hardBlocks,
      paperTradesOpened: 0, paperTradesClosed: 0, netPnl: 0, winRate: 0,
      mistakesDetected: [], lessonsGenerated: [], nextBestActions: [],
    }).returning();
    await emit(paperSessionId, "BLOCKED", `Preflight failed: ${pre.hardBlocks.map(b => b.code).join(", ")}`, "HIGH", { hardBlocks: pre.hardBlocks });
    await notify(paperSessionId, "HIGH", "Paper session BLOCKED", `Preflight blocked: ${pre.hardBlocks.map(b => b.message).join("; ")}`);
    return { status: "BLOCKED", session: rowToEnvelope(row), reason: pre.hardBlocks.map(b => b.message).join("; ") };
  }

  const [row] = await db.insert(paperSessionsTable).values({
    userId,
    paperSessionId, status: "ACTIVE",
    startedAt: new Date(),
    symbols, timeframes,
    sessionGoals: goals, sessionRules: rules, preflightStatus: pre,
    readinessGateStatus: pre.oo, riskGovernorStatus: pre.hh, securityStatus: pre.nn,
    activeWarnings: pre.warnings,
    paperTradesOpened: 0, paperTradesClosed: 0, netPnl: 0, winRate: 0,
    mistakesDetected: [], lessonsGenerated: [],
    nextBestActions: ["Watch for high-quality setups", "Stop on session loss limit", "Debrief every closed trade"],
  }).returning();

  await emit(paperSessionId, "STARTED", "Paper session started (PAPER_ONLY, live trading DISABLED)", "INFO", { symbols, timeframes });
  await notify(paperSessionId, "INFO", "Paper session started", `Session ${paperSessionId} ACTIVE on ${symbols.join(", ")}.`);
  return { status: "ACTIVE", session: rowToEnvelope(row) };
}

export async function pauseSession(userId: number, paperSessionId: string, reason = "manual pause"): Promise<{ ok: boolean; session: SessionEnvelope | null; reason?: string }> {
  const cur = await getSessionById(userId, paperSessionId);
  if (!cur) return { ok: false, session: null, reason: "session not found" };
  if (cur.status !== "ACTIVE") return { ok: false, session: cur, reason: `cannot pause ${cur.status} session` };
  await db.update(paperSessionsTable).set({ status: "PAUSED", updatedAt: new Date() })
    .where(and(eq(paperSessionsTable.userId, userId), eq(paperSessionsTable.paperSessionId, paperSessionId)));
  await emit(paperSessionId, "PAUSED", `Session paused: ${reason}`, "INFO");
  await notify(paperSessionId, "INFO", "Paper session paused", reason);
  return { ok: true, session: await getSessionById(userId, paperSessionId) };
}

export async function resumeSession(userId: number, paperSessionId: string): Promise<{ ok: boolean; session: SessionEnvelope | null; reason?: string }> {
  const cur = await getSessionById(userId, paperSessionId);
  if (!cur) return { ok: false, session: null, reason: "session not found" };
  if (cur.status !== "PAUSED") return { ok: false, session: cur, reason: `cannot resume ${cur.status} session` };
  // Single-ACTIVE invariant: refuse if some other session is already ACTIVE.
  const otherActive = await getActiveSession(userId);
  if (otherActive && otherActive.paper_session_id !== paperSessionId) {
    await emit(paperSessionId, "RESUME_REJECTED", `Another ACTIVE session exists (${otherActive.paper_session_id})`, "WARNING");
    return { ok: false, session: cur, reason: `Another paper session ${otherActive.paper_session_id} is already ACTIVE` };
  }
  // Re-check safety before resume.
  const pre = await preflight(userId);
  if (!pre.paperTestingAllowed) {
    await emit(paperSessionId, "RESUME_REJECTED", `Cannot resume — preflight failed: ${pre.hardBlocks.map(b => b.code).join(", ")}`, "HIGH", { hardBlocks: pre.hardBlocks });
    return { ok: false, session: cur, reason: `Preflight failed: ${pre.hardBlocks.map(b => b.message).join("; ")}` };
  }
  await db.update(paperSessionsTable).set({ status: "ACTIVE", preflightStatus: pre, updatedAt: new Date() })
    .where(and(eq(paperSessionsTable.userId, userId), eq(paperSessionsTable.paperSessionId, paperSessionId)));
  await emit(paperSessionId, "RESUMED", "Session resumed after preflight re-check passed", "INFO");
  await notify(paperSessionId, "INFO", "Paper session resumed", "Safety checks passed.");
  return { ok: true, session: await getSessionById(userId, paperSessionId) };
}

export async function endSession(userId: number, paperSessionId: string, reason = "manual end"): Promise<{ ok: boolean; session: SessionEnvelope | null; reason?: string }> {
  const cur = await getSessionById(userId, paperSessionId);
  if (!cur) return { ok: false, session: null, reason: "session not found" };
  if (cur.status === "ENDED") return { ok: true, session: cur };
  await db.update(paperSessionsTable).set({ status: "ENDED", endedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(paperSessionsTable.userId, userId), eq(paperSessionsTable.paperSessionId, paperSessionId)));
  await emit(paperSessionId, "ENDED", `Session ended: ${reason}`, "INFO");
  await notify(paperSessionId, "INFO", "Paper session ended", `Session ${paperSessionId} ended. Generate report.`);
  return { ok: true, session: await getSessionById(userId, paperSessionId) };
}

// ── EE / FF enforcement contract (read-only — does NOT modify EE/FF) ─────────

export interface EnforcementResult {
  allowed: boolean;
  reason: string;
  sessionId: string | null;
  sessionStatus: SessionStatus | "NONE";
}

export async function checkSessionAllowsPaperTrade(userId: number, opts: { symbol?: string } = {}): Promise<EnforcementResult> {
  const cur = await getActiveSession(userId);
  if (!cur) return { allowed: false, reason: "no ACTIVE session", sessionId: null, sessionStatus: "NONE" };
  if (cur.status !== "ACTIVE") return { allowed: false, reason: `session ${cur.status}`, sessionId: cur.paper_session_id, sessionStatus: cur.status };
  if (!cur.sessionRules.allowManualPaperTrades) return { allowed: false, reason: "session rules disallow manual paper trades", sessionId: cur.paper_session_id, sessionStatus: cur.status };
  if (cur.paperTradesOpened >= cur.sessionRules.maxPaperTrades) return { allowed: false, reason: `max paper trades reached (${cur.sessionRules.maxPaperTrades})`, sessionId: cur.paper_session_id, sessionStatus: cur.status };
  // UNITS: paper_sessions.net_pnl is CENTS; sessionRules.maxSessionLoss is
  // DOLLARS (DEFAULT_RULES = 150). Comparing them directly tripped this guard
  // at -$1.50 instead of -$150 — a paper session was blocked on essentially
  // the first losing trade. Convert once, here, at the boundary.
  if (sessionLossLimitBreached(cur.netPnl, cur.sessionRules.maxSessionLoss)) return { allowed: false, reason: `session loss limit hit ($${cur.sessionRules.maxSessionLoss.toFixed(2)})`, sessionId: cur.paper_session_id, sessionStatus: cur.status };
  // Consecutive-loss check: walk closed CLOSE links in chronological order, count trailing LOSS streak.
  const closedRows = await db.select().from(paperSessionTradeLinksTable)
    .where(and(eq(paperSessionTradeLinksTable.paperSessionId, cur.paper_session_id), eq(paperSessionTradeLinksTable.action, "CLOSE")))
    .orderBy(paperSessionTradeLinksTable.createdAt);
  let streak = 0;
  for (let i = closedRows.length - 1; i >= 0; i--) {
    if (closedRows[i].result === "LOSS") streak++; else break;
  }
  if (streak >= cur.sessionRules.maxConsecutiveLosses) {
    return { allowed: false, reason: `max consecutive losses reached (${cur.sessionRules.maxConsecutiveLosses})`, sessionId: cur.paper_session_id, sessionStatus: cur.status };
  }
  if (opts.symbol) {
    // Per-symbol cap counts OPEN actions only (each trade has one OPEN row).
    const sameSymbol = (await db.select().from(paperSessionTradeLinksTable)
      .where(and(
        eq(paperSessionTradeLinksTable.paperSessionId, cur.paper_session_id),
        eq(paperSessionTradeLinksTable.symbol, opts.symbol),
        eq(paperSessionTradeLinksTable.action, "OPEN"),
      ))).length;
    if (sameSymbol >= cur.sessionRules.maxSameSymbolTrades) return { allowed: false, reason: `max trades for symbol ${opts.symbol} reached`, sessionId: cur.paper_session_id, sessionStatus: cur.status };
  }
  return { allowed: true, reason: "session allows paper trade", sessionId: cur.paper_session_id, sessionStatus: cur.status };
}

export async function checkSessionAllowsAutopilot(userId: number): Promise<EnforcementResult> {
  const cur = await getActiveSession(userId);
  if (!cur) return { allowed: false, reason: "no ACTIVE session — autopilot must not open trades", sessionId: null, sessionStatus: "NONE" };
  if (cur.status !== "ACTIVE") return { allowed: false, reason: `session ${cur.status}`, sessionId: cur.paper_session_id, sessionStatus: cur.status };
  if (!cur.sessionRules.allowPaperAutopilot) return { allowed: false, reason: "session rules disallow autopilot", sessionId: cur.paper_session_id, sessionStatus: cur.status };
  if (cur.paperTradesOpened >= cur.sessionRules.maxPaperTrades) return { allowed: false, reason: "max paper trades reached", sessionId: cur.paper_session_id, sessionStatus: cur.status };
  // Same cents-vs-dollars conversion as checkSessionAllowsPaperTrade.
  if (sessionLossLimitBreached(cur.netPnl, cur.sessionRules.maxSessionLoss)) return { allowed: false, reason: "session loss limit hit", sessionId: cur.paper_session_id, sessionStatus: cur.status };
  return { allowed: true, reason: "session allows autopilot", sessionId: cur.paper_session_id, sessionStatus: cur.status };
}

// ── BB/CC linking ────────────────────────────────────────────────────────────

export interface LinkArgs {
  tradeId?: string;
  decisionId?: string;
  debriefId?: string;
  learningEventId?: string;
  symbol?: string;
  action?: "OPEN" | "CLOSE" | "REJECT" | "LINK";
  result?: "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN";
  pnl?: number;
}

// DEAD-GAUGE FIX: this used to be reachable ONLY via POST
// /api/paper-sessions/link-trade, which nothing called — so the session row's
// paperTradesOpened / paperTradesClosed / netPnl / winRate stayed at their
// DB defaults forever, and the session loss limit (which reads netPnl) could
// never trip from real trading. It is now called from the real open/close
// paths: EE execution open (paperExecutionService), EE monitor + manual
// closes (paperExecutionMonitor), and the Build Q sandbox open/close/SL-TP
// paths (routes/paperTrading.ts) for orders that carry a user_id.
// UNITS: args.pnl is CENTS (paper_session_trade_links.pnl / paper_sessions
// .net_pnl are integer-cents columns) — callers convert via usdToCents().
export async function linkTradeToActiveSession(userId: number, args: LinkArgs) {
  try {
    const cur = await getActiveSession(userId);
    if (!cur) return { linked: false, reason: "no ACTIVE session" };
    await db.insert(paperSessionTradeLinksTable).values({
      paperSessionId: cur.paper_session_id,
      tradeId: args.tradeId ?? null, decisionId: args.decisionId ?? null,
      debriefId: args.debriefId ?? null, learningEventId: args.learningEventId ?? null,
      symbol: args.symbol ?? null, action: args.action ?? "LINK",
      result: args.result ?? null, pnl: args.pnl ?? 0,
    });
    // Atomic counter updates so concurrent links don't lose increments.
    if (args.action === "OPEN") {
      await db.update(paperSessionsTable)
        .set({ paperTradesOpened: sql`${paperSessionsTable.paperTradesOpened} + 1`, updatedAt: new Date() })
        .where(and(eq(paperSessionsTable.userId, userId), eq(paperSessionsTable.paperSessionId, cur.paper_session_id)));
    } else if (args.action === "CLOSE") {
      const delta = args.pnl ?? 0;
      await db.update(paperSessionsTable)
        .set({
          paperTradesClosed: sql`${paperSessionsTable.paperTradesClosed} + 1`,
          netPnl: sql`${paperSessionsTable.netPnl} + ${delta}`,
          updatedAt: new Date(),
        })
        .where(and(eq(paperSessionsTable.userId, userId), eq(paperSessionsTable.paperSessionId, cur.paper_session_id)));
      // win_rate previously had NO writer at all — the row default 0 rendered
      // forever. Recompute it from the CLOSE links now that this one exists.
      const closes = await db.select({ result: paperSessionTradeLinksTable.result })
        .from(paperSessionTradeLinksTable)
        .where(and(
          eq(paperSessionTradeLinksTable.paperSessionId, cur.paper_session_id),
          eq(paperSessionTradeLinksTable.action, "CLOSE"),
        ));
      const winCount = closes.filter((c) => c.result === "WIN").length;
      await db.update(paperSessionsTable)
        .set({ winRate: closes.length > 0 ? Math.round((winCount / closes.length) * 100) : 0 })
        .where(and(eq(paperSessionsTable.userId, userId), eq(paperSessionsTable.paperSessionId, cur.paper_session_id)));
    }
    await emit(cur.paper_session_id, "TRADE_LINKED", `${args.action ?? "LINK"} linked: trade=${args.tradeId ?? ""} debrief=${args.debriefId ?? ""} learning=${args.learningEventId ?? ""}`, "INFO", args as Record<string, unknown>);
    return { linked: true, paperSessionId: cur.paper_session_id };
  } catch (e) {
    return { linked: false, reason: `link error: ${String(e).slice(0, 160)}` };
  }
}

// The trade-link and event tables key on paper_session_id and carry no user
// column of their own, so ownership is proven by first resolving the session
// through the user-scoped getSessionById(). A session the caller does not own
// yields an empty list, never a stranger's trades or events.
export async function listSessionTrades(userId: number, paperSessionId: string) {
  const owned = await getSessionById(userId, paperSessionId);
  if (!owned) return [];
  return db.select().from(paperSessionTradeLinksTable)
    .where(eq(paperSessionTradeLinksTable.paperSessionId, paperSessionId))
    .orderBy(desc(paperSessionTradeLinksTable.createdAt));
}

export async function listSessionEvents(userId: number, paperSessionId: string, limit = 100) {
  const owned = await getSessionById(userId, paperSessionId);
  if (!owned) return [];
  return db.select().from(paperSessionEventsTable)
    .where(eq(paperSessionEventsTable.paperSessionId, paperSessionId))
    .orderBy(desc(paperSessionEventsTable.createdAt))
    .limit(limit);
}

// ── Session report ───────────────────────────────────────────────────────────

export interface SessionReport {
  session_report_id: string;
  paper_session_id: string;
  status: "COMPLETE" | "PARTIAL";
  started_at: string | null;
  ended_at: string | null;
  duration_minutes: number;
  total_trades: number;
  wins: number;
  losses: number;
  break_even: number;
  net_pnl: number;
  win_rate: number;
  /** Each entry carries `unit` so `limit` and `actual` are never read in
   *  different scales (this is where "limit 150 actual 15000" came from). */
  rule_violations: Array<Record<string, unknown>>;
  mistakes_detected: Array<Record<string, unknown>>;
  lessons_generated: Array<Record<string, unknown>>;
  coach_summary: string;
  next_best_actions: string[];
  warnings: Array<Record<string, unknown>>;
  mode: "PAPER_ONLY";
  liveTradingStatus: "DISABLED";
  generatedAt: string;
}

export async function generateSessionReport(userId: number, paperSessionId: string): Promise<SessionReport | null> {
  const cur = await getSessionById(userId, paperSessionId);
  if (!cur) return null;
  const trades = await listSessionTrades(userId, paperSessionId);
  const closed = trades.filter(t => t.action === "CLOSE");
  const wins = closed.filter(t => t.result === "WIN").length;
  const losses = closed.filter(t => t.result === "LOSS").length;
  const breakEven = closed.filter(t => t.result === "BREAK_EVEN").length;
  const netPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;
  const startMs = cur.started_at ? Date.parse(cur.started_at) : 0;
  const endMs = cur.ended_at ? Date.parse(cur.ended_at) : Date.now();
  const durationMinutes = startMs ? Math.max(0, Math.round((endMs - startMs) / 60_000)) : 0;

  // `netPnl` here is the sum of paper_session_trade_links.pnl — CENTS.
  // `maxSessionLoss` is DOLLARS. Both sides of every comparison and every
  // reported pair are expressed in ONE unit, named by `unit`.
  const netPnlUsd = centsToUsd(netPnl);
  const ruleViolations: Array<Record<string, unknown>> = [];
  if (cur.paperTradesOpened > cur.sessionRules.maxPaperTrades) ruleViolations.push({ code: "MAX_TRADES_EXCEEDED", limit: cur.sessionRules.maxPaperTrades, actual: cur.paperTradesOpened, unit: "trades" });
  if (sessionLossLimitBreached(netPnl, cur.sessionRules.maxSessionLoss)) ruleViolations.push({ code: "SESSION_LOSS_EXCEEDED", limit: cur.sessionRules.maxSessionLoss, actual: Number((-netPnlUsd).toFixed(2)), unit: "USD" });
  if (durationMinutes > cur.sessionRules.maxSessionMinutes) ruleViolations.push({ code: "SESSION_DURATION_EXCEEDED", limit: cur.sessionRules.maxSessionMinutes, actual: durationMinutes, unit: "minutes" });

  const coachSummary = `Paper-only session ${paperSessionId}: ${closed.length} closed trades (${wins}W/${losses}L/${breakEven}BE), net $${netPnlUsd.toFixed(2)}, win rate ${winRate}%. Live trading remains DISABLED.`;
  const nextBestActions: string[] = [];
  if (winRate < 50 && closed.length >= 2) nextBestActions.push("Review setups in BB debriefs — focus on quality over quantity");
  if (ruleViolations.length > 0) nextBestActions.push(`Address ${ruleViolations.length} rule violation(s) before next session`);
  if (closed.length === 0) nextBestActions.push("No trades closed — consider widening focus areas or reviewing setup criteria");
  if (nextBestActions.length === 0) nextBestActions.push("Continue practicing within the same rules; queue another session when ready");

  const sessionReportId = `psrpt_${randomUUID()}`;
  await db.insert(paperSessionReportsTable).values({
    sessionReportId, paperSessionId,
    status: cur.status === "ENDED" ? "COMPLETE" : "PARTIAL",
    startedAt: cur.started_at ? new Date(cur.started_at) : null,
    endedAt: cur.ended_at ? new Date(cur.ended_at) : null,
    durationMinutes, totalTrades: closed.length, wins, losses, breakEven,
    netPnl, winRate,
    ruleViolations, mistakesDetected: cur.mistakesDetected, lessonsGenerated: cur.lessonsGenerated,
    coachSummary, nextBestActions, warnings: cur.activeWarnings,
  });
  await emit(paperSessionId, "REPORT_GENERATED", `Session report ${sessionReportId} created`, "INFO", { sessionReportId });

  return {
    session_report_id: sessionReportId,
    paper_session_id: paperSessionId,
    status: cur.status === "ENDED" ? "COMPLETE" : "PARTIAL",
    started_at: cur.started_at, ended_at: cur.ended_at,
    duration_minutes: durationMinutes,
    total_trades: closed.length, wins, losses, break_even: breakEven,
    net_pnl: netPnl, win_rate: winRate,
    rule_violations: ruleViolations,
    mistakes_detected: cur.mistakesDetected,
    lessons_generated: cur.lessonsGenerated,
    coach_summary: coachSummary,
    next_best_actions: nextBestActions,
    warnings: cur.activeWarnings,
    mode: "PAPER_ONLY", liveTradingStatus: "DISABLED",
    generatedAt: new Date().toISOString(),
  };
}

export async function getLatestReport(userId: number, paperSessionId: string): Promise<SessionReport | null> {
  // Reports key only on paper_session_id, so ownership is proven through the
  // user-scoped session lookup first.
  const owned = await getSessionById(userId, paperSessionId);
  if (!owned) return null;
  const rows = await db.select().from(paperSessionReportsTable)
    .where(eq(paperSessionReportsTable.paperSessionId, paperSessionId))
    .orderBy(desc(paperSessionReportsTable.createdAt))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    session_report_id: r.sessionReportId,
    paper_session_id: r.paperSessionId,
    status: r.status as "COMPLETE" | "PARTIAL",
    started_at: r.startedAt ? r.startedAt.toISOString() : null,
    ended_at: r.endedAt ? r.endedAt.toISOString() : null,
    duration_minutes: r.durationMinutes,
    total_trades: r.totalTrades, wins: r.wins, losses: r.losses, break_even: r.breakEven,
    net_pnl: r.netPnl, win_rate: r.winRate,
    rule_violations: r.ruleViolations as Array<Record<string, unknown>>,
    mistakes_detected: r.mistakesDetected as Array<Record<string, unknown>>,
    lessons_generated: r.lessonsGenerated as Array<Record<string, unknown>>,
    coach_summary: r.coachSummary ?? "",
    next_best_actions: r.nextBestActions as string[],
    warnings: r.warnings as Array<Record<string, unknown>>,
    mode: "PAPER_ONLY", liveTradingStatus: "DISABLED",
    generatedAt: new Date().toISOString(),
  };
}
