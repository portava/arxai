// ARX AI — Demo command consumer (sub-phase 3B).
//
// Phase 28-MT5-DEMO-ARMING (May 2026).
//
// Single entry point that transitions a DEMO_APPROVED command to
// SENT_TO_MT5_DEMO. The transition is admitted ONLY when every per-user
// gate passes AND `canDispatchToMt5(inputs)` returns allowed AND the EA
// reports a version >= EA_MIN_DEMO_VERSION. The write itself is a
// conditional UPDATE (`WHERE status='DEMO_APPROVED'`) so two concurrent
// consumers cannot both transition the same row, and a partial unique
// index on `(user_id, fingerprint) WHERE status IN ('DEMO_APPROVED',
// 'SENT_TO_MT5_DEMO')` makes duplicate-by-fingerprint a DB error rather
// than an application race.
//
// SAFETY INVARIANTS:
//   1. NEVER writes SENT_TO_MT5_DEMO unless the chokepoint returns allowed.
//   2. NEVER writes SENT_TO_MT5_DEMO for a non-demo account type.
//   3. NEVER writes SENT_TO_MT5_DEMO for an EA below EA_MIN_DEMO_VERSION.
//   4. NEVER touches a command owned by a different user.
//   5. NEVER reads/returns tokens, hashes, or broker passwords.
//   6. EVERY outcome (admitted / refused) writes a SecurityEvent.

import { and, eq } from "drizzle-orm";
import {
  db,
  mt5DemoCommandsTable,
  sharedTradeAttributionTable,
  type Mt5DemoCommand,
} from "@workspace/db";
import {
  buildSafetyGateSnapshot,
  canDispatchToMt5,
  EA_MIN_DEMO_VERSION,
  eaVersionAtLeast,
  type PerUserDispatchInputs,
} from "@workspace/domain/safety-contracts/executionMode";
import { evaluateRoutedDemoDispatchGate } from "./masterBridgeRouting.js";
import { findRecentDuplicate, computeCommandFingerprint } from "./demoDispatchDuplicate.js";
import { recordSecurityEvent } from "../security/events.js";
import { logger } from "../logger.js";

export interface ConsumeArgs {
  userId: number;
  commandId: string;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}

export interface ConsumeResult {
  ok: boolean;
  reason: string;
  stage: "LOAD" | "OWNERSHIP" | "STATE" | "PER_USER_GATE" | "DUPLICATE" | "CHOKEPOINT" | "DISPATCH" | "RECONCILE";
  command?: Mt5DemoCommand;
  perUserBlockers?: string[];
  duplicateMatchedCommandIds?: string[];
  canDispatchToMt5Allowed: boolean;
}

async function loadOwnedCommand(userId: number, commandId: string): Promise<Mt5DemoCommand | null> {
  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(and(eq(mt5DemoCommandsTable.userId, userId), eq(mt5DemoCommandsTable.commandId, commandId)))
    .limit(1);
  return rows[0] ?? null;
}

async function audit(args: {
  userId: number;
  commandId: string;
  eventType: string;
  severity: "INFO" | "WARNING" | "HIGH";
  status: "ALLOWED" | "DENIED" | "ATTEMPTED";
  message: string;
  metadata: Record<string, unknown>;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}): Promise<void> {
  try {
    await recordSecurityEvent({
      eventType: args.eventType,
      severity: args.severity,
      status: args.status,
      actorUserId: args.userId,
      route: `/internal/demoCommandConsumer/${args.commandId}`,
      method: "INTERNAL",
      ipAddress: args.actorIp ?? null,
      userAgent: args.actorUserAgent ?? null,
      message: args.message,
      metadata: args.metadata,
    });
  } catch {
    /* non-fatal */
  }
}

