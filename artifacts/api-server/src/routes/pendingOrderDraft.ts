// Phase TT — Pending order DRAFT route.
// Phase TU — capabilities probe + honest submit (never enqueues today).
// Phase TV — forward-wired submit/cancel-via-bridge/modify-protection.
//
// SAFETY:
//   * The submit/cancel/modify-protection branches go through
//     queueMt5CommandWithGate, which is hardcoded to status="BLOCKED" under
//     the system paper-only lock (see queueCommand in routes/mt5.ts). Today
//     every code path lands in BLOCKED_BY_PAPER_LOCK / EA_UPGRADE_REQUIRED /
//     BRIDGE_UNSUPPORTED. No row ever leaves with status="PENDING" so the EA
//     poll cannot pick it up. The forward-wiring exists for the day the
//     paper-only lock is lifted (separate, deliberate work).
//   * Per-user-scoped on every read/write. No admin/global state.
//   * Runs validateOrderTicket + enforceTradeTicketRules + enforceRiskGovernor.
//   * Returns honest `executable:false` and never claims PLACED — PLACED is
//     only ever written by the /mt5/command-result write-back path AFTER
//     MT5 returns a real ticket.

import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { tradeActionRequestsTable, userRiskSettingsTable, mt5ConnectionTable } from "@workspace/db/schema";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod/v4";
import { ORDER_TYPES, isMarketOrder, directionOf, type OrderType } from "../lib/tradeAction/orderTypes.js";
import { enforceTradeTicketRules } from "../lib/tradeAction/riskGovernorEnforcement.js";
import { enforceRiskGovernor } from "../lib/tradeAction/riskGovernorEnforcement.js";
import { resolveRouting } from "../lib/adminTrading/routingResolver.js";
import { queueMt5CommandWithGate } from "./mt5.js";
import {
  normaliseCapabilities,
  resolvePendingSubmitStatus,
  explainStatus,
  ALL_FALSE_CAPABILITIES,
  type BridgeCapabilities,
  type PendingSubmitStatus,
} from "../lib/mt5/bridgeCapabilities.js";

const router: IRouter = Router();

function userIdOf(req: Request): number {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? 0;
}

const SAFETY = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

const PendingDraftSchema = z.object({
  orderType: z.enum(ORDER_TYPES),
  symbol: z.string().min(1).max(20),
  lotSize: z.number().positive().max(100),
  entryPrice: z.number().nullable().optional(),
  stopTriggerPrice: z.number().nullable().optional(),
  stopLimitPrice: z.number().nullable().optional(),
  stopLoss: z.number().nullable().optional(),
  takeProfit: z.number().nullable().optional(),
  currentPrice: z.number().nullable().optional(),
  expiration: z.string().datetime().nullable().optional(),
  requestedMode: z.enum(["SIMULATED", "DEMO", "LIVE"]).default("SIMULATED"),
  reason: z.string().max(500).optional(),
});

