// Phase 8D — Per-user Risk Governor routes.
// SAFETY: requireUser, scope by req.authUser.id, never accept userId from client.
// Live execution is never overridable; live contract enforced in engine.
import { Router } from "express";
import {
  db, paperTradesTable,
  userRiskSettingsTable, userRiskEventsTable,
  tradingSessionsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { evaluateRiskCheck, aggregateHistory, DEFAULT_USER_RISK_SETTINGS, type RiskCheckInput, type RiskCheckResult } from "../lib/riskGovernorEngine.js";

const router = Router();

const SAFE_LIVE_CONTRACT = { liveLocked: true as const, readOnlyMode: true as const, allowOrderExecution: false as const };

export async function getOrCreateRiskSettings(userId: number) {
  const existing = await db.select().from(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  const ins = await db.insert(userRiskSettingsTable).values({ userId, ...DEFAULT_USER_RISK_SETTINGS }).returning();
  return ins[0]!;
}

export async function logRiskEvent(args: {
  userId: number; eventType: string; severity: "info" | "warning" | "critical"; decision: "pass" | "warning" | "block";
  reason: string; details?: Record<string, unknown>;
  paperTradeId?: number | null; tradingSessionId?: number | null; mt5ConnectionId?: number | null;
}) {
  // Defensive: never persist anything resembling a bridge token
  const safeDetails = scrubSecrets(args.details ?? {});
  const ins = await db.insert(userRiskEventsTable).values({
    userId: args.userId, eventType: args.eventType, severity: args.severity, decision: args.decision,
    reason: args.reason, details: safeDetails,
    paperTradeId: args.paperTradeId ?? null,
    tradingSessionId: args.tradingSessionId ?? null,
    mt5ConnectionId: args.mt5ConnectionId ?? null,
  }).returning();
  // Phase 10F — emit notification + activity for warning/block events.
  if (args.decision !== "pass") {
    try {
      const { fireNotify } = await import("../lib/notificationService.js");
      const sev = args.decision === "block" ? "critical" : "warning";
      const notifType = args.decision === "block" ? "risk_block" : "risk_warning";
      fireNotify(args.userId,
        { notificationType: notifType, severity: sev, title: args.decision === "block" ? "Risk Governor blocked a trade" : "Risk warning", message: args.reason, source: "risk", entityType: "paper_trade", entityId: args.paperTradeId ?? null, actionLabel: "View risk events", actionTarget: "/risk-settings" },
        { eventType: args.decision === "block" ? "risk_trade_blocked" : "risk_check_completed", title: args.decision === "block" ? "Risk Governor blocked a trade" : "Risk warning issued", description: args.reason, source: "risk", entityType: "paper_trade", entityId: args.paperTradeId ?? null }
      );
    } catch { /* never break risk path */ }
  }
  return ins;
}

const SECRET_KEY_RE = /token|secret|password|bridge|api[_-]?key|authorization|cookie|x-mt5/i;
const SECRET_VAL_RE = /MT5_BRIDGE_TOKEN|X-MT5-Bridge-Token/i;
function scrubValue(v: unknown, depth = 0): unknown {
  if (v == null) return v;
  if (depth > 8) return "[REDACTED_DEPTH_LIMIT]"; // fail-closed beyond depth bound
  if (typeof v === "string") return SECRET_VAL_RE.test(v) ? "[REDACTED]" : v;
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) out[k] = "[REDACTED]";
      else out[k] = scrubValue(val, depth + 1);
    }
    return out;
  }
  return v;
}
function scrubSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  return scrubValue(obj) as Record<string, unknown>;
}

// Apply live-contract overrides on every read so it can never be bypassed via DB drift.
function withSafetyContract<T extends Record<string, unknown>>(s: T) {
  return { ...s, ...SAFE_LIVE_CONTRACT, safetyMode: "paper_only" as const, educationalOnly: true as const };
}

