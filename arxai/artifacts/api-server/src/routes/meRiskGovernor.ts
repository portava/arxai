// Phase 8D — Per-user Risk Governor routes: the trader's settings, status and
// audit trail. Every verdict comes from the one pre-trade Risk Governor
// (lib/riskGovernor); these routes only read, configure and explain it.
// SAFETY: requireUser, scope by req.authUser.id, never accept userId from client.
import { Router } from "express";
import {
  db, paperTradesTable,
  userRiskSettingsTable, userRiskEventsTable,
  tradingSessionsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { aggregateHistory, DEFAULT_USER_RISK_SETTINGS } from "../lib/riskGovernor/journalActivity.js";
import { parseSymbolLimits } from "../lib/riskGovernor/preTrade.js";
import { previewJournalTicket } from "../lib/riskGovernor/journal.js";
import { loadStoredLimitRows } from "../lib/riskGovernor/enforce.js";
import { explainLimitLayers, effectiveLimitViews } from "../lib/riskGovernor/limitLayers.js";

const router = Router();

const SAFE_LIVE_CONTRACT = { liveLocked: true as const, readOnlyMode: true as const, allowOrderExecution: false as const };

export { getOrCreateRiskSettings, logRiskEvent } from "../lib/riskGovernor/riskEvents.js";
import { getOrCreateRiskSettings, logRiskEvent } from "../lib/riskGovernor/riskEvents.js";
import { readTraderRiskSettings } from "../lib/riskGovernor/limitSettings.js";

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
  const existing = await readTraderRiskSettings(userId);
  const body = sanitizeBody(req.body ?? {});
  if (existing) {
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
// Limits in force, layer by layer: platform ceiling, the operator's account
// limits for this trader, the trader's own settings, and the effective value
// the Risk Governor uses (strictest wins). Read-only.
router.get("/me/risk-limits/layers", requireUser, async (req, res) => {
  const { rows, limits } = explainLimitLayers(await loadStoredLimitRows(req.authUser!.id));
  res.json({
    rule: "strictest_wins",
    rows,
    restrictions: {
      requireStopLoss: limits.requireStopLoss,
      liveAllowed: limits.liveAllowed,
      allowedSymbols: limits.allowedSymbols,
      allowedDirection: limits.allowedDirection,
    },
  });
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
  // Exposure limits (Tier 1 step 8). Positive numbers or null; the Risk
  // Governor only ever uses them to tighten the platform ceilings.
  for (const k of ["maxLeverage", "maxSymbolLeverage", "maxPortfolioRiskPercent", "maxDrawdownPercent"]) {
    if (b[k] === null || (typeof b[k] === "number" && Number.isFinite(b[k]) && (b[k] as number) > 0)) out[k] = b[k];
  }
  if (b["maxPositionsPerSymbol"] === null || (Number.isInteger(b["maxPositionsPerSymbol"]) && (b["maxPositionsPerSymbol"] as number) > 0)) {
    out["maxPositionsPerSymbol"] = b["maxPositionsPerSymbol"];
  }
  if (b["symbolLimits"] !== undefined) out["symbolLimits"] = parseSymbolLimits(b["symbolLimits"]);
  // Reject any client attempt to flip live contract or set userId
  delete (b as Record<string, unknown>).userId;
  delete (b as Record<string, unknown>).liveLocked;
  delete (b as Record<string, unknown>).readOnlyMode;
  delete (b as Record<string, unknown>).allowOrderExecution;
  return out;
}

// ── Risk check (used by frontend pre-flight) ─────────────────────────────
// A preview of the Risk Governor for a paper ticket: the same 13 rules the
// open will face. Logged as a risk_check event, as it always has been.
router.post("/me/risk/check-paper-trade", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const b = req.body ?? {};
  if (b.liveExecutionIntent === true) {
    const reason = "This check is for paper tickets. Live orders are checked by the Risk Governor when you send them from the live ticket.";
    await logRiskEvent({ userId, eventType: "live_execution_blocked", severity: "critical", decision: "block", reason,
      details: { source: "pre_trade_risk_governor", preflight: true } });
    res.json({ decision: "block", reason, failedRules: [{ rule: "live_execution_intent", severity: "critical" }], requiredActions: [reason],
      overrideAllowed: false, liveExecutionAttempted: true, rules: [] });
    return;
  }
  const check = await previewJournalTicket(userId, {
    symbol: String(b.symbol ?? ""), side: typeof b.side === "string" ? b.side : null,
    lots: nullableNum(b.lotSize), entryPrice: nullableNum(b.entryPrice),
    stopLoss: nullableNum(b.stopLoss), takeProfit: nullableNum(b.takeProfit),
    mt5ConnectionId: nullableNum(b.mt5ConnectionId),
    process: {
      playbookId: nullableNum(b.playbookId),
      preTradeCheckPassed: typeof b.preTradeCheckPassed === "boolean" ? b.preTradeCheckPassed : null,
      preTradeCheckDecision: typeof b.preTradeCheckDecision === "string" ? b.preTradeCheckDecision : null,
      reasonForEntry: typeof b.reasonForEntry === "string" ? b.reasonForEntry : null,
    },
  });
  await logRiskEvent({
    userId, eventType: check.decision === "block" ? "blocked_trade" : "risk_check",
    severity: check.decision === "block" ? "critical" : "info", decision: check.decision, reason: check.reason,
    details: { source: "pre_trade_risk_governor", preflight: true, blockedBy: check.risk.blockedBy, rules: check.risk.rules },
    paperTradeId: nullableNum(b.paperTradeId), tradingSessionId: nullableNum(b.tradingSessionId),
  });
  res.json({
    decision: check.decision, reason: check.reason, failedRules: check.failedRules, requiredActions: check.requiredActions,
    overrideAllowed: check.overrideAllowed, liveExecutionAttempted: false, rules: check.risk.rules, blockedBy: check.risk.blockedBy,
  });
});

router.get("/me/risk/events", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(userRiskEventsTable)
    .where(eq(userRiskEventsTable.userId, userId))
    .orderBy(desc(userRiskEventsTable.createdAt)).limit(200);
  res.json({ events: rows, isEmpty: rows.length === 0 });
});

// Status views show the limits the Risk Governor enforces (owner decision 8):
// `effective` (and the cap fields) come from resolveEffectiveLimits through
// effectiveLimitViews, with the trader's saved preference and the reason an
// operator cap, the platform ceiling, a default or the trader's own switch
// overrides it. `settings` stays the saved row (what the settings page edits).
router.get("/me/risk/status", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const settings = await getOrCreateRiskSettings(userId);
  const { limits, views } = effectiveLimitViews(await loadStoredLimitRows(userId));
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const history = aggregateHistory(trades);
  const lastBlocked = (await db.select().from(userRiskEventsTable)
    .where(and(eq(userRiskEventsTable.userId, userId), eq(userRiskEventsTable.decision, "block")))
    .orderBy(desc(userRiskEventsTable.createdAt)).limit(1))[0] ?? null;
  const cooldownMin = limits.discipline.cooldownAfterLossMinutes;
  res.json({
    settings: withSafetyContract(settings),
    effective: views,
    today: { pnl: history.todayPnl, trades: history.tradesToday, openTrades: history.openTradesCount, consecutiveLosses: history.consecutiveLosses },
    week: { pnl: history.weekPnl },
    cooldown: cooldownMin != null && history.lastClosedWasLoss && history.lastClosedAt
      ? { active: (Date.now() - history.lastClosedAt.getTime()) / 60_000 < cooldownMin,
          minutesRemaining: Math.max(0, Math.ceil(cooldownMin - (Date.now() - history.lastClosedAt.getTime()) / 60_000)) }
      : { active: false, minutesRemaining: 0 },
    lastBlocked: lastBlocked ? { reason: lastBlocked.reason, createdAt: lastBlocked.createdAt, eventType: lastBlocked.eventType } : null,
    activitySource: "paper_trades",
    safetyMode: "paper_only", educationalOnly: true, ...SAFE_LIVE_CONTRACT,
  });
});