// ── POST /me/pending-order-draft ────────────────────────────────────────────
// Validate + persist a pending-order draft. NEVER calls the bridge.
router.post("/me/pending-order-draft", async (req, res): Promise<void> => {
  const userId = userIdOf(req);
  if (!userId) { res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY }); return; }

  const parsed = PendingDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid_payload", details: parsed.error.issues, ...SAFETY });
    return;
  }
  const body = parsed.data;
  const orderType = body.orderType as OrderType;

  // Reject if a market type slipped in here — market orders use /me/trades/open.
  if (isMarketOrder(orderType)) {
    res.status(400).json({
      ok: false,
      error: "wrong_route_for_market_order",
      reason: "Market orders go through /api/me/trades/open. This endpoint is for pending orders only.",
      ...SAFETY,
    });
    return;
  }

  // 1. Load user min-RR setting (best-effort).
  let minRr: number | null = null;
  try {
    const [s] = await db.select().from(userRiskSettingsTable)
      .where(eq(userRiskSettingsTable.userId, userId)).limit(1);
    // Future-proof: minRiskRewardRatio column does not exist yet; this is a
    // pre-wired hook so the value flows through once admin/risk settings expose it.
    const v = (s as unknown as { minRiskRewardRatio?: number | null } | undefined)?.minRiskRewardRatio;
    minRr = typeof v === "number" && v > 0 ? v : null;
  } catch { /* non-critical */ }

  // 2. Price-level ticket validation + RR floor.
  const ticket = enforceTradeTicketRules({
    userId,
    requestedMode: body.requestedMode,
    orderType,
    lotSize: body.lotSize,
    currentPrice: body.currentPrice ?? null,
    entryPrice: body.entryPrice ?? null,
    stopTriggerPrice: body.stopTriggerPrice ?? null,
    stopLimitPrice: body.stopLimitPrice ?? null,
    stopLoss: body.stopLoss ?? null,
    takeProfit: body.takeProfit ?? null,
    minRiskRewardRatio: minRr,
  });

  if (!ticket.passed) {
    res.status(200).json({
      ok: false,
      executable: false,
      blocked: true,
      checkId: ticket.checkId,
      reason: ticket.reason,
      validation: ticket.validation,
      ...SAFETY,
    });
    return;
  }

  // 3. Account-level risk governor (preview mode — no audit pollution).
  const routing = await resolveRouting({ userId, mode: body.requestedMode }).catch(() => null);
  const rg = await enforceRiskGovernor({
    userId,
    actionId: 0,
    actionType: "OPEN",
    requestedMode: body.requestedMode,
    symbol: body.symbol,
    side: directionOf(orderType),
    lotSize: body.lotSize,
    routingMode: routing?.effectiveRoutingMode ?? null,
    virtualAccountId: routing?.virtualAccountId ?? null,
    previewMode: true,
  });

  if (!rg.passed) {
    res.status(200).json({
      ok: false,
      executable: false,
      blocked: true,
      checkId: rg.checkId,
      reason: rg.reason,
      validation: ticket.validation,
      ...SAFETY,
    });
    return;
  }

  // 4. Persist the DRAFT row. Status=awaiting_confirmation with pendingStatus
  //    EA_UPGRADE_REQUIRED makes it crystal-clear this is not queued for execution.
  let draftId: number;
  try {
    const [row] = await db.insert(tradeActionRequestsTable).values({
      userId,
      actionType: "OPEN",
      requestedMode: body.requestedMode,
      accountType: "unknown",
      routingMode: routing?.effectiveRoutingMode ?? "UNRESOLVED",
      symbol: body.symbol,
      side: directionOf(orderType),
      lotSize: body.lotSize,
      requestedPrice: body.entryPrice ?? body.stopLimitPrice ?? null,
      stopLoss: body.stopLoss ?? null,
      takeProfit: body.takeProfit ?? null,
      orderType,
      stopTriggerPrice: body.stopTriggerPrice ?? null,
      stopLimitPrice: body.stopLimitPrice ?? null,
      expiration: body.expiration ? new Date(body.expiration) : null,
      pendingStatus: "EA_UPGRADE_REQUIRED",
      reason: body.reason ?? null,
      source: "user_initiated",
      status: "awaiting_confirmation",
      confirmationRequired: true,
      confirmedByUser: false,
      guardResult: {
        passed: true,
        failedCheckId: null,
        rejectionReason: null,
        checks: [
          { id: ticket.checkId, name: "Trade ticket validation", passed: true, detail: `RR=${ticket.validation.riskReward ?? "n/a"}` },
          { id: rg.checkId, name: "Risk governor (preview)", passed: true },
        ],
      },
    }).returning({ id: tradeActionRequestsTable.id });
    draftId = row.id;
  } catch (e) {
    req.log?.error?.({ err: (e as Error).message, userId }, "pending-order-draft insert failed");
    res.status(500).json({ ok: false, error: "draft_persist_failed", ...SAFETY });
    return;
  }

  res.status(200).json({
    ok: true,
    draftId,
    executable: false,
    pendingStatus: "EA_UPGRADE_REQUIRED",
    reason: "Pending order saved as a validated draft. The MT5 EA does not yet support pending-order execution; this draft will NOT be sent to the broker until the EA is upgraded.",
    validation: ticket.validation,
    ...SAFETY,
  });
});

