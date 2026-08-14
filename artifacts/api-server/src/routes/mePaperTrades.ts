// Phase 5B — User-safe paper trade lifecycle routes.
// SAFETY: paper-only. No broker order is ever placed from this file.
// Every route requires login; every query is scoped by req.authUser.id.
import { Router } from "express";
import {
  db, paperTradesTable, tradingSessionsTable, mt5ConnectionTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { evaluateForPaperOpen, postPaperCloseRiskHooks } from "./meRiskGovernor.js";
import { fireNotify, fireActivity } from "../lib/notificationService.js";

const router = Router();

const SIDES = ["buy", "sell"] as const;
const ENTRY_TYPES = ["market", "limit", "stop", "manual"] as const;
const STATUS_OPEN_OK = new Set(["planned"]);
const STATUS_CLOSE_OK = new Set(["open"]);
const STATUS_CANCEL_OK = new Set(["planned", "open"]);

const CreateBody = z.object({
  symbol: z.string().min(1).max(32),
  side: z.enum(SIDES),
  entryType: z.enum(ENTRY_TYPES).optional(),
  plannedEntryPrice: z.number().finite().positive().nullable().optional(),
  stopLoss: z.number().finite().positive().nullable().optional(),
  takeProfit: z.number().finite().positive().nullable().optional(),
  lotSize: z.number().finite().positive().max(100),
  riskAmount: z.number().finite().nonnegative().nullable().optional(),
  riskPercent: z.number().finite().min(0).max(100).nullable().optional(),
  tradingSessionId: z.number().int().nullable().optional(),
  mt5ConnectionId: z.number().int().nullable().optional(),
  strategyTag: z.string().max(80).nullable().optional(),
  setupGrade: z.enum(["A", "B", "C", "D"]).nullable().optional(),
  aiConfidence: z.number().min(0).max(100).nullable().optional(),
  reasonForEntry: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  screenshotUrl: z.string().url().max(500).nullable().optional(),
});

const PatchBody = CreateBody.partial().extend({
  mistakeTags: z.array(z.string().max(40)).max(20).optional(),
});

const OpenBody = z.object({
  entryPrice: z.number().finite().positive(),
  openedAt: z.string().datetime().optional(),
});

const CloseBody = z.object({
  exitPrice: z.number().finite().positive(),
  reasonForExit: z.string().max(2000).nullable().optional(),
  mistakeTags: z.array(z.string().max(40)).max(20).optional(),
  closedAt: z.string().datetime().optional(),
});

function rrr(side: string, entry: number | null | undefined, sl: number | null | undefined, tp: number | null | undefined) {
  if (!entry || !sl || !tp) return null;
  const risk = side === "buy" ? entry - sl : sl - entry;
  const reward = side === "buy" ? tp - entry : entry - tp;
  if (risk <= 0 || reward <= 0) return null;
  return Number((reward / risk).toFixed(3));
}
function pnlFor(side: string, entry: number, exit: number, lot: number) {
  const dir = side === "buy" ? 1 : -1;
  // Simple per-unit PnL × lotSize (broker-agnostic, paper-only).
  return Number(((exit - entry) * dir * lot).toFixed(4));
}

async function ownTrade(userId: number, id: number) {
  const r = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.id, id), eq(paperTradesTable.userId, userId)))
    .limit(1);
  return r[0] ?? null;
}
async function verifySession(userId: number, sessionId: number | null | undefined) {
  if (sessionId == null) return true;
  const r = await db.select({ id: tradingSessionsTable.id }).from(tradingSessionsTable)
    .where(and(eq(tradingSessionsTable.id, sessionId), eq(tradingSessionsTable.userId, userId)))
    .limit(1);
  return !!r[0];
}
async function verifyConnection(userId: number, connId: number | null | undefined) {
  if (connId == null) return true;
  const r = await db.select({ id: mt5ConnectionTable.id }).from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.id, connId), eq(mt5ConnectionTable.userId, userId)))
    .limit(1);
  return !!r[0];
}

function serialize(t: typeof paperTradesTable.$inferSelect) {
  return {
    ...t,
    openedAt: t.openedAt?.toISOString() ?? null,
    closedAt: t.closedAt?.toISOString() ?? null,
    cancelledAt: t.cancelledAt?.toISOString() ?? null,
    createdAt: t.createdAt?.toISOString() ?? null,
    updatedAt: t.updatedAt?.toISOString() ?? null,
    tradeKind: "paper" as const,
    safetyMode: "paper_only" as const,
  };
}

