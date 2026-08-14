// ARX AI — Demo command queue service (sub-phase 2).
//
// Phase 28-MT5-DEMO-ARMING (May 2026).
//
// Per-user demo command lifecycle:
//
//   DRAFT
//     -> USER_CONFIRMATION_REQUIRED   (createDraft success)
//     -> DEMO_APPROVED                (confirm; re-runs gate)
//     -> SENT_TO_MT5_DEMO             (dispatch — REFUSED while
//                                      canDispatchToMt5() refuses)
//     -> FILLED_DEMO                  (EA result — sub-phase 3)
//   Any -> BLOCKED / REJECTED / FAILED   (terminal)
//
// SAFETY in this sub-phase:
//   - `dispatch()` is implemented but always refuses with
//     BROKER_DISPATCH_NOT_BUILT. No code path can transition a command
//     into SENT_TO_MT5_DEMO. This is asserted by tests.
//   - Every transition re-runs `runDemoVerificationGate()` and refuses
//     if the user is no longer VERIFIED_DEMO or no longer armed.
//   - Every transition writes safetyGateSnapshot and a SecurityEvent.
//   - Per-user isolation enforced on every query.
//   - No raw tokens, no apiKeyHash, no account passwords are ever
//     accepted as payload or written to the table.

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  mt5ConnectionTable,
  mt5DemoCommandsTable,
  type Mt5DemoCommand,
} from "@workspace/db";
import {
  buildSafetyGateSnapshot,
  DEMO_COMMAND_TYPES,
  isValidDemoCommandTransition,
  type DemoCommandStatus,
  type DemoCommandType,
} from "@workspace/domain/safety-contracts/executionMode";
import { runDemoVerificationGate } from "./demoVerificationGate.js";
import { getDuplicateEaProbe } from "../../routes/mt5.js";
import { isArmedForDemo } from "./demoArmingService.js";
import {
  evaluateRoutedDemoDispatchGate,
  checkMasterExposure,
  buildArxOrderComment,
} from "./masterBridgeRouting.js";
import { recordSecurityEvent } from "../security/events.js";

function maskAccountLogin(login: string | null | undefined): string | null {
  if (!login) return null;
  const s = String(login);
  if (s.length <= 4) return `•••• ${s}`;
  return `•••• ${s.slice(-4)}`;
}

export interface DraftCommandArgs {
  userId: number;
  commandType: DemoCommandType;
  payload: Record<string, unknown>;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}

export interface QueueOpResult {
  ok: boolean;
  command?: Mt5DemoCommand;
  reason?: string;
}

function isAcceptablePayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  // Defensive: reject obvious secret-shaped keys to prevent the payload
  // from being abused as a credential conduit.
  const banned = /password|secret|token|apikeyhash|api_key_hash|session/i;
  for (const k of Object.keys(payload as Record<string, unknown>)) {
    if (banned.test(k)) return false;
  }
  return true;
}