// ── GET /me/pending-order-drafts ────────────────────────────────────────────
router.get("/me/pending-order-drafts", async (req, res): Promise<void> => {
  const userId = userIdOf(req);
  if (!userId) { res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY }); return; }

  try {
    const rows = await db.select().from(tradeActionRequestsTable)
      .where(and(
        eq(tradeActionRequestsTable.userId, userId),
        isNotNull(tradeActionRequestsTable.pendingStatus),
      ))
      .orderBy(desc(tradeActionRequestsTable.createdAt))
      .limit(50);

    res.status(200).json({
      ok: true,
      drafts: rows.map((r) => ({
        id: r.id,
        orderType: r.orderType,
        symbol: r.symbol,
        side: r.side,
        lotSize: r.lotSize,
        entryPrice: r.requestedPrice,
        stopTriggerPrice: r.stopTriggerPrice,
        stopLimitPrice: r.stopLimitPrice,
        stopLoss: r.stopLoss,
        takeProfit: r.takeProfit,
        expiration: r.expiration?.toISOString() ?? null,
        pendingStatus: r.pendingStatus,
        status: r.status,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
      ...SAFETY,
    });
  } catch (e) {
    req.log?.error?.({ err: (e as Error).message, userId }, "pending-order-drafts list failed");
    res.status(500).json({ ok: false, error: "drafts_list_failed", ...SAFETY });
  }
});

// ── DELETE /me/pending-order-draft/:id ──────────────────────────────────────
router.delete("/me/pending-order-draft/:id", async (req, res): Promise<void> => {
  const userId = userIdOf(req);
  if (!userId) { res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY }); return; }

  const draftId = Number(req.params.id);
  if (!Number.isFinite(draftId) || draftId <= 0) {
    res.status(400).json({ ok: false, error: "invalid_id", ...SAFETY });
    return;
  }

  try {
    const result = await db.update(tradeActionRequestsTable)
      .set({ pendingStatus: "CANCELLED", status: "cancelled", updatedAt: new Date() })
      .where(and(
        eq(tradeActionRequestsTable.id, draftId),
        eq(tradeActionRequestsTable.userId, userId),
        isNotNull(tradeActionRequestsTable.pendingStatus),
      ))
      .returning({ id: tradeActionRequestsTable.id });

    if (result.length === 0) {
      res.status(404).json({ ok: false, error: "draft_not_found", ...SAFETY });
      return;
    }
    res.status(200).json({ ok: true, cancelledId: draftId, ...SAFETY });
  } catch (e) {
    req.log?.error?.({ err: (e as Error).message, userId, draftId }, "pending-order-draft cancel failed");
    res.status(500).json({ ok: false, error: "draft_cancel_failed", ...SAFETY });
  }
});

// ── GET /me/bridge-capabilities ─────────────────────────────────────────────
// Phase TU. Per-user. Surfaces the capability disclosure most recently
// reported by the EA on heartbeat, plus the resolved "is this bridge able
// to take a pending order today" answer. Read-only; never enables anything.
router.get("/me/bridge-capabilities", async (req, res): Promise<void> => {
  const userId = userIdOf(req);
  if (!userId) { res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY }); return; }

  try {
    const rows = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId)).limit(1);
    const conn = rows[0] ?? null;
    const caps = normaliseCapabilities(conn?.capabilities);
    const lastHb = conn?.lastHeartbeat ? new Date(conn.lastHeartbeat) : null;
    const bridgeConnected = !!lastHb && (Date.now() - lastHb.getTime() < 90_000);
    // Honest "what would the submit endpoint say right now" probe.
    const probe = resolvePendingSubmitStatus({
      capabilities: caps,
      bridgeConnected,
      needsStopLimit: false,
      paperOnlyLock: true,                  // Phase 12 invariant
      liveLocked: SAFETY.liveLocked,
      readOnlyMode: SAFETY.readOnlyMode,
      allowOrderExecution: SAFETY.allowOrderExecution,
    });
    const rawCaps = (conn?.capabilities ?? null) as Record<string, unknown> | null;
    const bridgeVersion = (rawCaps && typeof rawCaps.bridgeVersion === "string") ? rawCaps.bridgeVersion : null;
    res.status(200).json({
      ok: true,
      bridgeConnected,
      lastHeartbeatAt: lastHb?.toISOString() ?? null,
      capabilitiesReportedAt: conn?.capabilitiesReportedAt?.toISOString() ?? null,
      eaVersion: conn?.eaVersion ?? null,
      bridgeVersion,
      capabilities: caps,
      pendingOrderExecutable: probe === "QUEUED",
      currentSubmitStatus: probe,
      currentSubmitExplanation: explainStatus(probe),
      ...SAFETY,
    });
  } catch (e) {
    req.log?.error?.({ err: (e as Error).message, userId }, "bridge-capabilities read failed");
    res.status(500).json({ ok: false, error: "bridge_capabilities_failed", ...SAFETY });
  }
});

