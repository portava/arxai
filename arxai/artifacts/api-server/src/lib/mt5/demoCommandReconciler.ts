// ARX AI — Demo command reconciler (sub-phase 3B; pending orders v1.32).
//
// Phase 28-MT5-DEMO-ARMING (May 2026).
//
// Applies the broker result the EA reports via the per-user write-back
// endpoint: SENT_TO_MT5_DEMO → FILLED_DEMO / PLACED_DEMO / CANCELLED_DEMO /
// REJECTED / FAILED. Persists `brokerOrderId`, `brokerTicket`, `fillPrice`,
// `fillVolume`, and the raw broker result blob for the audit trail.
//
// SAFETY:
//   - Only commands owned by `userId` AND sent to `bridgeConnectionId` (the
//     reporting EA's connection) are reachable; anything else is NOT_FOUND.
//   - The result status must fit the command type (decideDemoReconcile).
//   - Refuses unless current status === SENT_TO_MT5_DEMO, except a broker
//     SUCCESS for a row the expiry sweep FAILED: the EA had already executed,
//     so the fill/placement is recorded and flagged (lateAfterExpiry) instead
//     of leaving a real position orphaned behind a 409.
//   - Uses conditional UPDATE so a duplicate write-back cannot transition
//     twice. Idempotent on re-deliveries of the same final state.
//   - PLACED_DEMO is not a fill: no fillPrice / fillVolume / filledAt, no
//     terminalAt. The order price and volume are kept in brokerRawResult.
//   - CANCELLED_DEMO on a CANCEL_PENDING_ORDER also moves the trader's
//     PLACED_DEMO entry row for that order ticket to CANCELLED_DEMO.
//   - No password, no token, no apiKeyHash is read or written.

import { and, eq } from "drizzle-orm";
import { db, mt5DemoCommandsTable, type Mt5DemoCommand } from "@workspace/db";
import {
  buildSafetyGateSnapshot,
  type DemoBrokerResultStatus,
} from "@workspace/domain/safety-contracts/executionMode";
import { recordSecurityEvent } from "../security/events.js";
import { decideDemoReconcile } from "./demoBridgeContract.js";

export type BrokerReportedStatus = DemoBrokerResultStatus;

export interface BrokerResultReport {
  status: BrokerReportedStatus;
  brokerOrderId?: string | null;
  brokerTicket?: string | null;
  filledPrice?: number | null;
  filledVolume?: number | null;
  filledAt?: string | null;
  reason?: string | null;
  /** EA-reported version at execution time (for audit). */
  reportedEaVersion?: string | null;
  /** Whole broker result blob (best-effort). Server stores up to ~4KB. */
  raw?: Record<string, unknown> | null;
}

export interface ReconcileArgs {
  userId: number;
  /** The reporting EA's bridge connection. Required from the EA route; a
   *  report from any other bridge is NOT_FOUND. */
  bridgeConnectionId?: number | null;
  commandId: string;
  brokerResult: BrokerResultReport;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}

export interface ReconcileResult {
  ok: boolean;
  reason: string;
  command?: Mt5DemoCommand;
}

async function loadOwned(userId: number, commandId: string): Promise<Mt5DemoCommand | null> {
  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(and(eq(mt5DemoCommandsTable.userId, userId), eq(mt5DemoCommandsTable.commandId, commandId)))
    .limit(1);
  return rows[0] ?? null;
}