/** Create a new DRAFT immediately advanced to USER_CONFIRMATION_REQUIRED. */
export async function createDraftCommand(args: DraftCommandArgs): Promise<QueueOpResult> {
  if (!(DEMO_COMMAND_TYPES as readonly string[]).includes(args.commandType)) {
    return { ok: false, reason: "UNKNOWN_COMMAND_TYPE" };
  }
  if (!isAcceptablePayload(args.payload)) {
    return { ok: false, reason: "INVALID_PAYLOAD" };
  }

  // User must be armed for demo to even DRAFT a command.
  const armed = await isArmedForDemo(args.userId);
  if (!armed) {
    return { ok: false, reason: "NOT_ARMED_FOR_DEMO_EXECUTION" };
  }

  // Routing-aware bridge selector (Centralized Master MT5 Bridge —
  // Slice 1+2). resolveRouting() picks USER_OWNED_MT5 or
  // SHARED_MASTER_MT5; the routed gate then evaluates readiness against
  // either the user's bridge OR the master bridge while still requiring
  // the user to be VERIFIED_DEMO + armed.
  const probeGate = await evaluateRoutedDemoDispatchGate({
    userId: args.userId,
    userConfirmed: false, // pre-confirmation; we only need the bridge evidence
    duplicateClear: true,
  });
  const routedViaMaster = probeGate.routing.routedViaMaster;
  const activeBridgeId = probeGate.evidence.bridgeConnectionId;
  const bridgeIsActive =
    probeGate.evidence.userOwnsBridge &&
    probeGate.evidence.heartbeatFresh &&
    probeGate.evidence.accountTypeExplicitDemo &&
    probeGate.evidence.eaVersionAtLeast &&
    probeGate.evidence.readOnlyModeReported !== true &&
    probeGate.evidence.enableDemoExecutionReported !== false;
  if (!activeBridgeId || !bridgeIsActive) {
    const reasons = probeGate.evidence.bridgeBlockers.length > 0
      ? [...probeGate.evidence.bridgeBlockers]
      : [];
    if (!probeGate.evidence.userOwnsBridge && !reasons.includes("NO_BRIDGE_CONNECTION")) {
      reasons.unshift(routedViaMaster ? "NO_MASTER_BRIDGE_CONNECTION" : "NO_BRIDGE_CONNECTION");
    }
    if (probeGate.routing.routingBlockReason && !reasons.includes(probeGate.routing.routingBlockReason)) {
      reasons.unshift(probeGate.routing.routingBlockReason);
    }
    return {
      ok: false,
      reason: `${routedViaMaster ? "NO_ACTIVE_MASTER_BRIDGE" : "NO_ACTIVE_DEMO_BRIDGE"}:${reasons.join(",") || "UNKNOWN"}`,
    };
  }
  const connRows = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, activeBridgeId))
    .limit(1);
  const conn = connRows[0];
  if (!conn) {
    return { ok: false, reason: "NO_ACTIVE_DEMO_BRIDGE:RACE_BRIDGE_GONE" };
  }

  // MASTER_ACCOUNT_EXPOSURE guard (M06) — only relevant when routing
  // through the shared master bridge.
  if (routedViaMaster && probeGate.routing.sharedMasterAccountId) {
    const lotRaw = (args.payload as Record<string, unknown>)?.["lotSize"];
    const addingLot = typeof lotRaw === "number"
      ? lotRaw
      : Number(lotRaw ?? 0);
    if (Number.isFinite(addingLot) && addingLot > 0) {
      const exposure = await checkMasterExposure({
        sharedMasterAccountId: probeGate.routing.sharedMasterAccountId,
        addingLot,
      });
      if (!exposure.ok) {
        return {
          ok: false,
          reason: `MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED:open=${exposure.currentOpenLots}+add=${addingLot}>cap=${exposure.cap}`,
        };
      }
    }
  }

  // Re-run gate. Must be VERIFIED_DEMO at this exact moment.
  const probe = getDuplicateEaProbe();
  const readiness = await runDemoVerificationGate({
    userId: args.userId,
    duplicateEaProbe: { suspected: probe.suspected, reason: probe.reason ?? null },
  });
  if (readiness.status !== "VERIFIED_DEMO") {
    return { ok: false, reason: `GATE_NOT_VERIFIED: ${readiness.blockers.join(",")}` };
  }

  const snapshot = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION",
    demoStatus: readiness.status,
    canArmAllowed: true,
    userArmed: true,
  });

  // Bridge readiness snapshot — pinned into payload at draft time so the
  // audit trail records exactly which bridge selection was chosen and why.
  // Useful for ops review when a command later REJECTS — we can prove the
  // bridge was fully eligible at draft time (and the rejection came from
  // EA-side runtime state, not server-side mis-selection).
  // Mask master account login in payload so the readiness snapshot
  // never leaks the real broker account number into the user-visible
  // command JSON (the EA still binds via bridge id + token, not login).
  const accountLoginForAudit = routedViaMaster
    ? maskAccountLogin(conn.accountNumber ?? null)
    : (conn.accountNumber ?? null);
  const bridgeReadinessAtDraft = {
    bridgeConnectionId: conn.id,
    accountLogin: accountLoginForAudit,
    accountType: conn.accountType ?? null,
    eaVersion: conn.eaVersion ?? null,
    heartbeatAgeSeconds: probeGate.evidence.heartbeatAgeSeconds,
    readOnlyMode: probeGate.evidence.readOnlyModeReported,
    enableDemoExecution: probeGate.evidence.enableDemoExecutionReported,
    bridgeBlockers: probeGate.evidence.bridgeBlockers,
    selectedAt: new Date().toISOString(),
    routedViaMaster,
    effectiveRoutingMode: probeGate.routing.effectiveRoutingMode,
    sharedMasterAccountId: probeGate.routing.sharedMasterAccountId,
    virtualAccountId: probeGate.routing.virtualAccountId,
  };

  // Sub-attribution: source page + signal id pulled from caller payload.
  const sourcePageRaw = (args.payload as Record<string, unknown>)?.["sourcePage"];
  const sourceSignalIdRaw = (args.payload as Record<string, unknown>)?.["sourceSignalId"];
  const sourcePage = typeof sourcePageRaw === "string" ? sourcePageRaw.slice(0, 64) : null;
  const sourceSignalId = typeof sourceSignalIdRaw === "string" ? sourceSignalIdRaw.slice(0, 128) : null;

  const commandId = `dmcmd_${randomUUID()}`;
  const arxOrderComment = buildArxOrderComment({
    userId: args.userId,
    commandId,
    source: sourcePage ?? "DIRECT",
  });
  const enrichedPayload = {
    ...args.payload,
    bridgeReadinessAtDraft,
    arxOrderComment,
  };

  const now = new Date();
  const [row] = await db
    .insert(mt5DemoCommandsTable)
    .values({
      commandId,
      userId: args.userId,
      bridgeConnectionId: conn.id,
      accountLogin: accountLoginForAudit,
      commandType: args.commandType,
      payload: enrichedPayload,
      status: "USER_CONFIRMATION_REQUIRED",
      safetyGateSnapshot: snapshot,
      confirmedAt: null,
      approvedAt: null,
      sentAt: null,
      filledAt: null,
      terminalAt: null,
      reason: null,
      sourcePage,
      sourceSignalId,
      routedViaMaster,
      sharedMasterAccountId: probeGate.routing.sharedMasterAccountId,
      virtualAccountId: probeGate.routing.virtualAccountId,
      sharedAttributionId: null, // set at SENT_TO_MT5_DEMO write by consumer
    })
    .returning();

  if (!row) {
    return { ok: false, reason: "INSERT_FAILED" };
  }

  try {
    await recordSecurityEvent({
      eventType: "DEMO_COMMAND_DRAFTED",
      severity: "INFO",
      status: "ALLOWED",
      actorUserId: args.userId,
      route: "/api/me/demo-commands",
      method: "POST",
      ipAddress: args.actorIp ?? null,
      userAgent: args.actorUserAgent ?? null,
      message: `Demo command drafted: ${args.commandType}. Awaiting user confirmation. No EA dispatch yet (broker dispatch not built).`,
      metadata: {
        commandId,
        commandType: args.commandType,
        bridgeConnectionId: conn.id,
        safetyGateSnapshot: snapshot,
        result: "DRAFTED_AWAITING_CONFIRMATION",
        reason: "USER_CONFIRMATION_REQUIRED",
      },
    });
  } catch { /* non-fatal */ }

  return { ok: true, command: row };
}