// LIST
router.get("/me/paper-trades", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  const status = (req.query.status as string | undefined)?.toLowerCase();
  const baseWhere = eq(paperTradesTable.userId, userId);
  const where = status ? and(baseWhere, eq(paperTradesTable.status, status)) : baseWhere;
  const rows = await db.select().from(paperTradesTable).where(where)
    .orderBy(desc(paperTradesTable.createdAt)).limit(500);
  res.json({ trades: rows.map(serialize) });
});

// LIST by session
router.get("/me/trading-sessions/:id/paper-trades", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const sessionId = Number(req.params.id);
  if (!Number.isFinite(sessionId)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!(await verifySession(userId, sessionId))) { res.status(404).json({ error: "Session not found" }); return; }
  const rows = await db.select().from(paperTradesTable)
    .where(and(eq(paperTradesTable.userId, userId), eq(paperTradesTable.tradingSessionId, sessionId)))
    .orderBy(desc(paperTradesTable.createdAt)).limit(500);
  res.json({ trades: rows.map(serialize) });
});

// GET ONE
router.get("/me/paper-trades/:id", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const t = await ownTrade(userId, id);
  if (!t) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serialize(t));
});

// CREATE — always status=planned. Never accepts userId from client.
router.post("/me/paper-trades", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const body = CreateBody.parse(req.body ?? {});
    if (!(await verifySession(userId, body.tradingSessionId))) {
      res.status(404).json({ error: "Trading session not found" }); return;
    }
    if (!(await verifyConnection(userId, body.mt5ConnectionId))) {
      res.status(404).json({ error: "MT5 connection not found" }); return;
    }
    const rr = rrr(body.side, body.plannedEntryPrice ?? null, body.stopLoss ?? null, body.takeProfit ?? null);
    const inserted = await db.insert(paperTradesTable).values({
      userId,
      tradingSessionId: body.tradingSessionId ?? null,
      mt5ConnectionId: body.mt5ConnectionId ?? null,
      symbol: body.symbol.toUpperCase(),
      side: body.side,
      status: "planned",
      entryType: body.entryType ?? "market",
      plannedEntryPrice: body.plannedEntryPrice ?? null,
      stopLoss: body.stopLoss ?? null,
      takeProfit: body.takeProfit ?? null,
      lotSize: body.lotSize,
      riskAmount: body.riskAmount ?? null,
      riskPercent: body.riskPercent ?? null,
      rewardRiskRatio: rr,
      strategyTag: body.strategyTag ?? null,
      setupGrade: body.setupGrade ?? null,
      aiConfidence: body.aiConfidence ?? null,
      reasonForEntry: body.reasonForEntry ?? null,
      notes: body.notes ?? null,
      screenshotUrl: body.screenshotUrl ?? null,
    }).returning();
    const created = inserted[0]!;
    // Phase 28-AUD: audit hook — paper order draft created (per-user scoped,
    // secrets scrubbed by notificationService, fire-and-forget).
    fireActivity(userId, {
      eventType: "paper_order_created",
      title: `Paper order draft created: ${created.symbol}`,
      description: `${created.side.toUpperCase()} ${created.lotSize} ${created.entryType ?? "market"}`,
      source: "trade", entityType: "paper_trade", entityId: created.id,
      metadata: {
        symbol: created.symbol, side: created.side, entryType: created.entryType,
        lotSize: Number(created.lotSize), plannedEntryPrice: created.plannedEntryPrice,
        stopLoss: created.stopLoss, takeProfit: created.takeProfit,
        safetyGate: { safetyMode: "paper_only", liveLocked: true, allowOrderExecution: false },
      },
    });
    res.status(201).json(serialize(created));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "POST /me/paper-trades failed");
    res.status(500).json({ error: "Failed" });
  }
});