// ── Risk settings ────────────────────────────────────────────────────────
router.get("/me/risk-settings", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const s = await getOrCreateRiskSettings(userId);
  res.json(withSafetyContract(s));
});
router.post("/me/risk-settings", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  // POST = upsert with provided fields, but enforce safe live contract.
  const existing = await db.select().from(userRiskSettingsTable).where(eq(userRiskSettingsTable.userId, userId)).limit(1);
  const body = sanitizeBody(req.body ?? {});
  if (existing[0]) {
    const u = await db.update(userRiskSettingsTable).set({ ...body, ...SAFE_LIVE_CONTRACT, updatedAt: new Date() })
      .where(eq(userRiskSettingsTable.userId, userId)).returning();
    res.json(withSafetyContract(u[0]!));
  } else {
    const ins = await db.insert(userRiskSettingsTable).values({ userId, ...DEFAULT_USER_RISK_SETTINGS, ...body, ...SAFE_LIVE_CONTRACT }).returning();
    res.status(201).json(withSafetyContract(ins[0]!));
  }
});
router.patch("/me/risk-settings", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  await getOrCreateRiskSettings(userId);
  const body = sanitizeBody(req.body ?? {});
  const u = await db.update(userRiskSettingsTable).set({ ...body, ...SAFE_LIVE_CONTRACT, updatedAt: new Date() })
    .where(eq(userRiskSettingsTable.userId, userId)).returning();
  res.json(withSafetyContract(u[0]!));
});
router.post("/me/risk-settings/reset-defaults", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  await getOrCreateRiskSettings(userId);
  const u = await db.update(userRiskSettingsTable).set({ ...DEFAULT_USER_RISK_SETTINGS, ...SAFE_LIVE_CONTRACT, updatedAt: new Date() })
    .where(eq(userRiskSettingsTable.userId, userId)).returning();
  res.json(withSafetyContract(u[0]!));
});

function sanitizeBody(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const numFields = ["maxRiskPerTradePercent", "maxRiskPerTradeAmount", "maxDailyLossPercent", "maxDailyLossAmount",
    "maxWeeklyLossPercent", "maxWeeklyLossAmount", "maxOpenTrades", "maxTradesPerDay", "maxConsecutiveLosses",
    "maxPositionSize", "minRewardRiskRatio", "cooldownAfterLossMinutes", "cooldownAfterMaxLossMinutes"];
  const boolFields = ["blockAfterDailyLossHit", "blockAfterConsecutiveLosses", "requireStopLoss", "requireTakeProfit",
    "requirePlaybook", "requirePreTradeChecklist", "requireJournalReason", "allowOverrideInPaperMode"];
  for (const k of numFields) if (typeof b[k] === "number" || b[k] === null) out[k] = b[k];
  for (const k of boolFields) if (typeof b[k] === "boolean") out[k] = b[k];
  // Reject any client attempt to flip live contract or set userId
  delete (b as Record<string, unknown>).userId;
  delete (b as Record<string, unknown>).liveLocked;
  delete (b as Record<string, unknown>).readOnlyMode;
  delete (b as Record<string, unknown>).allowOrderExecution;
  return out;
}

// ── Risk check (used by frontend pre-flight) ─────────────────────────────
router.post("/me/risk/check-paper-trade", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const settings = await getOrCreateRiskSettings(userId);
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const history = aggregateHistory(trades);
  const b = req.body ?? {};
  const input: RiskCheckInput = {
    symbol: String(b.symbol ?? ""), side: b.side ?? null,
    stopLoss: nullableNum(b.stopLoss), takeProfit: nullableNum(b.takeProfit),
    entryPrice: nullableNum(b.entryPrice), lotSize: nullableNum(b.lotSize),
    riskAmount: nullableNum(b.riskAmount), riskPercent: nullableNum(b.riskPercent),
    rewardRiskRatio: nullableNum(b.rewardRiskRatio), reasonForEntry: b.reasonForEntry ?? null,
    playbookId: nullableNum(b.playbookId),
    preTradeCheckPassed: typeof b.preTradeCheckPassed === "boolean" ? b.preTradeCheckPassed : null,
    preTradeCheckDecision: b.preTradeCheckDecision ?? null,
    liveExecutionIntent: b.liveExecutionIntent === true,
  };
  const result = evaluateRiskCheck(settings, history, input, { accountBalance: nullableNum(b.accountBalance) });
  const sev: "info" | "warning" | "critical" = result.decision === "block" ? "critical" : result.decision === "warning" ? "warning" : "info";
  await logRiskEvent({
    userId, eventType: result.liveExecutionAttempted ? "live_execution_blocked" : (result.decision === "block" ? "blocked_trade" : "risk_check"),
    severity: sev, decision: result.decision, reason: result.reason,
    details: { input: { ...input }, score: result.riskScore, failedRules: result.failedRules },
    paperTradeId: nullableNum(b.paperTradeId), tradingSessionId: nullableNum(b.tradingSessionId),
  });
  res.json({ ...result, ...SAFE_LIVE_CONTRACT, safetyMode: "paper_only", educationalOnly: true });
});

router.get("/me/risk/events", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(userRiskEventsTable)
    .where(eq(userRiskEventsTable.userId, userId))
    .orderBy(desc(userRiskEventsTable.createdAt)).limit(200);
  res.json({ events: rows, isEmpty: rows.length === 0 });
});