router.get("/me/risk/daily-status", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const settings = await getOrCreateRiskSettings(userId);
  const { limits, views } = effectiveLimitViews(await loadStoredLimitRows(userId));
  const trades = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const history = aggregateHistory(trades);
  const D = limits.discipline;
  res.json({
    pnl: history.todayPnl, trades: history.tradesToday,
    // Enforced values (null = no limit applies).
    maxTradesPerDay: D.maxTradesPerDay, maxDailyLossPercent: limits.maxDailyLossPercent,
    consecutiveLosses: history.consecutiveLosses, maxConsecutiveLosses: D.maxConsecutiveLosses,
    dailyTradeCapHit: D.maxTradesPerDay != null && history.tradesToday >= D.maxTradesPerDay,
    consecutiveLossCapHit: D.maxConsecutiveLosses != null && history.consecutiveLosses >= D.maxConsecutiveLosses,
    // The trader's saved preferences, shown separately.
    preference: {
      maxTradesPerDay: settings.maxTradesPerDay, maxDailyLossPercent: settings.maxDailyLossPercent,
      maxConsecutiveLosses: settings.maxConsecutiveLosses,
    },
    effective: {
      maxTradesPerDay: views["maxTradesPerDay"], maxDailyLossPercent: views["maxDailyLossPercent"],
      maxConsecutiveLosses: views["maxConsecutiveLosses"],
    },
    tradingDay: "UTC",
    activitySource: "paper_trades",
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