// PATCH (only while planned/open; reject userId/status changes from client)
router.patch("/me/paper-trades/:id", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const t = await ownTrade(userId, id);
    if (!t) { res.status(404).json({ error: "Not found" }); return; }
    if (t.status === "closed" || t.status === "cancelled") {
      res.status(409).json({ error: "Trade is locked", status: t.status }); return;
    }
    const body = PatchBody.parse(req.body ?? {});
    if (body.tradingSessionId !== undefined && !(await verifySession(userId, body.tradingSessionId))) {
      res.status(404).json({ error: "Trading session not found" }); return;
    }
    if (body.mt5ConnectionId !== undefined && !(await verifyConnection(userId, body.mt5ConnectionId))) {
      res.status(404).json({ error: "MT5 connection not found" }); return;
    }
    const next = { ...t, ...body, updatedAt: new Date() };
    next.rewardRiskRatio = rrr(next.side, next.plannedEntryPrice ?? next.entryPrice, next.stopLoss, next.takeProfit);
    await db.update(paperTradesTable).set({
      tradingSessionId: next.tradingSessionId,
      mt5ConnectionId: next.mt5ConnectionId,
      symbol: typeof next.symbol === "string" ? next.symbol.toUpperCase() : next.symbol,
      entryType: next.entryType,
      plannedEntryPrice: next.plannedEntryPrice,
      stopLoss: next.stopLoss,
      takeProfit: next.takeProfit,
      lotSize: next.lotSize,
      riskAmount: next.riskAmount,
      riskPercent: next.riskPercent,
      rewardRiskRatio: next.rewardRiskRatio,
      strategyTag: next.strategyTag,
      setupGrade: next.setupGrade,
      aiConfidence: next.aiConfidence,
      reasonForEntry: next.reasonForEntry,
      notes: next.notes,
      mistakeTags: body.mistakeTags ?? t.mistakeTags ?? [],
      screenshotUrl: next.screenshotUrl,
      updatedAt: new Date(),
    }).where(and(eq(paperTradesTable.id, id), eq(paperTradesTable.userId, userId)));
    const fresh = await ownTrade(userId, id);
    // Phase 28-AUD: audit hooks — emit a granular SL/TP edited event only when
    // the value actually changed. Captures previous/new values. Per-user
    // scoped, no secrets, dedupe-friendly (notification bucket = 1h).
    if (body.stopLoss !== undefined && body.stopLoss !== t.stopLoss) {
      fireActivity(userId, {
        eventType: "paper_trade_sl_edited",
        title: `Stop loss edited: ${t.symbol}`,
        description: `SL ${t.stopLoss ?? "—"} → ${body.stopLoss ?? "—"}`,
        source: "trade", entityType: "paper_trade", entityId: id,
        metadata: { field: "stopLoss", previous: t.stopLoss, next: body.stopLoss, status: t.status },
      });
    }
    if (body.takeProfit !== undefined && body.takeProfit !== t.takeProfit) {
      fireActivity(userId, {
        eventType: "paper_trade_tp_edited",
        title: `Take profit edited: ${t.symbol}`,
        description: `TP ${t.takeProfit ?? "—"} → ${body.takeProfit ?? "—"}`,
        source: "trade", entityType: "paper_trade", entityId: id,
        metadata: { field: "takeProfit", previous: t.takeProfit, next: body.takeProfit, status: t.status },
      });
    }
    res.json(serialize(fresh!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "PATCH /me/paper-trades/:id failed");
    res.status(500).json({ error: "Failed" });
  }
});

// OPEN
router.post("/me/paper-trades/:id/open", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const t = await ownTrade(userId, id);
    if (!t) { res.status(404).json({ error: "Not found" }); return; }
    if (!STATUS_OPEN_OK.has(t.status)) { res.status(409).json({ error: `Cannot open from status=${t.status}` }); return; }
    const body = OpenBody.parse(req.body ?? {});
    const openedAt = body.openedAt ? new Date(body.openedAt) : new Date();
    const rr = rrr(t.side, body.entryPrice, t.stopLoss, t.takeProfit);
    // Phase 8E — Risk Governor pre-flight (paper-only). Override allowed in paper mode with reason.
    const overrideReason = typeof (req.body as Record<string, unknown> | undefined)?.overrideReason === "string"
      ? String((req.body as Record<string, unknown>).overrideReason) : null;
    const tForCheck = { ...t, entryPrice: body.entryPrice, rewardRiskRatio: rr ?? t.rewardRiskRatio };
    const guard = await evaluateForPaperOpen(userId, { trade: tForCheck, override: overrideReason ? { reason: overrideReason } : null });
    if (!guard.allow) {
      // Phase 28-AUD: audit hook — blocked paper order. Captures decision,
      // failed rules, and the safety gate state. No secrets; per-user scoped.
      fireActivity(userId, {
        eventType: "paper_order_blocked",
        title: `Paper order blocked: ${t.symbol}`,
        description: `Risk Governor: ${guard.result.reason ?? guard.result.decision}`,
        source: "risk", entityType: "paper_trade", entityId: id,
        metadata: {
          decision: guard.result.decision, reason: guard.result.reason,
          failedRules: guard.result.failedRules, overrideAllowed: guard.result.overrideAllowed,
          attemptedEntryPrice: body.entryPrice, overrideReason,
          safetyGate: { safetyMode: "paper_only", liveLocked: true, allowOrderExecution: false },
        },
      });
      res.status(409).json({
        error: "RISK_GOVERNOR_BLOCKED",
        decision: guard.result.decision, reason: guard.result.reason,
        failedRules: guard.result.failedRules, requiredActions: guard.result.requiredActions,
        overrideAllowed: guard.result.overrideAllowed,
        message: "Paper trade blocked by your Risk Governor. Provide an overrideReason (paper mode only) if you accept the risk.",
        safetyMode: "paper_only", liveLocked: true, allowOrderExecution: false,
      });
      return;
    }
    const updated = await db.update(paperTradesTable).set({
      status: "open",
      entryPrice: body.entryPrice,
      openedAt,
      rewardRiskRatio: rr ?? t.rewardRiskRatio,
      updatedAt: new Date(),
    }).where(and(eq(paperTradesTable.id, id), eq(paperTradesTable.userId, userId))).returning();
    fireNotify(userId,
      { notificationType: "paper_trade_opened", severity: "info", title: `Paper trade opened: ${t.symbol}`, message: `${t.side.toUpperCase()} ${t.lotSize} @ ${body.entryPrice}`, source: "trade", entityType: "paper_trade", entityId: id, actionLabel: "View trade", actionTarget: "/paper-trading" },
      { eventType: "paper_trade_opened", title: `Paper trade opened: ${t.symbol}`, description: `${t.side.toUpperCase()} ${t.lotSize} @ ${body.entryPrice}`, source: "trade", entityType: "paper_trade", entityId: id }
    );
    res.json(serialize(updated[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "open failed");
    res.status(500).json({ error: "Failed" });
  }
});