router.get("/me/risk/status", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const settings = await getOrCreateRiskSettings(userId);
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const history = aggregateHistory(trades);
  const lastBlocked = (await db.select().from(userRiskEventsTable)
    .where(and(eq(userRiskEventsTable.userId, userId), eq(userRiskEventsTable.decision, "block")))
    .orderBy(desc(userRiskEventsTable.createdAt)).limit(1))[0] ?? null;
  res.json({
    settings: withSafetyContract(settings),
    today: { pnl: history.todayPnl, trades: history.tradesToday, openTrades: history.openTradesCount, consecutiveLosses: history.consecutiveLosses },
    week: { pnl: history.weekPnl },
    cooldown: history.lastClosedWasLoss && history.lastClosedAt
      ? { active: (Date.now() - history.lastClosedAt.getTime()) / 60_000 < settings.cooldownAfterLossMinutes,
          minutesRemaining: Math.max(0, Math.ceil(settings.cooldownAfterLossMinutes - (Date.now() - history.lastClosedAt.getTime()) / 60_000)) }
      : { active: false, minutesRemaining: 0 },
    lastBlocked: lastBlocked ? { reason: lastBlocked.reason, createdAt: lastBlocked.createdAt, eventType: lastBlocked.eventType } : null,
    safetyMode: "paper_only", educationalOnly: true, ...SAFE_LIVE_CONTRACT,
  });
});

router.get("/me/risk/daily-status", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const settings = await getOrCreateRiskSettings(userId);
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const history = aggregateHistory(trades);
  res.json({
    pnl: history.todayPnl, trades: history.tradesToday,
    maxTradesPerDay: settings.maxTradesPerDay, maxDailyLossPercent: settings.maxDailyLossPercent,
    consecutiveLosses: history.consecutiveLosses, maxConsecutiveLosses: settings.maxConsecutiveLosses,
    dailyTradeCapHit: history.tradesToday >= settings.maxTradesPerDay,
    consecutiveLossCapHit: history.consecutiveLosses >= settings.maxConsecutiveLosses,
  });
});

router.get("/me/risk/session-status", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const sessionIdRaw = req.query.tradingSessionId;
  const sessionId = sessionIdRaw ? Number(sessionIdRaw) : null;
  if (sessionId != null && !Number.isFinite(sessionId)) { res.status(400).json({ error: "invalid tradingSessionId" }); return; }
  const trades = sessionId
    ? await db.select().from(paperTradesTable).where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.tradingSessionId, sessionId)))
    : await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  if (sessionId) {
    const sess = await db.select().from(tradingSessionsTable)
      .where(and(eq(tradingSessionsTable.id, sessionId), eq(tradingSessionsTable.userId, userId))).limit(1);
    if (!sess[0]) { res.status(404).json({ error: "Session not found" }); return; }
  }
  const closed = trades.filter((t) => t.status === "closed");
  const open = trades.filter((t) => t.status === "open");
  const pnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0).length;
  res.json({
    tradingSessionId: sessionId, totalTrades: trades.length, closedTrades: closed.length, openTrades: open.length,
    pnl, wins, losses: closed.length - wins, winRate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : 0,
  });
});

router.post("/me/risk/events/:id/override", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid id" }); return; }
  const ev = (await db.select().from(userRiskEventsTable)
    .where(and(eq(userRiskEventsTable.id, id), eq(userRiskEventsTable.userId, userId))).limit(1))[0] ?? null;
  if (!ev) { res.status(404).json({ error: "Event not found" }); return; }
  if (ev.eventType === "live_execution_blocked") {
    res.status(403).json({ error: "LIVE_OVERRIDE_FORBIDDEN", message: "Live execution can never be overridden." });
    return;
  }
  const settings = await getOrCreateRiskSettings(userId);
  if (!settings.allowOverrideInPaperMode) {
    res.status(403).json({ error: "OVERRIDE_DISABLED", message: "Overrides are disabled in your risk settings." });
    return;
  }
  const reason = String((req.body ?? {}).reason ?? "").trim();
  if (reason.length < 5) { res.status(400).json({ error: "Override reason required (≥ 5 chars)" }); return; }
  const u = await db.update(userRiskEventsTable)
    .set({ overrideReason: reason, overriddenAt: new Date() })
    .where(and(eq(userRiskEventsTable.id, id), eq(userRiskEventsTable.userId, userId))).returning();
  await logRiskEvent({
    userId, eventType: "override", severity: "warning", decision: "warning",
    reason: `Override applied to event #${id}: ${reason}`,
    details: { overriddenEventId: id, originalReason: ev.reason },
    paperTradeId: ev.paperTradeId, tradingSessionId: ev.tradingSessionId,
  });
  res.json({ event: u[0], note: "Override valid for paper mode only. Live execution remains blocked." });
});

