// Phase UX8 — Trade Action Center endpoints (user-scoped).
//
// SAFETY:
//   * Every endpoint requires an authenticated user (req.authUser.id).
//   * All reads/updates filter by userId — cross-user reads are impossible.
//   * No endpoint executes a trade. POST /:id/confirm runs the 14-check
//     guard chain and (only on full pass) queues an mt5_commands row via
//     queueMt5CommandWithGate — which itself is paper-only locked.
//   * Safety envelope on every payload (success AND error).

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  tradeActionRequestsTable, tradeDecisionTimelineTable,
} from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";

import { createActionDraft, toSummary } from "../lib/tradeAction/create.js";
import { confirmAction } from "../lib/tradeAction/confirm.js";
import { cancelAction } from "../lib/tradeAction/cancel.js";
import { ACTION_TYPES, REQUESTED_MODES } from "../lib/tradeAction/types.js";
import { buildTradeDecision, loadUserDecisionPrefs } from "../lib/decision/orchestrator.js";
import { resolveUserTrade } from "../lib/trades/resolveTrade.js";
import { denyInvestorExecution } from "../lib/auth/productRole.js";

const router: IRouter = Router();

// INVESTOR accounts are view-only — the Trade Action Center creates/confirms/
// cancels trade actions, so they are denied per-route below (defense-in-depth
// on top of the central enforceProductRoleAccess gate). Applied per-route
// rather than via router.use() because this router is mounted globally
// (router.use(meTradeActionsRouter)); a router-level use() would leak the
// guard onto every later route in the chain, including the investor portal.
const uid = (req: Request) => (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

const draftSchema = z.object({
  actionType: z.enum(ACTION_TYPES),
  tradeKey: z.string().min(1).max(64).nullable().optional(),
  requestedMode: z.enum(REQUESTED_MODES).optional(),
  symbol: z.string().max(32).optional(),
  side: z.enum(["BUY", "SELL"]).nullable().optional(),
  lotSize: z.number().positive().max(100).nullable().optional(),
  requestedPrice: z.number().positive().nullable().optional(),
  stopLoss: z.number().positive().nullable().optional(),
  takeProfit: z.number().positive().nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  source: z.enum(["ai_suggested", "user_initiated", "decision_engine"]).optional(),
});

// ─── GET /api/me/trade-actions ──────────────────────────────────────────
router.get("/me/trade-actions", denyInvestorExecution, async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  try {
    const statusFilter = typeof req.query.status === "string" ? req.query.status : null;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const whereClauses = statusFilter
      ? and(eq(tradeActionRequestsTable.userId, userId), eq(tradeActionRequestsTable.status, statusFilter))
      : eq(tradeActionRequestsTable.userId, userId);
    const rows = await db.select().from(tradeActionRequestsTable)
      .where(whereClauses)
      .orderBy(desc(tradeActionRequestsTable.createdAt))
      .limit(limit);
    return res.json({
      ok: true,
      count: rows.length,
      actions: rows.map(toSummary),
      safety: SAFETY_ENVELOPE,
    });
  } catch (e) {
    req.log.error({ err: e, userId }, "trade_actions_list_failed");
    return res.status(500).json({ ok: false, error: "trade_actions_list_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── GET /api/me/trade-actions/:id ──────────────────────────────────────
router.get("/me/trade-actions/:id", denyInvestorExecution, async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(404).json({ ok: false, error: "action_not_found", safety: SAFETY_ENVELOPE });
  }
  try {
    const [row] = await db.select().from(tradeActionRequestsTable)
      .where(and(eq(tradeActionRequestsTable.id, id), eq(tradeActionRequestsTable.userId, userId)))
      .limit(1);
    if (!row) return res.status(404).json({ ok: false, error: "action_not_found", safety: SAFETY_ENVELOPE });
    return res.json({ ok: true, action: toSummary(row), safety: SAFETY_ENVELOPE });
  } catch (e) {
    req.log.error({ err: e, userId, id }, "trade_action_get_failed");
    return res.status(500).json({ ok: false, error: "trade_action_get_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── POST /api/me/trade-actions ─────────────────────────────────────────
router.post("/me/trade-actions", denyInvestorExecution, async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "invalid_body", details: parsed.error.issues, safety: SAFETY_ENVELOPE });
  }
  try {
    const result = await createActionDraft({
      userId,
      actionType: parsed.data.actionType,
      tradeKey: parsed.data.tradeKey ?? null,
      requestedMode: parsed.data.requestedMode,
      symbol: parsed.data.symbol,
      side: parsed.data.side ?? null,
      lotSize: parsed.data.lotSize ?? null,
      requestedPrice: parsed.data.requestedPrice ?? null,
      stopLoss: parsed.data.stopLoss ?? null,
      takeProfit: parsed.data.takeProfit ?? null,
      reason: parsed.data.reason ?? null,
      source: parsed.data.source,
    });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error, safety: SAFETY_ENVELOPE });
    }
    return res.status(201).json({ ok: true, action: result.action, safety: SAFETY_ENVELOPE });
  } catch (e) {
    req.log.error({ err: e, userId }, "trade_action_create_failed");
    return res.status(500).json({ ok: false, error: "trade_action_create_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── POST /api/me/trade-actions/:id/confirm ─────────────────────────────
router.post("/me/trade-actions/:id/confirm", denyInvestorExecution, async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(404).json({ ok: false, error: "action_not_found", safety: SAFETY_ENVELOPE });
  }
  try {
    const liveConfirmPhrase = typeof req.body?.liveConfirmPhrase === "string"
      ? String(req.body.liveConfirmPhrase).slice(0, 64)
      : null;
    const result = await confirmAction({ userId, actionId: id, liveConfirmPhrase });
    if (!result.ok) {
      const status = result.error === "action_not_found" ? 404 : 400;
      return res.status(status).json({ ok: false, error: result.error, action: result.action ?? null, safety: SAFETY_ENVELOPE });
    }
    return res.json({ ok: true, action: result.action, safety: SAFETY_ENVELOPE });
  } catch (e) {
    req.log.error({ err: e, userId, id }, "trade_action_confirm_failed");
    return res.status(500).json({ ok: false, error: "trade_action_confirm_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── POST /api/me/trade-actions/:id/cancel ──────────────────────────────
router.post("/me/trade-actions/:id/cancel", denyInvestorExecution, async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(404).json({ ok: false, error: "action_not_found", safety: SAFETY_ENVELOPE });
  }
  const reason = typeof req.body?.reason === "string" ? String(req.body.reason).slice(0, 500) : undefined;
  try {
    const result = await cancelAction({ userId, actionId: id, reason });
    if (!result.ok) {
      const status = result.error === "action_not_found" ? 404 : 400;
      return res.status(status).json({ ok: false, error: result.error, safety: SAFETY_ENVELOPE });
    }
    return res.json({ ok: true, action: result.action, safety: SAFETY_ENVELOPE });
  } catch (e) {
    req.log.error({ err: e, userId, id }, "trade_action_cancel_failed");
    return res.status(500).json({ ok: false, error: "trade_action_cancel_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── GET /api/me/trade-actions/:id/audit ────────────────────────────────
router.get("/me/trade-actions/:id/audit", denyInvestorExecution, async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(404).json({ ok: false, error: "action_not_found", safety: SAFETY_ENVELOPE });
  }
  try {
    const [row] = await db.select().from(tradeActionRequestsTable)
      .where(and(eq(tradeActionRequestsTable.id, id), eq(tradeActionRequestsTable.userId, userId)))
      .limit(1);
    if (!row) return res.status(404).json({ ok: false, error: "action_not_found", safety: SAFETY_ENVELOPE });

    const tk = row.tradeKey ?? `action_${row.id}`;
    const events = await db.select().from(tradeDecisionTimelineTable)
      .where(and(
        eq(tradeDecisionTimelineTable.userId, userId),
        eq(tradeDecisionTimelineTable.tradeKey, tk),
      ))
      .orderBy(desc(tradeDecisionTimelineTable.createdAt))
      .limit(200);

    // Only return rows that reference this action.
    const filtered = events.filter((e) => {
      const ctx = e.context as { actionId?: number } | null;
      return ctx?.actionId === row.id || (row.tradeKey === e.tradeKey && !ctx?.actionId);
    });

    return res.json({
      ok: true,
      action: toSummary(row),
      events: filtered.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        severity: e.severity,
        title: e.title,
        message: e.message,
        source: e.source,
        context: e.context,
        createdAt: e.createdAt.toISOString(),
      })),
      safety: SAFETY_ENVELOPE,
    });
  } catch (e) {
    req.log.error({ err: e, userId, id }, "trade_action_audit_failed");
    return res.status(500).json({ ok: false, error: "trade_action_audit_failed", safety: SAFETY_ENVELOPE });
  }
});

// ─── POST /api/me/trade-actions/from-decision/:tradeKey ─────────────────
// Convenience: creates a draft using the current decision's suggestedButton.
router.post("/me/trade-actions/from-decision/:tradeKey", denyInvestorExecution, async (req, res) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized", safety: SAFETY_ENVELOPE });
  const tradeKey = String(req.params.tradeKey ?? "");
  const trade = await resolveUserTrade(userId, tradeKey);
  if (!trade) return res.status(404).json({ ok: false, error: "trade_not_found_or_not_yours", safety: SAFETY_ENVELOPE });

  try {
    const prefs = await loadUserDecisionPrefs(userId);
    const result = await buildTradeDecision({
      tradeKey: trade.tradeKey, routingMode: trade.routingMode,
      symbol: trade.symbol, side: trade.side,
      entryPrice: trade.entryPrice, currentPrice: trade.currentPrice,
      stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
      unrealizedPnl: trade.unrealizedPnl, lotSize: trade.lotSize,
      openedAt: trade.openedAt,
    }, prefs);

    const btn = result.decision.suggestedButton;
    const map: Record<string, "CLOSE" | "PARTIAL_CLOSE" | "MOVE_STOP" | "TRAIL_STOP" | null> = {
      REVIEW_CLOSE: "CLOSE",
      REVIEW_PARTIAL_CLOSE: "PARTIAL_CLOSE",
      REVIEW_MOVE_STOP: "MOVE_STOP",
      REVIEW_TRAIL_STOP: "TRAIL_STOP",
      HOLD_AND_MONITOR: null,
      SET_ALERT: null,
      ASK_AI_WHY: null,
    };
    const actionType = map[btn];
    if (!actionType) {
      return res.status(400).json({ ok: false, error: "decision_has_no_actionable_button", suggestedButton: btn, safety: SAFETY_ENVELOPE });
    }

    const draft = await createActionDraft({
      userId, actionType, tradeKey: trade.tradeKey,
      requestedMode: "SIMULATED",
      symbol: trade.symbol, side: trade.side, lotSize: trade.lotSize,
      reason: `From decision: ${result.decision.decisionLabel} — ${result.decision.reasonSummary ?? ""}`.slice(0, 500),
      source: "decision_engine",
    });
    if (!draft.ok) return res.status(400).json({ ok: false, error: draft.error, safety: SAFETY_ENVELOPE });
    return res.status(201).json({ ok: true, action: draft.action, safety: SAFETY_ENVELOPE });
  } catch (e) {
    req.log.error({ err: e, userId, tradeKey }, "trade_action_from_decision_failed");
    return res.status(500).json({ ok: false, error: "trade_action_from_decision_failed", safety: SAFETY_ENVELOPE });
  }
});

export default router;
