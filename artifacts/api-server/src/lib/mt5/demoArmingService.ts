// ARX AI — Demo execution arming service (sub-phase 1).
//
// Phase 28-MT5-DEMO-ARMING (May 2026).
//
// Pure-ish service that mutates `mt5_user_execution_mode` to record a
// user's explicit decision to ARM MT5_DEMO_EXECUTION (or DISARM back to
// MT5_DEMO_READ_ONLY).
//
// SAFETY:
//   - Arming requires `runDemoVerificationGate()` to return VERIFIED_DEMO
//     AND `canArmExecution()` to allow.
//   - Arming alone does NOT permit any command to reach the EA — that is
//     gated independently by `canDispatchToMt5()` which is still refused.
//   - Disarming is always allowed (kill-switch contract). No verification
//     gate is run on disarm.
//   - Every arm/disarm writes a SecurityEvent audit and snapshots the
//     gate result + safety-gate snapshot into the row.
//   - No tokens, no apiKeyHash, no broker passwords are read or written.

import { and, eq } from "drizzle-orm";
import {
  db,
  mt5ConnectionTable,
  mt5UserExecutionModeTable,
  type Mt5UserExecutionMode,
} from "@workspace/db";
import {
  buildSafetyGateSnapshot,
  canArmExecution,
  type ExecutionMode,
  type SafetyGateSnapshot,
} from "@workspace/domain/safety-contracts/executionMode";
import { runDemoVerificationGate, type DemoVerificationResult } from "./demoVerificationGate.js";
import { recordSecurityEvent } from "../security/events.js";
import { getDuplicateEaProbe } from "../../routes/mt5.js";

export interface ArmDecisionResult {
  ok: boolean;
  /** Current mode AFTER the call. */
  mode: ExecutionMode;
  armedAt: string | null;
  disarmedAt: string | null;
  disarmedReason: string | null;
  /** Re-evaluated readiness at the moment of the call. */
  readiness: DemoVerificationResult;
  safetyGateSnapshot: SafetyGateSnapshot;
  /** Failure reason when ok === false. */
  refusalReason?: string;
}

async function loadOrCreateModeRow(userId: number): Promise<Mt5UserExecutionMode> {
  const rows = await db
    .select()
    .from(mt5UserExecutionModeTable)
    .where(eq(mt5UserExecutionModeTable.userId, userId))
    .limit(1);
  if (rows[0]) return rows[0];
  const [created] = await db
    .insert(mt5UserExecutionModeTable)
    .values({ userId, mode: "MT5_DEMO_READ_ONLY" })
    .returning();
  if (!created) {
    throw new Error("failed to create mt5_user_execution_mode row");
  }
  return created;
}

export async function getCurrentArmState(userId: number): Promise<{
  mode: ExecutionMode;
  armedAt: string | null;
  disarmedAt: string | null;
  disarmedReason: string | null;
}> {
  const row = await loadOrCreateModeRow(userId);
  return {
    mode: row.mode as ExecutionMode,
    armedAt: row.armedAt ? new Date(row.armedAt).toISOString() : null,
    disarmedAt: row.disarmedAt ? new Date(row.disarmedAt).toISOString() : null,
    disarmedReason: row.disarmedReason ?? null,
  };
}