function clampRaw(raw: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip obvious secret-shaped keys defensively.
  const banned = /password|secret|token|apikeyhash|api_key_hash|session/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (banned.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function reconcileBrokerResult(args: ReconcileArgs): Promise<ReconcileResult> {
  const row = await loadOwned(args.userId, args.commandId);
  const decision = decideDemoReconcile(row, args.brokerResult.status, args.bridgeConnectionId ?? null);
  if (decision.kind === "NOT_FOUND" || !row) {
    if (row) {
      try {
        await recordSecurityEvent({
          eventType: "DEMO_RECONCILE_REFUSED",
          severity: "HIGH",
          status: "DENIED",
          actorUserId: args.userId,
          route: `/internal/demoCommandReconciler/${args.commandId}`,
          method: "INTERNAL",
          ipAddress: args.actorIp ?? null,
          userAgent: args.actorUserAgent ?? null,
          message: "Reconcile refused: result reported by a bridge the command was not sent to.",
          metadata: {
            commandId: args.commandId,
            commandBridgeConnectionId: row.bridgeConnectionId,
            reportingBridgeConnectionId: args.bridgeConnectionId ?? null,
            brokerReportedStatus: args.brokerResult.status,
            result: "REFUSED",
            reason: "BRIDGE_CONNECTION_MISMATCH",
          },
        });
      } catch { /* non-fatal */ }
    }
    return { ok: false, reason: "COMMAND_NOT_FOUND" };
  }

  // Idempotent: already in the requested state (re-delivery from EA).
  if (decision.kind === "IDEMPOTENT") {
    return { ok: true, reason: "ALREADY_RECONCILED", command: row };
  }

  if (decision.kind === "REFUSE") {
    try {
      await recordSecurityEvent({
        eventType: "DEMO_RECONCILE_REFUSED",
        severity: "WARNING",
        status: "DENIED",
        actorUserId: args.userId,
        route: `/internal/demoCommandReconciler/${args.commandId}`,
        method: "INTERNAL",
        ipAddress: args.actorIp ?? null,
        userAgent: args.actorUserAgent ?? null,
        message: `Reconcile refused: ${decision.reason}.`,
        metadata: {
          commandId: args.commandId,
          commandType: row.commandType,
          bridgeConnectionId: row.bridgeConnectionId,
          currentStatus: row.status,
          brokerReportedStatus: args.brokerResult.status,
          result: "REFUSED",
          reason: decision.reason.startsWith("WRONG_STATE") ? "WRONG_STATE" : decision.reason,
          safetyGateSnapshot: row.safetyGateSnapshot,
        },
      });
    } catch { /* non-fatal */ }
    return { ok: false, reason: decision.reason, command: row };
  }

  const status = args.brokerResult.status;
  const late = decision.lateAfterExpiry;
  const now = new Date();
  const filledAt = args.brokerResult.filledAt ? new Date(args.brokerResult.filledAt) : now;
  const terminalSnapshot = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION",
    demoStatus: "VERIFIED_DEMO",
    canArmAllowed: true,
    userArmed: true,
    canDispatchAllowed: false,
  });

  const raw = clampRaw(args.brokerResult.raw ?? null) ?? {};
  if (status === "PLACED_DEMO") {
    // An order resting at the broker, not a fill.
    raw["orderPrice"] = args.brokerResult.filledPrice ?? null;
    raw["orderVolume"] = args.brokerResult.filledVolume ?? null;
  }
  if (late) {
    raw["lateAfterExpiry"] = true;
    raw["expiredReason"] = row.reason;
  }
  const brokerReason = args.brokerResult.reason ?? null;
  const patch: Record<string, unknown> = {
    status,
    reason: late ? `LATE_RESULT_AFTER_EXPIRY:${brokerReason ?? status}`.slice(0, 500) : brokerReason,
    terminalAt: status === "PLACED_DEMO" ? null : now,
    updatedAt: now,
    // A placed pending order's ticket IS the broker order id.
    brokerOrderId: args.brokerResult.brokerOrderId
      ?? (status === "PLACED_DEMO" ? args.brokerResult.brokerTicket ?? null : null),
    brokerTicket: args.brokerResult.brokerTicket ?? null,
    fillPrice: status === "PLACED_DEMO" ? null : args.brokerResult.filledPrice ?? null,
    fillVolume: status === "PLACED_DEMO" ? null : args.brokerResult.filledVolume ?? null,
    brokerRawResult: Object.keys(raw).length > 0 ? raw : null,
    safetyGateSnapshot: terminalSnapshot,
  };
  if (status === "FILLED_DEMO") {
    patch.filledAt = filledAt;
  }

  const [updated] = await db
    .update(mt5DemoCommandsTable)
    .set(patch)
    .where(
      and(
        eq(mt5DemoCommandsTable.id, row.id),
        eq(mt5DemoCommandsTable.status, decision.expectedStatus),
      ),
    )
    .returning();

  if (!updated) {
    return { ok: false, reason: "RACE_LOST", command: row };
  }

  // A confirmed cancel retires the entry row that placed the order.
  let cancelledPlaceCommandId: string | null = null;
  if (status === "CANCELLED_DEMO" && row.commandType === "CANCEL_PENDING_ORDER") {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const ticket = String(p["orderTicket"] ?? p["ticket"] ?? "");
    if (ticket) {
      const [placed] = await db
        .update(mt5DemoCommandsTable)
        .set({ status: "CANCELLED_DEMO", reason: `CANCELLED_BY:${row.commandId}`, terminalAt: now, updatedAt: now })
        .where(and(
          eq(mt5DemoCommandsTable.userId, args.userId),
          eq(mt5DemoCommandsTable.brokerTicket, ticket),
          eq(mt5DemoCommandsTable.commandType, "PLACE_PENDING_ORDER"),
          eq(mt5DemoCommandsTable.status, "PLACED_DEMO"),
        ))
        .returning();
      cancelledPlaceCommandId = placed?.commandId ?? null;
    }
  }

  const success = status === "FILLED_DEMO" || status === "PLACED_DEMO" || status === "CANCELLED_DEMO";
  try {
    await recordSecurityEvent({
      eventType: late
        ? "DEMO_COMMAND_LATE_RESULT_AFTER_EXPIRY"
        : status === "FILLED_DEMO"
          ? "DEMO_COMMAND_FILLED"
          : status === "PLACED_DEMO"
            ? "DEMO_PENDING_ORDER_PLACED"
            : status === "CANCELLED_DEMO"
              ? "DEMO_PENDING_ORDER_CANCELLED"
              : status === "REJECTED"
                ? "DEMO_COMMAND_BROKER_REJECTED"
                : "DEMO_COMMAND_BROKER_FAILED",
      severity: late ? "HIGH" : success ? "INFO" : "WARNING",
      status: success ? "ALLOWED" : "DENIED",
      actorUserId: args.userId,
      route: `/internal/demoCommandReconciler/${args.commandId}`,
      method: "INTERNAL",
      ipAddress: args.actorIp ?? null,
      userAgent: args.actorUserAgent ?? null,
      message: late
        ? `Demo broker ${status} arrived after the expiry sweep FAILED the command; recorded and flagged.`
        : `Demo broker result reconciled: ${status}.`,
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        brokerOrderId: args.brokerResult.brokerOrderId ?? null,
        brokerTicket: args.brokerResult.brokerTicket ?? null,
        fillPrice: args.brokerResult.filledPrice ?? null,
        fillVolume: args.brokerResult.filledVolume ?? null,
        reportedEaVersion: args.brokerResult.reportedEaVersion ?? null,
        lateAfterExpiry: late,
        cancelledPlaceCommandId,
        result: status,
        reason: args.brokerResult.reason ?? null,
        safetyGateSnapshot: terminalSnapshot,
      },
    });
  } catch { /* non-fatal */ }

  return { ok: true, reason: late ? `LATE_${status}` : status, command: updated };
}