async function loadOwnedCommand(userId: number, commandId: string): Promise<Mt5DemoCommand | null> {
  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(and(eq(mt5DemoCommandsTable.commandId, commandId), eq(mt5DemoCommandsTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

async function transitionTo(
  row: Mt5DemoCommand,
  target: DemoCommandStatus,
  patch: Partial<Mt5DemoCommand> = {},
  options: { expectedStatus?: DemoCommandStatus } = {},
): Promise<Mt5DemoCommand> {
  if (!isValidDemoCommandTransition(row.status as DemoCommandStatus, target)) {
    throw new Error(`ILLEGAL_TRANSITION ${row.status} -> ${target}`);
  }
  const now = new Date();
  // Race safety: when an expected current status is provided, the UPDATE
  // is a compare-and-swap (`WHERE id=? AND status=?`). Concurrent writers
  // (e.g. EA result reconciler racing the stale-expiry sweep) cause the
  // UPDATE to affect 0 rows and we throw RACE_LOST so the caller can
  // skip cleanly instead of overwriting a freshly-reconciled terminal.
  const expectedStatus = options.expectedStatus ?? null;
  const whereClause = expectedStatus
    ? and(eq(mt5DemoCommandsTable.id, row.id), eq(mt5DemoCommandsTable.status, expectedStatus))
    : eq(mt5DemoCommandsTable.id, row.id);
  const [updated] = await db
    .update(mt5DemoCommandsTable)
    .set({
      ...patch,
      status: target,
      updatedAt: now,
    })
    .where(whereClause)
    .returning();
  if (!updated) {
    if (expectedStatus) throw new Error(`RACE_LOST ${row.status} -> ${target}`);
    throw new Error("update returned no row");
  }
  return updated;
}

/** Confirm a USER_CONFIRMATION_REQUIRED command — re-runs the gate and
 *  advances to DEMO_APPROVED. Does NOT send anything to MT5. */
export async function confirmCommand(args: {
  userId: number;
  commandId: string;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}): Promise<QueueOpResult> {
  const row = await loadOwnedCommand(args.userId, args.commandId);
  if (!row) return { ok: false, reason: "COMMAND_NOT_FOUND" };
  if (row.status !== "USER_CONFIRMATION_REQUIRED") {
    return { ok: false, reason: `WRONG_STATE:${row.status}` };
  }

  const armed = await isArmedForDemo(args.userId);
  if (!armed) {
    const blocked = await transitionTo(row, "BLOCKED", {
      reason: "USER_NO_LONGER_ARMED",
      terminalAt: new Date(),
    });
    try {
      await recordSecurityEvent({
        eventType: "DEMO_COMMAND_BLOCKED",
        severity: "WARNING",
        status: "DENIED",
        actorUserId: args.userId,
        route: `/api/me/demo-commands/${args.commandId}/confirm`,
        method: "POST",
        ipAddress: args.actorIp ?? null,
        userAgent: args.actorUserAgent ?? null,
        message: "Demo command BLOCKED at confirmation: user no longer armed.",
        metadata: {
          commandId: args.commandId,
          commandType: row.commandType,
          bridgeConnectionId: row.bridgeConnectionId,
          safetyGateSnapshot: row.safetyGateSnapshot,
          result: "BLOCKED",
          reason: "USER_NO_LONGER_ARMED",
        },
      });
    } catch { /* non-fatal */ }
    return { ok: false, command: blocked, reason: "USER_NO_LONGER_ARMED" };
  }

  const probe = getDuplicateEaProbe();
  const readiness = await runDemoVerificationGate({
    userId: args.userId,
    duplicateEaProbe: { suspected: probe.suspected, reason: probe.reason ?? null },
  });
  if (readiness.status !== "VERIFIED_DEMO") {
    const blocked = await transitionTo(row, "BLOCKED", {
      reason: `GATE_NOT_VERIFIED:${readiness.blockers.join(",")}`,
      terminalAt: new Date(),
      safetyGateSnapshot: readiness.safetyGateSnapshot,
    });
    try {
      await recordSecurityEvent({
        eventType: "DEMO_COMMAND_BLOCKED",
        severity: "WARNING",
        status: "DENIED",
        actorUserId: args.userId,
        route: `/api/me/demo-commands/${args.commandId}/confirm`,
        method: "POST",
        ipAddress: args.actorIp ?? null,
        userAgent: args.actorUserAgent ?? null,
        message: `Demo command BLOCKED at confirmation: verification gate no longer VERIFIED_DEMO.`,
        metadata: {
          commandId: args.commandId,
          commandType: row.commandType,
          bridgeConnectionId: row.bridgeConnectionId,
          safetyGateSnapshot: readiness.safetyGateSnapshot,
          result: "BLOCKED",
          reason: "GATE_NOT_VERIFIED",
          blockers: readiness.blockers,
        },
      });
    } catch { /* non-fatal */ }
    return { ok: false, command: blocked, reason: blocked.reason ?? undefined };
  }

  const snapshot = buildSafetyGateSnapshot({
    mode: "MT5_DEMO_EXECUTION",
    demoStatus: readiness.status,
    canArmAllowed: true,
    userArmed: true,
  });

  const now = new Date();
  const approved = await transitionTo(row, "DEMO_APPROVED", {
    confirmedAt: now,
    approvedAt: now,
    safetyGateSnapshot: snapshot,
  });

  try {
    await recordSecurityEvent({
      eventType: "DEMO_COMMAND_APPROVED",
      severity: "INFO",
      status: "ALLOWED",
      actorUserId: args.userId,
      route: `/api/me/demo-commands/${args.commandId}/confirm`,
      method: "POST",
      ipAddress: args.actorIp ?? null,
      userAgent: args.actorUserAgent ?? null,
      message:
        "Demo command APPROVED. No EA dispatch performed — broker dispatch path is not built in this sub-phase. Command will remain in DEMO_APPROVED until sub-phase 3 wires the consumer.",
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        canDispatchToMt5: false,
        safetyGateSnapshot: snapshot,
        result: "APPROVED",
        reason: "USER_CONFIRMED",
      },
    });
  } catch { /* non-fatal */ }

  return { ok: true, command: approved };
}

/** Cancel a DRAFT/USER_CONFIRMATION_REQUIRED command — sets BLOCKED. */
export async function cancelCommand(args: {
  userId: number;
  commandId: string;
  reason: string;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}): Promise<QueueOpResult> {
  const row = await loadOwnedCommand(args.userId, args.commandId);
  if (!row) return { ok: false, reason: "COMMAND_NOT_FOUND" };
  if (row.status !== "DRAFT" && row.status !== "USER_CONFIRMATION_REQUIRED") {
    return { ok: false, reason: `WRONG_STATE:${row.status}` };
  }
  const blocked = await transitionTo(row, "BLOCKED", {
    reason: `USER_CANCELLED:${args.reason}`.slice(0, 500),
    terminalAt: new Date(),
  });
  try {
    await recordSecurityEvent({
      eventType: "DEMO_COMMAND_CANCELLED",
      severity: "INFO",
      status: "ALLOWED",
      actorUserId: args.userId,
      route: `/api/me/demo-commands/${args.commandId}/cancel`,
      method: "POST",
      ipAddress: args.actorIp ?? null,
      userAgent: args.actorUserAgent ?? null,
      message: `User cancelled demo command before dispatch.`,
      metadata: {
        commandId: args.commandId,
        commandType: row.commandType,
        bridgeConnectionId: row.bridgeConnectionId,
        safetyGateSnapshot: row.safetyGateSnapshot,
        result: "CANCELLED",
        reason: args.reason,
      },
    });
  } catch { /* non-fatal */ }
  return { ok: true, command: blocked };
}

/**
 * Cancel orphaned demo commands — sub-phase 3D.
 *
 * Finds rows the user owns in DEMO_APPROVED or SENT_TO_MT5_DEMO whose
 * `bridgeConnectionId` no longer matches the user's current active bridge
 * connection (because the EA was redeployed under a new per-user bridge
 * token). The current EA poll filter is scoped to its own bridge id, so
 * these rows can never be picked up — they would block the queue forever.
 *
 * Transition target is `FAILED` with reason
 * `EXPIRED_ORPHANED_BRIDGE_COMMAND` — allowed for both
 * DEMO_APPROVED→FAILED and SENT_TO_MT5_DEMO→FAILED by the transition
 * table. Every cancel writes a SecurityEvent.
 *
 * Returns the cancelled command ids. Never sends anything to MT5. Live
 * trading remains BLOCKED.
 */
export async function cancelOrphanedSentCommands(args: {
  userId: number;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}): Promise<{
  ok: boolean;
  cancelledCommandIds: string[];
  currentBridgeConnectionId: number | null;
  reason?: string;
}> {
  // Resolve the user's current bridge (freshest, non-revoked).
  const connRows = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, args.userId));
  connRows.sort((a, b) => {
    const ra = a.tokenRevokedAt ? 1 : 0;
    const rb = b.tokenRevokedAt ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const ta = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
    const tb = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
    return tb - ta;
  });
  const currentConn = connRows.find((r) => !r.tokenRevokedAt) ?? null;
  if (!currentConn) {
    return {
      ok: false,
      cancelledCommandIds: [],
      currentBridgeConnectionId: null,
      reason: "NO_CURRENT_BRIDGE_CONNECTION",
    };
  }

  // Find pending/approved rows bound to a different bridge connection.
  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.userId, args.userId));
  const orphans = rows.filter(
    (r) =>
      (r.status === "DRAFT" ||
        r.status === "USER_CONFIRMATION_REQUIRED" ||
        r.status === "DEMO_APPROVED" ||
        r.status === "SENT_TO_MT5_DEMO") &&
      r.bridgeConnectionId !== currentConn.id,
  );

  const cancelled: string[] = [];
  for (const row of orphans) {
    // SENT_TO_MT5_DEMO can only transition to FILLED_DEMO/REJECTED/FAILED.
    // Earlier states can only transition to BLOCKED/REJECTED/FAILED.
    // Use FAILED for SENT_TO_MT5_DEMO, BLOCKED for everything earlier.
    const target = row.status === "SENT_TO_MT5_DEMO" ? "FAILED" : "BLOCKED";
    try {
      const updated = await transitionTo(row, target, {
        reason: "EXPIRED_ORPHANED_BRIDGE_COMMAND",
        terminalAt: new Date(),
      });
      cancelled.push(updated.commandId);
      try {
        await recordSecurityEvent({
          eventType: "DEMO_COMMAND_CANCELLED",
          severity: "INFO",
          status: "ALLOWED",
          actorUserId: args.userId,
          route: "/api/me/demo-commands/cancel-orphaned",
          method: "POST",
          ipAddress: args.actorIp ?? null,
          userAgent: args.actorUserAgent ?? null,
          message: `Orphaned demo command cancelled: bound to bridge ${row.bridgeConnectionId}, current bridge ${currentConn.id}.`,
          metadata: {
            commandId: row.commandId,
            previousStatus: row.status,
            orphanedBridgeConnectionId: row.bridgeConnectionId,
            currentBridgeConnectionId: currentConn.id,
            result: "CANCELLED",
            reason: "EXPIRED_ORPHANED_BRIDGE_COMMAND",
          },
        });
      } catch { /* non-fatal */ }
    } catch (err) {
      // Skip rows whose transition fails (race with EA result write).
      // They will surface again on the next call if still orphaned.
    }
  }

  return {
    ok: true,
    cancelledCommandIds: cancelled,
    currentBridgeConnectionId: currentConn.id,
  };
}