/** Arm MT5_DEMO_EXECUTION for the user. Refuses unless VERIFIED_DEMO. */
async function lookupBridgeConnectionId(userId: number): Promise<number | null> {
  const rows = await db
    .select({ id: mt5ConnectionTable.id })
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function armDemoExecution(args: {
  userId: number;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}): Promise<ArmDecisionResult> {
  const bridgeConnectionId = await lookupBridgeConnectionId(args.userId);
  const probe = getDuplicateEaProbe();
  const readiness = await runDemoVerificationGate({
    userId: args.userId,
    duplicateEaProbe: { suspected: probe.suspected, reason: probe.reason ?? null },
  });

  const armDecision = canArmExecution({
    decision: { status: readiness.status, blockers: readiness.blockers },
    inputs: {
      bridgeConnected: readiness.evidence.heartbeatAgeSeconds !== null,
      heartbeatFresh: readiness.evidence.heartbeatAgeSeconds !== null
        && readiness.evidence.heartbeatAgeSeconds <= 15,
      demoVerified: readiness.status === "VERIFIED_DEMO",
      liveLocked: true,
    },
  });

  if (!armDecision.allowed) {
    // Record a denied arm attempt.
    try {
      await recordSecurityEvent({
        eventType: "DEMO_EXECUTION_ARM_DENIED",
        severity: "WARNING",
        status: "DENIED",
        actorUserId: args.userId,
        route: "/api/me/demo-execution/arm",
        method: "POST",
        ipAddress: args.actorIp ?? null,
        userAgent: args.actorUserAgent ?? null,
        message: `Arm denied: ${armDecision.reason}`,
        metadata: {
          readinessStatus: readiness.status,
          blockers: readiness.blockers,
          refusalReason: armDecision.reason,
          safetyGateSnapshot: readiness.safetyGateSnapshot,
          bridgeConnectionId,
          result: "DENIED",
          reason: armDecision.reason,
        },
      });
    } catch { /* non-fatal */ }
    const current = await getCurrentArmState(args.userId);
    return {
      ok: false,
      mode: current.mode,
      armedAt: current.armedAt,
      disarmedAt: current.disarmedAt,
      disarmedReason: current.disarmedReason,
      readiness,
      safetyGateSnapshot: readiness.safetyGateSnapshot,
      refusalReason: armDecision.reason,
    };
  }

  // PASS — flip the row to MT5_DEMO_EXECUTION.
  const armedAt = new Date();
  const safetyGateSnapshot = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION",
    demoStatus: readiness.status,
    canArmAllowed: true,
    userArmed: true,
  });

  await loadOrCreateModeRow(args.userId);
  await db
    .update(mt5UserExecutionModeTable)
    .set({
      mode: "MT5_DEMO_EXECUTION",
      armedAt,
      armedByUserId: args.userId,
      disarmedAt: null,
      disarmedReason: null,
      lastArmGateSnapshot: readiness,
      lastSafetyGateSnapshot: safetyGateSnapshot,
      updatedAt: new Date(),
    })
    .where(eq(mt5UserExecutionModeTable.userId, args.userId));

  try {
    await recordSecurityEvent({
      eventType: "DEMO_EXECUTION_ARMED",
      severity: "HIGH",
      status: "ALLOWED",
      actorUserId: args.userId,
      route: "/api/me/demo-execution/arm",
      method: "POST",
      ipAddress: args.actorIp ?? null,
      userAgent: args.actorUserAgent ?? null,
      message: "User armed MT5_DEMO_EXECUTION. Broker dispatch remains structurally disabled.",
      metadata: {
        readinessStatus: readiness.status,
        accountTypeReported: readiness.evidence.accountTypeReported,
        eaVersion: readiness.evidence.eaVersion,
        canDispatchToMt5: false,
        safetyGateSnapshot,
        bridgeConnectionId,
        result: "ARMED",
        reason: "VERIFIED_DEMO",
      },
    });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    mode: "MT5_DEMO_EXECUTION",
    armedAt: armedAt.toISOString(),
    disarmedAt: null,
    disarmedReason: null,
    readiness,
    safetyGateSnapshot,
  };
}

/** Disarm — kill-switch. Always allowed; no gate required. */
export async function disarmDemoExecution(args: {
  userId: number;
  reason: string;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}): Promise<ArmDecisionResult> {
  const bridgeConnectionId = await lookupBridgeConnectionId(args.userId);
  await loadOrCreateModeRow(args.userId);
  const disarmedAt = new Date();
  const probe = getDuplicateEaProbe();
  const readiness = await runDemoVerificationGate({
    userId: args.userId,
    duplicateEaProbe: { suspected: probe.suspected, reason: probe.reason ?? null },
  });
  const safetyGateSnapshot = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_READ_ONLY",
    demoStatus: readiness.status,
    canArmAllowed: readiness.canArmExecution,
    userArmed: false,
  });
  await db
    .update(mt5UserExecutionModeTable)
    .set({
      mode: "MT5_DEMO_READ_ONLY",
      disarmedAt,
      disarmedReason: args.reason.slice(0, 500),
      lastSafetyGateSnapshot: safetyGateSnapshot,
      updatedAt: new Date(),
    })
    .where(eq(mt5UserExecutionModeTable.userId, args.userId));

  try {
    await recordSecurityEvent({
      eventType: "DEMO_EXECUTION_DISARMED",
      severity: "INFO",
      status: "ALLOWED",
      actorUserId: args.userId,
      route: "/api/me/demo-execution/disarm",
      method: "POST",
      ipAddress: args.actorIp ?? null,
      userAgent: args.actorUserAgent ?? null,
      message: `User disarmed MT5_DEMO_EXECUTION. Reason: ${args.reason}`,
      metadata: {
        reason: args.reason,
        result: "DISARMED",
        safetyGateSnapshot,
        bridgeConnectionId,
      },
    });
  } catch { /* non-fatal */ }

  return {
    ok: true,
    mode: "MT5_DEMO_READ_ONLY",
    armedAt: null,
    disarmedAt: disarmedAt.toISOString(),
    disarmedReason: args.reason,
    readiness,
    safetyGateSnapshot,
  };
}

/** True if the user is currently armed in MT5_DEMO_EXECUTION. */
export async function isArmedForDemo(userId: number): Promise<boolean> {
  const rows = await db
    .select({ mode: mt5UserExecutionModeTable.mode })
    .from(mt5UserExecutionModeTable)
    .where(and(eq(mt5UserExecutionModeTable.userId, userId)))
    .limit(1);
  return rows[0]?.mode === "MT5_DEMO_EXECUTION";
}