export async function consumeApprovedCommand(args: ConsumeArgs): Promise<ConsumeResult> {
  // 1. Load + ownership.
  const row = await loadOwnedCommand(args.userId, args.commandId);
  if (!row) {
    return { ok: false, reason: "COMMAND_NOT_FOUND", stage: "LOAD", canDispatchToMt5Allowed: false };
  }

  // 2. State guard.
  if (row.status !== "DEMO_APPROVED") {
    await audit({
      userId: args.userId,
      commandId: args.commandId,
      eventType: "DEMO_DISPATCH_REFUSED",
      severity: "WARNING",
      status: "DENIED",
      message: `Consumer refused: command is not DEMO_APPROVED (state=${row.status}).`,
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        currentStatus: row.status,
        result: "REFUSED",
        reason: "WRONG_STATE",
        safetyGateSnapshot: row.safetyGateSnapshot,
      },
      actorIp: args.actorIp,
      actorUserAgent: args.actorUserAgent,
    });
    return {
      ok: false,
      reason: `WRONG_STATE:${row.status}`,
      stage: "STATE",
      command: row,
      canDispatchToMt5Allowed: false,
    };
  }

  // 3. Duplicate suppression (application-level; DB index is the belt).
  const dup = await findRecentDuplicate({
    userId: args.userId,
    commandType: row.commandType,
    payload: row.payload,
    excludeCommandId: row.commandId,
  });

  // 4. Routing-aware dispatch gate (Centralized Master MT5 Bridge —
  //    Slice 1+2). Delegates to either per-user OR master-bridge
  //    readiness depending on the resolved routing mode.
  const gate = await evaluateRoutedDemoDispatchGate({
    userId: args.userId,
    userConfirmed: !!row.confirmedAt,
    duplicateClear: !dup.isDuplicate,
  });

  // Always emit ATTEMPTED before the chokepoint.
  await audit({
    userId: args.userId,
    commandId: args.commandId,
    eventType: "DEMO_DISPATCH_ATTEMPTED",
    severity: "INFO",
    status: "ATTEMPTED",
    message: "Consumer reached chokepoint. About to consult canDispatchToMt5().",
    metadata: {
      commandId: args.commandId,
      commandType: row.commandType,
      bridgeConnectionId: row.bridgeConnectionId,
      perUserEligible: gate.eligibility.eligible,
      perUserBlockers: gate.eligibility.blockers,
      heartbeatAgeSeconds: gate.evidence.heartbeatAgeSeconds,
      armed: gate.evidence.armed,
      verifiedDemo: gate.evidence.verifiedDemo,
      accountTypeReported: gate.evidence.accountTypeReported,
      reportedEaVersion: gate.evidence.reportedEaVersion,
      eaVersionAtLeast: gate.evidence.eaVersionAtLeast,
      duplicateSuspected: dup.isDuplicate,
      result: "ATTEMPTED",
      safetyGateSnapshot: row.safetyGateSnapshot,
    },
    actorIp: args.actorIp,
    actorUserAgent: args.actorUserAgent,
  });

  if (dup.isDuplicate) {
    await audit({
      userId: args.userId,
      commandId: args.commandId,
      eventType: "DEMO_DISPATCH_DUPLICATE_SUPPRESSED",
      severity: "WARNING",
      status: "DENIED",
      message: `Consumer refused: duplicate fingerprint within ${dup.windowSeconds}s window.`,
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        matchedCommandIds: dup.matchedCommandIds,
        matchCount: dup.matchCount,
        fingerprint: dup.fingerprint,
        result: "SUPPRESSED",
        reason: "DUPLICATE_SUSPECTED",
        safetyGateSnapshot: row.safetyGateSnapshot,
      },
      actorIp: args.actorIp,
      actorUserAgent: args.actorUserAgent,
    });
    return {
      ok: false,
      reason: "DUPLICATE_SUSPECTED",
      stage: "DUPLICATE",
      command: row,
      duplicateMatchedCommandIds: dup.matchedCommandIds,
      canDispatchToMt5Allowed: false,
    };
  }

  if (!gate.eligibility.eligible) {
    await audit({
      userId: args.userId,
      commandId: args.commandId,
      eventType: "DEMO_DISPATCH_REFUSED",
      severity: "WARNING",
      status: "DENIED",
      message: `Consumer refused: per-user dispatch gate failed (${gate.eligibility.blockers.join(",")}).`,
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        perUserBlockers: gate.eligibility.blockers,
        reportedEaVersion: gate.evidence.reportedEaVersion,
        eaVersionAtLeast: gate.evidence.eaVersionAtLeast,
        result: "REFUSED",
        reason: "PER_USER_GATE_FAILED",
        safetyGateSnapshot: row.safetyGateSnapshot,
      },
      actorIp: args.actorIp,
      actorUserAgent: args.actorUserAgent,
    });
    return {
      ok: false,
      reason: `PER_USER_GATE_FAILED:${gate.eligibility.blockers.join(",")}`,
      stage: "PER_USER_GATE",
      command: row,
      perUserBlockers: gate.eligibility.blockers,
      canDispatchToMt5Allowed: false,
    };
  }

  // 5. Chokepoint.
  const dispatchInputs: PerUserDispatchInputs = {
    executionMode: "MT5_DEMO_EXECUTION",
    verifiedDemo: gate.evidence.verifiedDemo,
    accountTypeExplicitDemo: gate.evidence.accountTypeExplicitDemo,
    userOwnsBridge: gate.evidence.userOwnsBridge,
    bridgeConnected: gate.evidence.userOwnsBridge && gate.evidence.heartbeatFresh,
    heartbeatFresh: gate.evidence.heartbeatFresh,
    userConfirmed: !!row.confirmedAt,
    duplicateClear: true,
    riskGatePassed: true,
    liveLocked: true,
    eaVersionAtLeast: gate.evidence.eaVersionAtLeast,
    reportedEaVersion: gate.evidence.reportedEaVersion,
  };
  const chokepoint = canDispatchToMt5(dispatchInputs);
  if (!chokepoint.allowed) {
    await audit({
      userId: args.userId,
      commandId: args.commandId,
      eventType: "DEMO_DISPATCH_REFUSED",
      severity: "HIGH",
      status: "DENIED",
      message: `Consumer refused at chokepoint: ${chokepoint.reason}`,
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        result: "REFUSED",
        reason: chokepoint.reason,
        reportedEaVersion: gate.evidence.reportedEaVersion,
        safetyGateSnapshot: row.safetyGateSnapshot,
      },
      actorIp: args.actorIp,
      actorUserAgent: args.actorUserAgent,
    });
    return {
      ok: false,
      reason: chokepoint.reason,
      stage: "CHOKEPOINT",
      command: row,
      canDispatchToMt5Allowed: false,
    };
  }

  // 6. ADMITTED. Conditional UPDATE — only flips if row is still
  //    DEMO_APPROVED. The partial unique index on (user_id, fingerprint)
  //    will reject any concurrent duplicate at the DB layer.
  const fingerprint = computeCommandFingerprint({
    userId: args.userId,
    commandType: row.commandType,
    payload: row.payload,
  });
  const now = new Date();
  const sentSnapshot = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION",
    demoStatus: "VERIFIED_DEMO",
    canArmAllowed: true,
    userArmed: true,
    canDispatchAllowed: true,
  });

  let updated: Mt5DemoCommand | undefined;
  try {
    // REBIND: write the *currently active* bridge id from the gate. If the
    // user's active bridge id has changed between draft creation and
    // dispatch (e.g. EA reconnected with a new mt5_connection row), the
    // command's stored bridgeConnectionId would point at a stale row the
    // current EA cannot pick up. Rebinding at the SENT_TO_MT5_DEMO write
    // closes that orphan window atomically.
    const activeBridgeId = gate.evidence.bridgeConnectionId;
    if (!activeBridgeId) {
      throw new Error("ASSERT: per-user gate passed but bridgeConnectionId=null");
    }
    // Atomic block: SENT_TO_MT5_DEMO transition + (when master-routed)
    // shared_trade_attribution insert + back-link must all succeed together
    // so a master-routed dispatch can NEVER persist without attribution.
    // If anything throws, the transaction rolls back and the command stays
    // in DEMO_APPROVED for retry — no half-state, no orphan dispatch.
    updated = await db.transaction(async (tx) => {
      const result = await tx
        .update(mt5DemoCommandsTable)
        .set({
          status: "SENT_TO_MT5_DEMO",
          sentAt: now,
          fingerprint,
          bridgeConnectionId: activeBridgeId,
          eaVersionAtDispatch: gate.evidence.reportedEaVersion,
          safetyGateSnapshot: sentSnapshot,
          updatedAt: now,
        })
        .where(
          and(
            eq(mt5DemoCommandsTable.id, row.id),
            eq(mt5DemoCommandsTable.status, "DEMO_APPROVED"),
          ),
        )
        .returning();
      const txUpdated = result[0];
      if (!txUpdated) return undefined;

      // Centralized Master MT5 Bridge attribution (Slice 2) — atomic with
      // SENT_TO_MT5_DEMO. Per-user isolation preserved (userId on every row).
      if (gate.routing.routedViaMaster
          && gate.routing.sharedMasterAccountId
          && gate.routing.virtualAccountId
          && gate.routing.masterConnectionId) {
        const payload = (txUpdated.payload ?? {}) as Record<string, unknown>;
        const sym = String(payload["symbol"] ?? "");
        const sideRaw = String(payload["side"] ?? "").toUpperCase();
        const side = sideRaw === "SELL" ? "SELL" : "BUY";
        const lotSize = Number(payload["lotSize"] ?? 0);
        const stopLoss = payload["stopLoss"] != null ? Number(payload["stopLoss"]) : null;
        const takeProfit = payload["takeProfit"] != null ? Number(payload["takeProfit"]) : null;
        const [attr] = await tx
          .insert(sharedTradeAttributionTable)
          .values({
            userId: args.userId,
            virtualAccountId: gate.routing.virtualAccountId,
            sharedMasterAccountId: gate.routing.sharedMasterAccountId,
            masterConnectionId: gate.routing.masterConnectionId,
            tradeCommandId: txUpdated.id,
            symbol: sym,
            side,
            lotSize,
            stopLoss,
            takeProfit,
            status: "pending",
          })
          .returning();
        if (!attr) {
          throw new Error("ATTRIBUTION_INSERT_RETURNED_EMPTY");
        }
        const [linked] = await tx
          .update(mt5DemoCommandsTable)
          .set({ sharedAttributionId: attr.id, updatedAt: new Date() })
          .where(eq(mt5DemoCommandsTable.id, txUpdated.id))
          .returning();
        return linked ?? { ...txUpdated, sharedAttributionId: attr.id };
      }
      return txUpdated;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await audit({
      userId: args.userId,
      commandId: args.commandId,
      eventType: "DEMO_DISPATCH_DB_REJECTED",
      severity: "HIGH",
      status: "DENIED",
      message: `Consumer DB rejected SENT_TO_MT5_DEMO transition (likely active_fingerprint_uq).`,
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        fingerprint,
        dbErrorClass: msg.match(/[A-Z_]+/)?.[0] ?? "UNKNOWN",
        result: "REFUSED",
        reason: "DUPLICATE_SUPPRESSED_DB_UNIQUE",
        safetyGateSnapshot: row.safetyGateSnapshot,
      },
      actorIp: args.actorIp,
      actorUserAgent: args.actorUserAgent,
    });
    return {
      ok: false,
      reason: "DUPLICATE_SUPPRESSED_DB_UNIQUE",
      stage: "DISPATCH",
      command: row,
      canDispatchToMt5Allowed: false,
    };
  }

  if (!updated) {
    await audit({
      userId: args.userId,
      commandId: args.commandId,
      eventType: "DEMO_DISPATCH_RACE_LOST",
      severity: "WARNING",
      status: "DENIED",
      message: "Conditional UPDATE matched 0 rows — another worker advanced or terminated the row.",
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        result: "REFUSED",
        reason: "RACE_LOST",
        safetyGateSnapshot: row.safetyGateSnapshot,
      },
      actorIp: args.actorIp,
      actorUserAgent: args.actorUserAgent,
    });
    return {
      ok: false,
      reason: "RACE_LOST",
      stage: "DISPATCH",
      command: row,
      canDispatchToMt5Allowed: false,
    };
  }

  // Attribution insert + back-link is now done atomically inside the
  // SENT_TO_MT5_DEMO transaction above (Slice 2). A master-routed
  // SENT_TO_MT5_DEMO row therefore cannot persist with
  // sharedAttributionId IS NULL.

  const rebound = updated.bridgeConnectionId !== row.bridgeConnectionId;
  await audit({
    userId: args.userId,
    commandId: args.commandId,
    eventType: "DEMO_DISPATCH_SENT",
    severity: "INFO",
    status: "ALLOWED",
    message: `Command transitioned DEMO_APPROVED -> SENT_TO_MT5_DEMO${rebound ? " (REBOUND to active bridge)" : ""}. EA may poll and execute under its own ACCOUNT_TRADE_MODE=DEMO guard. No live order placed.`,
    metadata: {
      commandId: args.commandId,
      commandType: updated.commandType,
      userId: args.userId,
      previousBridgeConnectionId: row.bridgeConnectionId,
      bridgeConnectionId: updated.bridgeConnectionId,
      activeBridgeConnectionId: gate.evidence.bridgeConnectionId,
      bridgeRebound: rebound,
      pickupable: updated.bridgeConnectionId === gate.evidence.bridgeConnectionId,
      orphaned: updated.bridgeConnectionId !== gate.evidence.bridgeConnectionId,
      accountTypeReported: gate.evidence.accountTypeReported,
      heartbeatAgeSeconds: gate.evidence.heartbeatAgeSeconds,
      fingerprint,
      reportedEaVersion: gate.evidence.reportedEaVersion,
      eaMinDemoVersion: EA_MIN_DEMO_VERSION,
      result: "SENT_TO_MT5_DEMO",
      reason: "PER_USER_DEMO_DISPATCH_ALLOWED",
      safetyGateSnapshot: sentSnapshot,
    },
    actorIp: args.actorIp,
    actorUserAgent: args.actorUserAgent,
  });
  logger.info(
    {
      event: "demo_dispatch_sent",
      userId: args.userId,
      commandId: args.commandId,
      commandType: updated.commandType,
      previousBridgeConnectionId: row.bridgeConnectionId,
      assignedBridgeConnectionId: updated.bridgeConnectionId,
      activeBridgeConnectionId: gate.evidence.bridgeConnectionId,
      bridgeRebound: rebound,
      pickupable: updated.bridgeConnectionId === gate.evidence.bridgeConnectionId,
      orphaned: updated.bridgeConnectionId !== gate.evidence.bridgeConnectionId,
      heartbeatAgeSeconds: gate.evidence.heartbeatAgeSeconds,
      accountTypeReported: gate.evidence.accountTypeReported,
      reportedEaVersion: gate.evidence.reportedEaVersion,
    },
    "Demo dispatch SENT_TO_MT5_DEMO written",
  );

  return {
    ok: true,
    reason: "SENT_TO_MT5_DEMO",
    stage: "DISPATCH",
    command: updated,
    canDispatchToMt5Allowed: true,
  };
}