// ── POST /me/pending-order-draft/:id/submit ─────────────────────────────────
// Phase TU. Attempt to "submit" a previously-saved pending-order draft for
// broker execution. Today this NEVER enqueues — it resolves an honest
// pendingStatus describing exactly why the draft cannot leave the system
// (BRIDGE_DISCONNECTED / BRIDGE_UNSUPPORTED / BLOCKED_BY_PAPER_LOCK / ...).
// The draft row's pendingStatus column is updated to reflect the new state
// so the UI + AI assistant can show a truthful reason.
//
// SAFETY:
//   * Per-user-scoped. Cannot operate on another user's draft.
//   * NEVER calls queueMt5CommandWithGate. NEVER touches mt5_commands.
//   * NEVER returns executable:true today. Reserved for future once the
//     paper-only lock is lifted (separate, deliberate work).
router.post("/me/pending-order-draft/:id/submit", async (req, res): Promise<void> => {
  const userId = userIdOf(req);
  if (!userId) { res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY }); return; }

  const draftId = Number(req.params.id);
  if (!Number.isFinite(draftId) || draftId <= 0) {
    res.status(400).json({ ok: false, error: "invalid_id", ...SAFETY });
    return;
  }

  try {
    const draftRows = await db.select().from(tradeActionRequestsTable)
      .where(and(
        eq(tradeActionRequestsTable.id, draftId),
        eq(tradeActionRequestsTable.userId, userId),
        isNotNull(tradeActionRequestsTable.pendingStatus),
      )).limit(1);
    const draft = draftRows[0] ?? null;
    if (!draft) {
      res.status(404).json({ ok: false, error: "draft_not_found", ...SAFETY });
      return;
    }
    if (draft.status === "cancelled") {
      res.status(409).json({ ok: false, error: "draft_cancelled", ...SAFETY });
      return;
    }

    const connRows = await db.select().from(mt5ConnectionTable)
      .where(eq(mt5ConnectionTable.userId, userId)).limit(1);
    const conn = connRows[0] ?? null;
    const caps = normaliseCapabilities(conn?.capabilities);
    const lastHb = conn?.lastHeartbeat ? new Date(conn.lastHeartbeat) : null;
    const bridgeConnected = !!lastHb && (Date.now() - lastHb.getTime() < 90_000);
    const needsStopLimit =
      draft.orderType === "BUY_STOP_LIMIT" || draft.orderType === "SELL_STOP_LIMIT";

    const status: PendingSubmitStatus = resolvePendingSubmitStatus({
      capabilities: caps,
      bridgeConnected,
      needsStopLimit,
      paperOnlyLock: true,                  // Phase 12 invariant — never bent here
      liveLocked: SAFETY.liveLocked,
      readOnlyMode: SAFETY.readOnlyMode,
      allowOrderExecution: SAFETY.allowOrderExecution,
    });

    // Phase TV forward-wired branch. ONLY reachable if every safety gate
    // opens — under today's paper-only lock `status` is never "QUEUED".
    // Even if it were, queueMt5CommandWithGate force-stamps BLOCKED, so the
    // EA poll cannot pick it up. Defense in depth + future-ready.
    if (status === "QUEUED") {
      const confirmedByUser = (req.body && (req.body as Record<string, unknown>).confirmedByUser) === true;
      if (!confirmedByUser) {
        res.status(400).json({
          ok: false, executable: false, error: "confirmation_required",
          reason: "Pending-order submit requires confirmedByUser:true in the body.",
          ...SAFETY,
        });
        return;
      }
      const queued = await queueMt5CommandWithGate("PLACE_PENDING_ORDER", {
        symbol: draft.symbol,
        side: draft.side,
        lot: draft.lotSize,
        sl: draft.stopLoss,
        tp: draft.takeProfit,
        pendingPayload: {
          orderType: draft.orderType,
          entryPrice: draft.requestedPrice,
          stopTriggerPrice: draft.stopTriggerPrice,
          stopLimitPrice: draft.stopLimitPrice,
          expiration: draft.expiration?.toISOString() ?? null,
          confirmedByUser: true,
        },
      }, userId);

      // queueMt5CommandWithGate currently force-stamps BLOCKED. Treat anything
      // other than literal "PENDING" as a paper-lock outcome — never claim QUEUED.
      const isReallyQueued = queued.command.status === "PENDING";
      const finalPendingStatus = isReallyQueued ? "QUEUED" : "BLOCKED_BY_PAPER_LOCK";

      await db.update(tradeActionRequestsTable).set({
        pendingStatus: finalPendingStatus,
        tradeCommandId: queued.command.id,
        confirmedByUser: true,
        status: isReallyQueued ? "queued" : draft.status,
        reason: isReallyQueued
          ? "Queued to MT5 command bus; awaiting EA pickup."
          : (queued.command.detail ?? explainStatus("BLOCKED_BY_PAPER_LOCK")),
        updatedAt: new Date(),
      }).where(and(
        eq(tradeActionRequestsTable.id, draftId),
        eq(tradeActionRequestsTable.userId, userId),
      ));

      res.status(200).json({
        ok: true,
        draftId,
        executable: isReallyQueued,
        pendingStatus: finalPendingStatus,
        tradeCommandId: queued.command.id,
        reason: isReallyQueued
          ? "Command queued. PLACED status is only set once MT5 returns a real ticket."
          : (queued.command.detail ?? explainStatus("BLOCKED_BY_PAPER_LOCK")),
        bridgeConnected, eaVersion: conn?.eaVersion ?? null, capabilities: caps,
        ...SAFETY,
      });
      return;
    }

    // Honest non-QUEUED branch. Scope UPDATE by both id AND userId.
    await db.update(tradeActionRequestsTable).set({
      pendingStatus: status,
      reason: explainStatus(status),
      updatedAt: new Date(),
    }).where(and(
      eq(tradeActionRequestsTable.id, draftId),
      eq(tradeActionRequestsTable.userId, userId),
    ));

    res.status(200).json({
      ok: true,
      draftId,
      executable: false,                    // ALWAYS false today by construction
      pendingStatus: status,
      reason: explainStatus(status),
      bridgeConnected,
      eaVersion: conn?.eaVersion ?? null,
      capabilities: caps,
      ...SAFETY,
    });
  } catch (e) {
    req.log?.error?.({ err: (e as Error).message, userId, draftId }, "pending-order-draft submit failed");
    res.status(500).json({ ok: false, error: "draft_submit_failed", ...SAFETY });
  }
});