// CLOSE — computes pnl, updates linked trading_session aggregates.
router.post("/me/paper-trades/:id/close", requireUser, async (req, res): Promise<void> => {
  try {
    const userId = req.authUser!.id;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const t = await ownTrade(userId, id);
    if (!t) { res.status(404).json({ error: "Not found" }); return; }
    if (!STATUS_CLOSE_OK.has(t.status)) { res.status(409).json({ error: `Cannot close from status=${t.status}` }); return; }
    if (t.entryPrice == null) { res.status(409).json({ error: "Trade has no entry price" }); return; }
    const body = CloseBody.parse(req.body ?? {});
    const pnl = pnlFor(t.side, t.entryPrice, body.exitPrice, t.lotSize);
    const pnlPercent = t.riskAmount && t.riskAmount > 0 ? Number(((pnl / t.riskAmount) * 100).toFixed(2)) : null;
    const closedAt = body.closedAt ? new Date(body.closedAt) : new Date();
    const updated = await db.update(paperTradesTable).set({
      status: "closed",
      exitPrice: body.exitPrice,
      pnl,
      pnlPercent,
      closedAt,
      reasonForExit: body.reasonForExit ?? t.reasonForExit ?? null,
      mistakeTags: body.mistakeTags ?? t.mistakeTags ?? [],
      updatedAt: new Date(),
    }).where(and(eq(paperTradesTable.id, id), eq(paperTradesTable.userId, userId))).returning();
    // Update linked trading session aggregates (paper-only, ownership re-checked).
    if (t.tradingSessionId) {
      const sess = await db.select().from(tradingSessionsTable)
        .where(and(eq(tradingSessionsTable.id, t.tradingSessionId), eq(tradingSessionsTable.userId, userId)))
        .limit(1);
      if (sess[0]) {
        const isWin = pnl > 0;
        const isLoss = pnl < 0;
        await db.update(tradingSessionsTable).set({
          pnl: Number(((sess[0].pnl ?? 0) + pnl).toFixed(4)),
          winCount: sess[0].winCount + (isWin ? 1 : 0),
          lossCount: sess[0].lossCount + (isLoss ? 1 : 0),
          updatedAt: new Date(),
        }).where(and(eq(tradingSessionsTable.id, t.tradingSessionId), eq(tradingSessionsTable.userId, userId)));
      }
    }
    // Phase 8E — Post-close risk hooks (cooldown, streak, overtrading, revenge).
    try { await postPaperCloseRiskHooks(userId, updated[0]!); } catch (e) { req.log.warn({ err: String(e) }, "risk post-close hooks failed"); }
    // Phase Playbook — Auto-tag a journal entry with the most recent pre-trade
    // check for this trade so AI coach + strategy performance see real data.
    try {
      const { preTradeChecksTable, tradeJournalEntriesTable } = await import("@workspace/db/schema");
      const [check] = await db.select().from(preTradeChecksTable)
        .where(and(eq(preTradeChecksTable.userId, userId), eq(preTradeChecksTable.paperTradeId, id)))
        .orderBy(desc(preTradeChecksTable.createdAt)).limit(1);
      const score = check ? Number(check.score ?? 0) : null;
      const label = score == null ? null : (score >= 90 ? "A+" : score >= 80 ? "A" : score >= 70 ? "B" : score >= 60 ? "C" : score >= 40 ? "low" : "avoid");
      const [existing] = await db.select({ id: tradeJournalEntriesTable.id }).from(tradeJournalEntriesTable)
        .where(and(eq(tradeJournalEntriesTable.userId, userId), eq(tradeJournalEntriesTable.tradeId, id))).limit(1);
      const setupTag = (t as { setupTag?: string | null }).setupTag ?? null;
      if (!existing) {
        const [createdJournal] = await db.insert(tradeJournalEntriesTable).values({
          userId, tradeId: id,
          symbol: t.symbol, direction: t.side === "sell" ? "SELL" : "BUY",
          setupTag: setupTag,
          setupQualityScore: score,
          setupQualityLabel: label,
          matchedPlaybookId: check ? check.playbookId : null,
          setupQualitySource: check ? "pre_trade_check" : "unavailable",
        }).returning({ id: tradeJournalEntriesTable.id });
        // Phase 28-AUD: audit hook — journal entry created on close.
        fireActivity(userId, {
          eventType: "journal_entry_created",
          title: `Journal entry created: ${t.symbol}`,
          description: `Auto-tagged from paper trade close${label ? ` (setup: ${label})` : ""}`,
          source: "journal", entityType: "trade_journal_entry", entityId: createdJournal?.id ?? null,
          metadata: { tradeId: id, setupQualityScore: score, setupQualityLabel: label, source: check ? "pre_trade_check" : "unavailable" },
        });
      } else if (check) {
        await db.update(tradeJournalEntriesTable).set({
          setupQualityScore: score, setupQualityLabel: label,
          matchedPlaybookId: check.playbookId, setupQualitySource: "pre_trade_check",
          updatedAt: new Date(),
        }).where(eq(tradeJournalEntriesTable.id, existing.id));
        // Phase 28-AUD: audit hook — journal entry updated on close.
        fireActivity(userId, {
          eventType: "journal_entry_updated",
          title: `Journal entry updated: ${t.symbol}`,
          description: `Re-tagged from paper trade close${label ? ` (setup: ${label})` : ""}`,
          source: "journal", entityType: "trade_journal_entry", entityId: existing.id,
          metadata: { tradeId: id, setupQualityScore: score, setupQualityLabel: label, source: "pre_trade_check" },
        });
      }
    } catch (e) { req.log.warn({ err: String(e) }, "playbook auto-tag on close failed"); }
    fireNotify(userId,
      { notificationType: "paper_trade_closed", severity: pnl >= 0 ? "info" : "warning", title: `Paper trade closed: ${t.symbol}`, message: `P&L ${pnl.toFixed(2)}${pnlPercent != null ? ` (${pnlPercent}%)` : ""}`, source: "trade", entityType: "paper_trade", entityId: id, actionLabel: "Open journal", actionTarget: "/paper-trading" },
      { eventType: "paper_trade_closed", title: `Paper trade closed: ${t.symbol}`, description: `P&L ${pnl.toFixed(2)}`, source: "trade", entityType: "paper_trade", entityId: id, metadata: { pnl, pnlPercent } }
    );
    res.json(serialize(updated[0]!));
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Invalid body", details: err.issues }); return; }
    req.log.error({ err: String(err) }, "close failed");
    res.status(500).json({ error: "Failed" });
  }
});

// CANCEL
router.post("/me/paper-trades/:id/cancel", requireUser, async (req, res): Promise<void> => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const t = await ownTrade(userId, id);
  if (!t) { res.status(404).json({ error: "Not found" }); return; }
  if (!STATUS_CANCEL_OK.has(t.status)) { res.status(409).json({ error: `Cannot cancel from status=${t.status}` }); return; }
  const updated = await db.update(paperTradesTable).set({
    status: "cancelled", cancelledAt: new Date(), updatedAt: new Date(),
  }).where(and(eq(paperTradesTable.id, id), eq(paperTradesTable.userId, userId))).returning();
  fireNotify(userId,
    { notificationType: "paper_trade_cancelled", severity: "info", title: `Paper trade cancelled: ${t.symbol}`, message: "", source: "trade", entityType: "paper_trade", entityId: id },
    { eventType: "paper_trade_cancelled", title: `Paper trade cancelled: ${t.symbol}`, source: "trade", entityType: "paper_trade", entityId: id }
  );
  res.json(serialize(updated[0]!));
});

export default router;