/**
 * Expire stale SENT_TO_MT5_DEMO commands — v1.26 EA clarity.
 *
 * Finds rows in SENT_TO_MT5_DEMO whose sentAt is older than `olderThanMs`
 * (default 2 minutes) and transitions them to FAILED with reason
 * `EXPIRED_DEMO_NO_EA_PICKUP_2MIN`. This covers the case where the EA was
 * present at dispatch time but stopped polling (chart removed, MT5 closed,
 * EA paused) before the command was picked up. Without this sweep those
 * rows would block subsequent dispatches that share a fingerprint via the
 * partial unique index on (user_id, fingerprint).
 *
 * SAFETY: only acts on SENT_TO_MT5_DEMO → FAILED (already allowed by the
 * transition table). Never sends anything to MT5. liveLocked stays true.
 */
export async function expireStaleSentCommands(args: {
  userId: number;
  olderThanMs?: number;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}): Promise<{ expiredCommandIds: string[] }> {
  const olderThanMs = args.olderThanMs ?? 2 * 60_000;
  const cutoff = new Date(Date.now() - olderThanMs);
  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(
      and(
        eq(mt5DemoCommandsTable.userId, args.userId),
        eq(mt5DemoCommandsTable.status, "SENT_TO_MT5_DEMO"),
      ),
    );
  const stale = rows.filter(
    (r) => r.sentAt != null && new Date(r.sentAt).getTime() < cutoff.getTime(),
  );
  const expired: string[] = [];
  for (const row of stale) {
    try {
      // Compare-and-swap on status: if a concurrent EA reconcile has
      // already moved the row out of SENT_TO_MT5_DEMO, the UPDATE affects
      // 0 rows and transitionTo throws RACE_LOST — we skip and the real
      // terminal stands.
      const updated = await transitionTo(
        row,
        "FAILED",
        {
          reason: "EXPIRED_DEMO_NO_EA_PICKUP_2MIN",
          terminalAt: new Date(),
        },
        { expectedStatus: "SENT_TO_MT5_DEMO" },
      );
      expired.push(updated.commandId);
      try {
        await recordSecurityEvent({
          eventType: "DEMO_COMMAND_CANCELLED",
          severity: "INFO",
          status: "ALLOWED",
          actorUserId: args.userId,
          route: "/api/me/demo-bridge-debug",
          method: "GET",
          ipAddress: args.actorIp ?? null,
          userAgent: args.actorUserAgent ?? null,
          message: `Stale demo command expired after ${Math.round(olderThanMs / 1000)}s with no EA pickup.`,
          metadata: {
            commandId: row.commandId,
            previousStatus: row.status,
            sentAt: row.sentAt?.toISOString() ?? null,
            ageSeconds: row.sentAt ? Math.round((Date.now() - new Date(row.sentAt).getTime()) / 1000) : null,
            reason: "EXPIRED_DEMO_NO_EA_PICKUP_2MIN",
            result: "EXPIRED",
          },
        });
      } catch { /* non-fatal */ }
    } catch {
      // Race with a real EA write-back; skip — the EA-result path will resolve it.
    }
  }
  return { expiredCommandIds: expired };
}