// ── POST /me/pending-order-draft/:id/cancel-via-bridge ──────────────────────
// Phase TV. Forward-wired CANCEL_PENDING_ORDER. Only meaningful when the
// draft has been PLACED on MT5 (has mt5OrderTicket). Today the gate force-
// stamps BLOCKED so the EA never sees this command; the draft pendingStatus
// is set to BLOCKED_BY_PAPER_LOCK. The only path to true CANCELLED is the
// /mt5/command-result write-back AFTER MT5 confirms cancellation.
router.post("/me/pending-order-draft/:id/cancel-via-bridge", async (req, res): Promise<void> => {
  const userId = userIdOf(req);
  if (!userId) { res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY }); return; }
  const draftId = Number(req.params.id);
  if (!Number.isFinite(draftId) || draftId <= 0) {
    res.status(400).json({ ok: false, error: "invalid_id", ...SAFETY }); return;
  }
  const confirmedByUser = (req.body && (req.body as Record<string, unknown>).confirmedByUser) === true;
  if (!confirmedByUser) {
    res.status(400).json({ ok: false, error: "confirmation_required", reason: "Cancel-via-bridge requires confirmedByUser:true.", ...SAFETY });
    return;
  }
  try {
    const [draft] = await db.select().from(tradeActionRequestsTable)
      .where(and(eq(tradeActionRequestsTable.id, draftId), eq(tradeActionRequestsTable.userId, userId)))
      .limit(1);
    if (!draft) { res.status(404).json({ ok: false, error: "draft_not_found", ...SAFETY }); return; }
    if (!draft.mt5OrderTicket) {
      res.status(409).json({ ok: false, error: "no_mt5_ticket", reason: "Draft was never PLACED on MT5; nothing to cancel at the broker. Use DELETE /me/pending-order-draft/:id to soft-cancel the draft itself.", ...SAFETY });
      return;
    }
    const queued = await queueMt5CommandWithGate("CANCEL_PENDING_ORDER", {
      symbol: draft.symbol,
      pendingPayload: { mt5OrderTicket: draft.mt5OrderTicket, confirmedByUser: true },
    }, userId);
    const isReallyQueued = queued.command.status === "PENDING";
    const nextStatus = isReallyQueued ? "CANCEL_QUEUED" : "BLOCKED_BY_PAPER_LOCK";
    await db.update(tradeActionRequestsTable).set({
      pendingStatus: nextStatus,
      tradeCommandId: queued.command.id,
      reason: isReallyQueued ? "Cancel queued; final CANCELLED set on MT5 confirmation." : (queued.command.detail ?? explainStatus("BLOCKED_BY_PAPER_LOCK")),
      updatedAt: new Date(),
    }).where(and(eq(tradeActionRequestsTable.id, draftId), eq(tradeActionRequestsTable.userId, userId)));
    res.status(200).json({
      ok: true, draftId, executable: isReallyQueued, pendingStatus: nextStatus,
      tradeCommandId: queued.command.id, ...SAFETY,
    });
  } catch (e) {
    req.log?.error?.({ err: (e as Error).message, userId, draftId }, "cancel-via-bridge failed");
    res.status(500).json({ ok: false, error: "cancel_via_bridge_failed", ...SAFETY });
  }
});

