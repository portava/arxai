// Phase 3 — Master order placement entry point.
//
// SAFETY: This is the SOLE supported path for trade placement. Routes,
// assistant tools, and admin tools all call placeOrder() and nothing
// else. placeOrder() always runs runOrderGuards() first; only an APPROVED
// status is allowed to reach dispatchToBroker(). Both legs write to the
// audit log; the broker dispatch leg writes back the queued command id
// onto the same audit row.
//
// Convenience aliases `placeDemoOrderGuarded` and `placeLiveOrderGuarded`
// preserve the canonical Build TT naming and make grep-audits easy.

import { runOrderGuards, type OrderRequest } from "./orderGuard.js";
import { dispatchToBroker, type BrokerPlacementResult } from "./brokerPlacement.js";
import { db } from "@workspace/db";
import { tradeCommandAuditLogTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { evaluateAiActionBoundary } from "@workspace/domain/security";
import { recordSecurityEvent } from "../security/events.js";
import type { SimulatedOpenReceipt } from "../tradeEngine/simulatedOpen.js";

export interface PlaceOrderInput {
  userId: number;
  mode: "SIMULATED" | "DEMO" | "LIVE";
  symbol: string;
  side: "BUY" | "SELL";
  lotSize: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  requestedBy: "user" | "ai-assistant" | "system";
  confirmedByUser: boolean;
  /**
   * SIMULATED only (owner decision 13): the caller's retry-safe request key.
   * A SIMULATED order that passes every guard books ONE PAPER order through
   * the Trade Engine pipeline under this key; without a key it is refused.
   */
  simulatedRequestKey?: string | null;
}

export interface PlaceOrderResult {
  status: "QUEUED" | "SIMULATED_FILL" | "REJECTED" | "DUPLICATE_BLOCKED" | "NO_CONNECTION" | "ERROR";
  mode: PlaceOrderInput["mode"];
  reason: string;
  auditLogId: number;
  commandId: number | null;
  idempotencyKey: string | null;
  expiresAt: string | null;
  /** SIMULATED: the PAPER order booked (or replayed) for this request (owner decision 13). */
  paper?: SimulatedOpenReceipt | null;
  /** A human-readable refusal, when one exists. */
  message?: string;
}

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  // ── AI action boundary ───────────────────────────────────────────────────
  // No AI surface may directly execute a trade. Ruby (the read-only assistant)
  // is a read-only actor and is ALWAYS blocked here, before any guard runs. This
  // is additive: it only ever ADDS a refusal and never relaxes a downstream gate.
  if (input.requestedBy === "ai-assistant") {
    const boundary = evaluateAiActionBoundary({
      actorKind: "ruby",
      action: input.mode === "LIVE" ? "LIVE_TRADE_EXECUTION" : "SELF_TRADE_EXECUTION",
      intentCreated: false,
      permissionChecked: false,
      handshakePassed: false,
      auditWritten: false,
      viaApprovedRoute: false,
    });
    if (!boundary.allowed) {
      await recordSecurityEvent({
        eventType: "AI_DIRECT_EXECUTION_BLOCKED",
        severity: "CRITICAL",
        status: "DENIED",
        actorRole: null,
        actorUserId: input.userId,
        permissionKey: "trade:place",
        message: `AI-initiated trade placement blocked: ${boundary.blockCode}`,
        metadata: {
          userId: input.userId,
          mode: input.mode,
          symbol: input.symbol,
          blockCode: boundary.blockCode,
          missing: boundary.missing,
        },
      }).catch(() => {});
      return {
        status: "REJECTED",
        mode: input.mode,
        reason: `AI_DIRECT_EXECUTION_BLOCKED:${boundary.blockCode}`,
        auditLogId: -1,
        commandId: null,
        idempotencyKey: null,
        expiresAt: null,
      };
    }
  }

  const orderReq: OrderRequest = {
    userId: input.userId,
    symbol: input.symbol,
    side: input.side,
    lotSize: input.lotSize,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,
    requestedBy: input.requestedBy,
    confirmedByUser: input.confirmedByUser,
    mode: input.mode,
  };

  const guard = await runOrderGuards(orderReq);

  if (guard.status !== "APPROVED") {
    return {
      status: "REJECTED",
      mode: input.mode,
      reason: guard.reason,
      auditLogId: guard.auditLogId,
      commandId: null,
      idempotencyKey: null,
      expiresAt: null,
    };
  }

  // SIMULATED (owner decision 13): every guard above passed, so the order is
  // booked as ONE PAPER order through the Trade Engine pipeline (Risk
  // Governor venue PAPER, a real current quote, idempotent on the caller's
  // request key) instead of an internal fill that recorded nothing.
  if (input.mode === "SIMULATED") {
    const { openSimulatedPaperOrder } = await import("../tradeEngine/simulatedOpen.js");
    const sim = await openSimulatedPaperOrder({
      userId: input.userId, surface: "MY_TRADES", requestKey: input.simulatedRequestKey ?? "",
      symbol: input.symbol, side: input.side, lots: input.lotSize,
      stopLoss: input.stopLoss ?? null, takeProfit: input.takeProfit ?? null,
      origin: input.requestedBy === "system" ? "automation" : "manual",
      sourcePage: "ME_TRADES_SIMULATED_OPEN",
    });
    await db.update(tradeCommandAuditLogTable)
      .set({
        status: sim.ok ? "EXECUTED" : "FAILED",
        rejectionReason: sim.ok ? null : `SIMULATED_PAPER_REFUSED:${sim.reason}`,
        guardSnapshot: sql`coalesce(${tradeCommandAuditLogTable.guardSnapshot}, '{}'::jsonb)
          || ${JSON.stringify({ placement: sim.ok
            ? { status: "SIMULATED_FILL", venue: "PAPER", paperOrderId: sim.receipt.paperOrderId, fillPrice: sim.receipt.fillPrice, priceSource: sim.receipt.priceSource, quoteAt: sim.receipt.quoteAt, replayed: sim.receipt.replayed }
            : { status: "REJECTED", venue: "PAPER", reason: sim.reason } })}::jsonb`,
      })
      .where(eq(tradeCommandAuditLogTable.id, guard.auditLogId));
    return sim.ok
      ? { status: "SIMULATED_FILL", mode: input.mode, reason: `PAPER_ORDER:${sim.receipt.paperOrderId}`, auditLogId: guard.auditLogId,
          commandId: null, idempotencyKey: input.simulatedRequestKey ?? null, expiresAt: null, paper: sim.receipt }
      : { status: "REJECTED", mode: input.mode, reason: sim.reason, message: sim.message, auditLogId: guard.auditLogId,
          commandId: null, idempotencyKey: input.simulatedRequestKey ?? null, expiresAt: null, paper: null };
  }

  let placement: BrokerPlacementResult;
  try {
    placement = await dispatchToBroker({
      userId: input.userId,
      mode: input.mode,
      symbol: input.symbol,
      side: input.side,
      lotSize: input.lotSize,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      auditLogId: guard.auditLogId,
      requestedBy: input.requestedBy,
      routing: guard.routing,
    });
  } catch (err) {
    await db.update(tradeCommandAuditLogTable)
      .set({ status: "FAILED", rejectionReason: `DISPATCH_THREW:${String(err).slice(0, 200)}` })
      .where(eq(tradeCommandAuditLogTable.id, guard.auditLogId));
    return {
      status: "ERROR", mode: input.mode, reason: "DISPATCH_THREW",
      auditLogId: guard.auditLogId, commandId: null, idempotencyKey: null, expiresAt: null,
    };
  }

  // Update audit row with final placement status.
  const finalStatus: "EXECUTED" | "FAILED" =
    placement.status === "QUEUED" || placement.status === "SIMULATED_FILL" ? "EXECUTED" : "FAILED";
  await db.update(tradeCommandAuditLogTable)
    .set({
      status: finalStatus,
      rejectionReason: placement.status === "DUPLICATE_BLOCKED" || placement.status === "NO_CONNECTION" || placement.status === "ERROR"
        ? placement.status : null,
      guardSnapshot: sql`coalesce(${tradeCommandAuditLogTable.guardSnapshot}, '{}'::jsonb)
        || ${JSON.stringify({ placement: { status: placement.status, commandId: placement.commandId, expiresAt: placement.expiresAt } })}::jsonb`,
    })
    .where(eq(tradeCommandAuditLogTable.id, guard.auditLogId));

  return {
    status: placement.status === "QUEUED" ? "QUEUED" :
            placement.status === "SIMULATED_FILL" ? "SIMULATED_FILL" :
            placement.status === "DUPLICATE_BLOCKED" ? "DUPLICATE_BLOCKED" :
            placement.status === "NO_CONNECTION" ? "NO_CONNECTION" : "ERROR",
    mode: input.mode,
    reason: placement.detail ?? placement.status,
    auditLogId: guard.auditLogId,
    commandId: placement.commandId,
    idempotencyKey: placement.idempotencyKey,
    expiresAt: placement.expiresAt,
  };
}

// Canonical Build TT naming — these are the documented entry points.
export const placeDemoOrderGuarded = (input: Omit<PlaceOrderInput, "mode">) =>
  placeOrder({ ...input, mode: "DEMO" });
export const placeLiveOrderGuarded = (input: Omit<PlaceOrderInput, "mode">) =>
  placeOrder({ ...input, mode: "LIVE" });