function nullableNum(x: unknown): number | null {
  if (x == null || x === "") return null;
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

// Helper: run risk check for paper trade open path. Throws Error on block (no override).
export async function evaluateForPaperOpen(userId: number, opts: {
  trade: typeof paperTradesTable.$inferSelect; override?: { reason: string } | null;
}) {
  const settings = await getOrCreateRiskSettings(userId);
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const history = aggregateHistory(trades.filter((t) => t.id !== opts.trade.id));
  const t = opts.trade;
  // Resolve account balance from MT5 connection so maxDailyLossPercent enforces in the open path.
  // Falls back to a paper-account default so percentage-based caps never silently no-op.
  let accountBalance: number | null = null;
  if (t.mt5ConnectionId != null) {
    const { mt5ConnectionTable } = await import("@workspace/db");
    const conn = (await db.select().from(mt5ConnectionTable)
      .where(and(eq(mt5ConnectionTable.id, t.mt5ConnectionId), eq(mt5ConnectionTable.userId, userId))).limit(1))[0];
    if (conn?.accountBalance != null) accountBalance = Number(conn.accountBalance);
  }
  if (accountBalance == null || !Number.isFinite(accountBalance) || accountBalance <= 0) accountBalance = 10_000;
  const result = evaluateRiskCheck(settings, history, {
    symbol: t.symbol, side: t.side,
    stopLoss: t.stopLoss, takeProfit: t.takeProfit, entryPrice: t.entryPrice ?? t.plannedEntryPrice,
    lotSize: t.lotSize, riskAmount: t.riskAmount, riskPercent: t.riskPercent,
    rewardRiskRatio: t.rewardRiskRatio, reasonForEntry: t.reasonForEntry,
    playbookId: null, preTradeCheckPassed: null, preTradeCheckDecision: null,
    liveExecutionIntent: false,
  }, { accountBalance });
  const sev: "info" | "warning" | "critical" = result.decision === "block" ? "critical" : result.decision === "warning" ? "warning" : "info";
  const overrideAttempted = !!opts.override;
  const overrideValid = overrideAttempted && result.overrideAllowed && (opts.override!.reason.trim().length >= 5);
  await logRiskEvent({
    userId,
    eventType: result.decision === "block" ? "blocked_trade" : "risk_check",
    severity: sev, decision: result.decision,
    reason: result.reason,
    details: { score: result.riskScore, failedRules: result.failedRules, overrideAttempted, overrideValid, overrideReason: opts.override?.reason ?? null },
    paperTradeId: t.id, tradingSessionId: t.tradingSessionId,
  });
  if (overrideValid && result.decision === "block") {
    await logRiskEvent({
      userId, eventType: "override", severity: "warning", decision: "warning",
      reason: `Paper override on open: ${opts.override!.reason}`,
      details: { tradeId: t.id, originalReason: result.reason },
      paperTradeId: t.id, tradingSessionId: t.tradingSessionId,
    });
  }
  return { result, allow: result.decision !== "block" || overrideValid };
}

export async function postPaperCloseRiskHooks(userId: number, closedTrade: typeof paperTradesTable.$inferSelect) {
  const settings = await getOrCreateRiskSettings(userId);
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const history = aggregateHistory(trades);
  if (history.consecutiveLosses >= settings.maxConsecutiveLosses) {
    await logRiskEvent({
      userId, eventType: "consecutive_losses_hit", severity: "critical", decision: "warning",
      reason: `${history.consecutiveLosses} consecutive losses — at or above cap ${settings.maxConsecutiveLosses}`,
      details: { consecutiveLosses: history.consecutiveLosses },
      paperTradeId: closedTrade.id, tradingSessionId: closedTrade.tradingSessionId,
    });
  }
  if ((closedTrade.pnl ?? 0) < 0 && settings.cooldownAfterLossMinutes > 0) {
    await logRiskEvent({
      userId, eventType: "cooldown_started", severity: "info", decision: "warning",
      reason: `Cooldown ${settings.cooldownAfterLossMinutes}min after loss`,
      details: { minutes: settings.cooldownAfterLossMinutes },
      paperTradeId: closedTrade.id, tradingSessionId: closedTrade.tradingSessionId,
    });
  }
  if (history.recentClosesInLastHour >= 5) {
    await logRiskEvent({
      userId, eventType: "overtrading_detected", severity: "warning", decision: "warning",
      reason: `Overtrading: ${history.recentClosesInLastHour} closes in last hour`,
      details: { count: history.recentClosesInLastHour },
      paperTradeId: closedTrade.id, tradingSessionId: closedTrade.tradingSessionId,
    });
  }
  if (history.reentriesAfterLossInLastHour >= 2) {
    await logRiskEvent({
      userId, eventType: "revenge_trading_detected", severity: "warning", decision: "warning",
      reason: `Revenge pattern: ${history.reentriesAfterLossInLastHour} re-entries after losses in last hour`,
      details: { count: history.reentriesAfterLossInLastHour },
      paperTradeId: closedTrade.id, tradingSessionId: closedTrade.tradingSessionId,
    });
  }
}

export default router;