// ── POST /me/positions/:positionTicket/modify-protection ────────────────────
// Phase TV. Forward-wired MODIFY_POSITION_PROTECTION (SL/TP on an OPEN
// position). Per-user scoped via queueMt5CommandWithGate userId. The EA
// only sees commands targeted at its own connection (per-user MT5 token),
// so cross-user mutation is impossible. Today blocked by paper-only lock.
const ModifyProtectionSchema = z.object({
  symbol: z.string().min(1).max(20),
  stopLoss: z.number().nullable().optional(),
  takeProfit: z.number().nullable().optional(),
  confirmedByUser: z.literal(true),
});
router.post("/me/positions/:positionTicket/modify-protection", async (req, res): Promise<void> => {
  const userId = userIdOf(req);
  if (!userId) { res.status(401).json({ ok: false, error: "unauthorized", ...SAFETY }); return; }
  const positionTicket = String(req.params.positionTicket);
  if (!positionTicket || positionTicket === "0") {
    res.status(400).json({ ok: false, error: "invalid_ticket", ...SAFETY }); return;
  }
  const parsed = ModifyProtectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "invalid_payload", details: parsed.error.issues, ...SAFETY });
    return;
  }
  if (parsed.data.stopLoss == null && parsed.data.takeProfit == null) {
    res.status(400).json({ ok: false, error: "nothing_to_modify", reason: "Provide at least one of stopLoss / takeProfit.", ...SAFETY });
    return;
  }
  try {
    const queued = await queueMt5CommandWithGate("MODIFY_POSITION_PROTECTION", {
      symbol: parsed.data.symbol,
      sl: parsed.data.stopLoss ?? null,
      tp: parsed.data.takeProfit ?? null,
      pendingPayload: {
        mt5PositionTicket: positionTicket,
        stopLoss: parsed.data.stopLoss ?? null,
        takeProfit: parsed.data.takeProfit ?? null,
        confirmedByUser: true,
      },
    }, userId);
    const isReallyQueued = queued.command.status === "PENDING";
    res.status(200).json({
      ok: true,
      positionTicket,
      executable: isReallyQueued,
      tradeCommandId: queued.command.id,
      commandStatus: queued.command.status,
      reason: isReallyQueued
        ? "Protection-modify queued; broker confirmation will mark MODIFIED."
        : (queued.command.detail ?? "Paper-only lock in force; command stored as BLOCKED and will not reach the EA."),
      ...SAFETY,
    });
  } catch (e) {
    req.log?.error?.({ err: (e as Error).message, userId, positionTicket }, "modify-position-protection failed");
    res.status(500).json({ ok: false, error: "modify_protection_failed", ...SAFETY });
  }
});

export default router;