/**
 * Dispatch — sub-phase 3B. Routes through `consumeApprovedCommand` which
 * is the SINGLE writer of the SENT_TO_MT5_DEMO status. This thin wrapper
 * preserves the public API so existing callers continue to work.
 */
export async function dispatchApprovedCommand(args: {
  userId: number;
  commandId: string;
  actorIp?: string | null;
  actorUserAgent?: string | null;
}): Promise<QueueOpResult> {
  // Lazy import to avoid a static cycle (consumer imports demoDispatchGate
  // which imports getDuplicateEaProbe from routes/mt5).
  const { consumeApprovedCommand } = await import("./demoCommandConsumer.js");
  const result = await consumeApprovedCommand({
    userId: args.userId,
    commandId: args.commandId,
    actorIp: args.actorIp ?? null,
    actorUserAgent: args.actorUserAgent ?? null,
  });
  return { ok: result.ok, command: result.command, reason: result.reason };
}

/** List commands owned by user, newest first. */
export async function listUserCommands(args: {
  userId: number;
  limit?: number;
}): Promise<Mt5DemoCommand[]> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const rows = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.userId, args.userId))
    .limit(limit);
  // Newest first by id (createdAt covered by index).
  return rows.sort((a, b) => b.id - a.id);
}

export async function getUserCommand(userId: number, commandId: string): Promise<Mt5DemoCommand | null> {
  return loadOwnedCommand(userId, commandId);
}
