// ARX AI — Demo command reconciler (sub-phase 3B).
//
// Phase 28-MT5-DEMO-ARMING (May 2026).
//
// Transitions a SENT_TO_MT5_DEMO row to FILLED_DEMO / REJECTED / FAILED
// based on the broker result reported by the EA via the per-user write-back
// endpoint. Persists `brokerOrderId`, `brokerTicket`, `fillPrice`,
// `fillVolume`, and the raw broker result blob for the audit trail.
//
// SAFETY:
//   - Only commands owned by `userId` are reachable.
//   - Refuses unless current status === SENT_TO_MT5_DEMO. Already-terminal
//     rows are NEVER mutated.
//   - Uses conditional UPDATE so a duplicate write-back cannot transition
//     twice. Idempotent on re-deliveries of the same final state.
//   - No password, no token, no apiKeyHash is read or written.

import { and, eq } from "drizzle-orm";
import { db, mt5DemoCommandsTable, type Mt5DemoCommand } from "@workspace/db";
import { buildSafetyGateSnapshot } from "@workspace/domain/safety-contracts/executionMode";
import { recordSecurityEvent } from "../security/events.js";

export type BrokerReportedStatus = "FILLED_DEMO" | "REJECTED" | "FAILED";

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
  if (!row) return { ok: false, reason: "COMMAND_NOT_FOUND" };

  // Idempotent: if already terminal in the requested target state, treat
  // as success (re-delivery from EA).
  if (row.status === args.brokerResult.status) {
    return { ok: true, reason: "ALREADY_RECONCILED", command: row };
  }

  if (row.status !== "SENT_TO_MT5_DEMO") {
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
        message: `Reconcile refused: command is not in SENT_TO_MT5_DEMO (state=${row.status}).`,
        metadata: {
          commandId: args.commandId,
          commandType: row.commandType,
          bridgeConnectionId: row.bridgeConnectionId,
          currentStatus: row.status,
          brokerReportedStatus: args.brokerResult.status,
          result: "REFUSED",
          reason: "WRONG_STATE",
          safetyGateSnapshot: row.safetyGateSnapshot,
        },
      });
    } catch { /* non-fatal */ }
    return { ok: false, reason: `WRONG_STATE:${row.status}`, command: row };
  }

  const now = new Date();
  const filledAt = args.brokerResult.filledAt ? new Date(args.brokerResult.filledAt) : now;
  const terminalSnapshot = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION",
    demoStatus: "VERIFIED_DEMO",
    canArmAllowed: true,
    userArmed: true,
    canDispatchAllowed: false,
  });

  const patch: Record<string, unknown> = {
    status: args.brokerResult.status,
    reason: args.brokerResult.reason ?? null,
    terminalAt: now,
    updatedAt: now,
    brokerOrderId: args.brokerResult.brokerOrderId ?? null,
    brokerTicket: args.brokerResult.brokerTicket ?? null,
    fillPrice: args.brokerResult.filledPrice ?? null,
    fillVolume: args.brokerResult.filledVolume ?? null,
    brokerRawResult: clampRaw(args.brokerResult.raw ?? null),
    safetyGateSnapshot: terminalSnapshot,
  };
  if (args.brokerResult.status === "FILLED_DEMO") {
    patch.filledAt = filledAt;
  }

  const [updated] = await db
    .update(mt5DemoCommandsTable)
    .set(patch)
    .where(
      and(
        eq(mt5DemoCommandsTable.id, row.id),
        eq(mt5DemoCommandsTable.status, "SENT_TO_MT5_DEMO"),
      ),
    )
    .returning();

  if (!updated) {
    return { ok: false, reason: "RACE_LOST", command: row };
  }

  try {
    await recordSecurityEvent({
      eventType:
        args.brokerResult.status === "FILLED_DEMO"
          ? "DEMO_COMMAND_FILLED"
          : args.brokerResult.status === "REJECTED"
            ? "DEMO_COMMAND_BROKER_REJECTED"
            : "DEMO_COMMAND_BROKER_FAILED",
      severity: args.brokerResult.status === "FILLED_DEMO" ? "INFO" : "WARNING",
      status: args.brokerResult.status === "FILLED_DEMO" ? "ALLOWED" : "DENIED",
      actorUserId: args.userId,
      route: `/internal/demoCommandReconciler/${args.commandId}`,
      method: "INTERNAL",
      ipAddress: args.actorIp ?? null,
      userAgent: args.actorUserAgent ?? null,
      message: `Demo broker result reconciled: ${args.brokerResult.status}.`,
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        brokerOrderId: args.brokerResult.brokerOrderId ?? null,
        brokerTicket: args.brokerResult.brokerTicket ?? null,
        fillPrice: args.brokerResult.filledPrice ?? null,
        fillVolume: args.brokerResult.filledVolume ?? null,
        reportedEaVersion: args.brokerResult.reportedEaVersion ?? null,
        result: args.brokerResult.status,
        reason: args.brokerResult.reason ?? null,
        safetyGateSnapshot: terminalSnapshot,
      },
    });
  } catch { /* non-fatal */ }

  return { ok: true, reason: args.brokerResult.status, command: updated };
}
