// Phase 28-MT5-DEMO-ARMING sub-phase 3D — Demo Bridge Debug endpoint.
//
// Read-only observability for the user's demo execution path. Tells the
// honest truth about whether the EA is actually picking up demo commands.
//
// GET /api/me/demo-bridge-debug
//
// Returns last EA heartbeat, last demo poll, last demo result, pending
// SENT_TO_MT5_DEMO count, derived `eaDemoConsumerActive` (true iff the
// EA polled the DEMO channel within the last 60s), and a plain-language
// diagnosis when the user has pending commands but the EA is not polling.
//
// SAFETY: never returns tokens, hashes, IPs, raw account numbers, or
// safetyGateSnapshot blobs. Account login is masked.

import { Router, type Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  mt5ConnectionTable,
  mt5DemoCommandsTable,
  securityEventsTable,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import { expireStaleSentCommands } from "../lib/mt5/demoCommandQueue.js";
import { evaluatePerUserDispatchGate } from "../lib/mt5/demoDispatchGate.js";

const router = Router();

const POLL_FRESH_WINDOW_MS = 60_000;
const HEARTBEAT_FRESH_WINDOW_MS = 60_000;

function getUserId(req: Request): number | null {
  const authUser = (req as Request & { authUser?: { id: number } }).authUser;
  return authUser?.id ?? null;
}

function maskLogin(login: string | null): string | null {
  if (!login) return null;
  const s = String(login);
  if (s.length <= 4) return "***";
  return `***${s.slice(-4)}`;
}

function ageSeconds(t: Date | null | undefined): number | null {
  if (!t) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 1000));
}

router.get("/me/demo-bridge-debug", requireUser, async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return;
  }

  // v1.26 EA clarity — opportunistic stale-SENT sweep on every read.
  // Bounded to this user; transitions SENT_TO_MT5_DEMO older than 2min →
  // FAILED with reason EXPIRED_DEMO_NO_EA_PICKUP_2MIN. Audited per row.
  // Safe to run on every poll: short-circuits when nothing is stale.
  let staleExpiredCommandIds: string[] = [];
  try {
    const sweep = await expireStaleSentCommands({
      userId,
      olderThanMs: 2 * 60_000,
      actorIp: req.ip ?? null,
      actorUserAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    });
    staleExpiredCommandIds = sweep.expiredCommandIds;
  } catch (err) {
    req.log?.warn({ err, userId }, "demo_bridge_debug_stale_sweep_failed");
  }

  // Pick the active bridge using the SAME ranked selector as the dispatch
  // gate so the UI / debug view / actual command dispatch all agree on
  // which bridge is "active". Falls back to the legacy freshest-non-revoked
  // rule only if the gate evidence is missing (defensive — should not
  // happen in practice).
  const bridgeRows = await db
    .select()
    .from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.userId, userId));
  let activeBridgeIdFromGate: number | null = null;
  let gateEvidence: Awaited<ReturnType<typeof evaluatePerUserDispatchGate>>["evidence"] | null = null;
  let gateBlockers: string[] = [];
  try {
    const gate = await evaluatePerUserDispatchGate({
      userId,
      userConfirmed: false,
      duplicateClear: true,
    });
    activeBridgeIdFromGate = gate.evidence.bridgeConnectionId;
    gateEvidence = gate.evidence;
    gateBlockers = gate.eligibility.blockers;
  } catch (err) {
    req.log?.warn({ err, userId }, "demo_bridge_debug_gate_eval_failed");
  }
  // Sort: gate-chosen first, then non-revoked, then freshest heartbeat —
  // used for the allBridgeConnections list ordering only.
  bridgeRows.sort((a, b) => {
    const ga = a.id === activeBridgeIdFromGate ? 0 : 1;
    const gb = b.id === activeBridgeIdFromGate ? 0 : 1;
    if (ga !== gb) return ga - gb;
    const ra = a.tokenRevokedAt ? 1 : 0;
    const rb = b.tokenRevokedAt ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const ta = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
    const tb = b.lastHeartbeat ? new Date(b.lastHeartbeat).getTime() : 0;
    return tb - ta;
  });
  const conn = activeBridgeIdFromGate != null
    ? bridgeRows.find((r) => r.id === activeBridgeIdFromGate) ?? null
    : bridgeRows.find((r) => !r.tokenRevokedAt) ?? null;

  // Recent demo-channel security events for this user.
  const evtTypes = [
    "DEMO_POLL_SERVED",
    "DEMO_POLL_REFUSED",
    "DEMO_DISPATCH_SENT",
    "DEMO_DISPATCH_REFUSED",
    "DEMO_DISPATCH_DB_REJECTED",
    "DEMO_DISPATCH_RACE_LOST",
    "DEMO_RECONCILE_REFUSED",
    "DEMO_RESULT_REFUSED",
    "DEMO_COMMAND_RECONCILED",
  ];
  const recentEvents = await db
    .select({
      eventType: securityEventsTable.eventType,
      status: securityEventsTable.status,
      message: securityEventsTable.message,
      metadata: securityEventsTable.metadata,
      createdAt: securityEventsTable.createdAt,
    })
    .from(securityEventsTable)
    .where(
      and(
        eq(securityEventsTable.actorUserId, userId),
        inArray(securityEventsTable.eventType, evtTypes),
      ),
    )
    .orderBy(desc(securityEventsTable.createdAt))
    .limit(25);

  const lastPollServed = recentEvents.find((e) => e.eventType === "DEMO_POLL_SERVED") ?? null;
  const lastPollRefused = recentEvents.find((e) => e.eventType === "DEMO_POLL_REFUSED") ?? null;
  const lastPoll = (() => {
    if (!lastPollServed && !lastPollRefused) return null;
    if (!lastPollServed) return lastPollRefused;
    if (!lastPollRefused) return lastPollServed;
    return new Date(lastPollServed.createdAt) >= new Date(lastPollRefused.createdAt)
      ? lastPollServed
      : lastPollRefused;
  })();
  const lastResult = recentEvents.find(
    (e) =>
      e.eventType === "DEMO_COMMAND_RECONCILED" ||
      e.eventType === "DEMO_RESULT_REFUSED" ||
      e.eventType === "DEMO_RECONCILE_REFUSED",
  ) ?? null;
  const lastDispatchSent = recentEvents.find((e) => e.eventType === "DEMO_DISPATCH_SENT") ?? null;

  // Pending rows (commands the EA is supposed to pick up).
  const pendingRows = await db
    .select({
      id: mt5DemoCommandsTable.id,
      commandId: mt5DemoCommandsTable.commandId,
      bridgeConnectionId: mt5DemoCommandsTable.bridgeConnectionId,
      sentAt: mt5DemoCommandsTable.sentAt,
    })
    .from(mt5DemoCommandsTable)
    .where(
      and(
        eq(mt5DemoCommandsTable.userId, userId),
        eq(mt5DemoCommandsTable.status, "SENT_TO_MT5_DEMO"),
      ),
    );
  const pendingCount = pendingRows.length;
  const currentBridgeId = conn?.id ?? null;

  // Also report any non-terminal earlier-state rows bound to a previous
  // bridge (DRAFT / USER_CONFIRMATION_REQUIRED / DEMO_APPROVED) so the UI
  // can prompt cleanup even before they reach SENT_TO_MT5_DEMO.
  const earlyOrphanRows = currentBridgeId
    ? await db
        .select({
          id: mt5DemoCommandsTable.id,
          commandId: mt5DemoCommandsTable.commandId,
          status: mt5DemoCommandsTable.status,
          bridgeConnectionId: mt5DemoCommandsTable.bridgeConnectionId,
        })
        .from(mt5DemoCommandsTable)
        .where(
          and(
            eq(mt5DemoCommandsTable.userId, userId),
            inArray(mt5DemoCommandsTable.status, [
              "DRAFT",
              "USER_CONFIRMATION_REQUIRED",
              "DEMO_APPROVED",
            ]),
          ),
        )
    : [];
  const earlyOrphans = earlyOrphanRows.filter(
    (r) => r.bridgeConnectionId !== currentBridgeId,
  );

  const orphanedPending = currentBridgeId
    ? pendingRows.filter((r) => r.bridgeConnectionId !== currentBridgeId)
    : pendingRows;
  const pickupablePending = currentBridgeId
    ? pendingRows.filter((r) => r.bridgeConnectionId === currentBridgeId).length
    : 0;
  const totalOrphanedAnyState = orphanedPending.length + earlyOrphans.length;

  // Most recent terminal/last-action command (for last MT5 retcode/reason).
  const recentCmds = await db
    .select()
    .from(mt5DemoCommandsTable)
    .where(eq(mt5DemoCommandsTable.userId, userId))
    .orderBy(desc(mt5DemoCommandsTable.id))
    .limit(5);
  const lastTerminal = recentCmds.find((c) =>
    ["REJECTED", "FILLED_DEMO", "FAILED", "BLOCKED"].includes(c.status),
  );

  const lastHeartbeatAt = conn?.lastHeartbeat ?? null;
  const heartbeatAgeSeconds = ageSeconds(lastHeartbeatAt);
  const bridgeHeartbeatFresh =
    heartbeatAgeSeconds != null && heartbeatAgeSeconds * 1000 < HEARTBEAT_FRESH_WINDOW_MS;

  const lastPollAt = lastPoll?.createdAt ?? null;
  const lastPollAgeSeconds = ageSeconds(lastPollAt);
  const eaDemoConsumerActive =
    lastPollAgeSeconds != null && lastPollAgeSeconds * 1000 < POLL_FRESH_WINDOW_MS;

  // Diagnosis when the user has pending commands but EA is silent.
  const diagnoses: string[] = [];
  if (pendingCount > 0 && !eaDemoConsumerActive) {
    if (!bridgeHeartbeatFresh) {
      diagnoses.push(
        "EA heartbeat is stale — the EA may be detached, MT5 may not be running, or WebRequest may be blocked. Check MT5 Tools → Options → Expert Advisors → WebRequest allowlist includes your Replit URL.",
      );
    } else {
      diagnoses.push(
        "Bridge heartbeat is fresh but the EA has not polled the DEMO channel. Most likely cause: EA Inputs `EnableDemoExecution=false` or `ReadOnlyMode=true`. Open the EA on the chart → Inputs → set EnableDemoExecution=true AND ReadOnlyMode=false → OK. The EA will only execute on accounts where ACCOUNT_TRADE_MODE=DEMO.",
      );
    }
  }
  if (orphanedPending.length > 0 && currentBridgeId) {
    diagnoses.push(
      `${orphanedPending.length} pending command(s) are bound to a previous bridge connection and will NEVER be picked up by the current EA (bridge id ${currentBridgeId}). Cancel them from the Commands table and dispatch a fresh one. Orphaned ids: ${orphanedPending.map((r) => r.commandId.slice(0, 14)).join(", ")}.`,
    );
  }
  if (eaDemoConsumerActive && pickupablePending === 0 && pendingCount === 0) {
    diagnoses.push(
      "EA is polling the DEMO channel and ready. No commands are queued — dispatch one from the Test Panel to see it execute.",
    );
  }
  if (conn && conn.accountType && conn.accountType !== "demo" && conn.accountType !== "contest") {
    diagnoses.push(
      `Account type reported as "${conn.accountType}". The EA will refuse demo execution unless ACCOUNT_TRADE_MODE=DEMO at send time. Use a demo MT5 account.`,
    );
  }
  if (!conn) {
    diagnoses.push("No per-user bridge connection found. Create one on the ARX MT5 Setup page.");
  }

  // v1.26 EA clarity — duplicate/stale bridge-row detection.
  // Surface every non-revoked row for this user (with heartbeat age) so the
  // UI can warn the operator about leftover registrations from earlier EA
  // installs. The active selector picks the freshest, but stale rows clutter
  // the connection list and can confuse troubleshooting.
  const allBridges = bridgeRows
    .filter((r) => !r.tokenRevokedAt)
    .map((r) => ({
      connectionId: r.id,
      accountLoginMasked: maskLogin(r.accountNumber ?? null),
      accountType: r.accountType ?? null,
      eaVersionReported: r.eaVersion ?? null,
      tokenLast4: r.tokenLast4 ?? null,
      lastHeartbeatAt: r.lastHeartbeat ? new Date(r.lastHeartbeat).toISOString() : null,
      heartbeatAgeSeconds: ageSeconds(r.lastHeartbeat),
      isActive: r.id === (conn?.id ?? -1),
    }));
  const staleBridges = allBridges.filter(
    (b) => !b.isActive && (b.heartbeatAgeSeconds == null || b.heartbeatAgeSeconds > 60),
  );
  // Group by UNMASKED accountNumber server-side — masked logins (`***last4`)
  // can collide for distinct accounts and produce false positives. The
  // masked form is only used in the response payload.
  const activeAccount = conn?.accountNumber ?? null;
  const sameAccountDuplicateConnIds = activeAccount
    ? bridgeRows
        .filter(
          (r) =>
            !r.tokenRevokedAt &&
            r.id !== conn?.id &&
            (r.accountNumber ?? null) === activeAccount,
        )
        .map((r) => r.id)
    : [];
  if (sameAccountDuplicateConnIds.length > 0) {
    diagnoses.push(
      `${sameAccountDuplicateConnIds.length} duplicate bridge connection(s) registered for the same MT5 account as the active one. Active id=${conn?.id}; duplicates ids=${sameAccountDuplicateConnIds.join(", ")}. They are harmless (server picks the freshest) but you can revoke them from the MT5 Setup page to keep the connection list clean.`,
    );
  }

  // Surface EA-side input toggles that the EA reports via heartbeat (v1.26+).
  // Stored inside capabilities.eaInputs as an observability sidecar; NEVER
  // used to enable execution server-side.
  const capsAny = (conn?.capabilities ?? null) as
    | (Record<string, unknown> & { eaInputs?: Record<string, unknown> })
    | null;
  const eaInputsReport = capsAny?.eaInputs ?? null;
  const readOnlyModeReported =
    eaInputsReport && typeof eaInputsReport["readOnlyMode"] === "boolean"
      ? Boolean(eaInputsReport["readOnlyMode"])
      : null;
  const enableDemoExecutionReported =
    eaInputsReport && typeof eaInputsReport["enableDemoExecution"] === "boolean"
      ? Boolean(eaInputsReport["enableDemoExecution"])
      : null;
  const eaInputsReportedAt =
    eaInputsReport && typeof eaInputsReport["reportedAt"] === "string"
      ? String(eaInputsReport["reportedAt"])
      : null;
  if (readOnlyModeReported === true) {
    diagnoses.push(
      "EA reports ReadOnlyMode=true — demo execution will be refused with REJECTED_READ_ONLY_MODE_ACTIVE. Flip ReadOnlyMode=false in MT5 → EA → Inputs.",
    );
  }
  if (enableDemoExecutionReported === false) {
    diagnoses.push(
      "EA reports EnableDemoExecution=false — demo execution will be refused with REJECTED_DEMO_EXECUTION_DISABLED_INPUT. Flip EnableDemoExecution=true in MT5 → EA → Inputs.",
    );
  }
  if (readOnlyModeReported === null && enableDemoExecutionReported === null && (conn?.eaVersion ?? "").startsWith("1.2")) {
    diagnoses.push(
      "EA has not reported ReadOnlyMode/EnableDemoExecution input state yet. Reattach the EA (or wait one heartbeat). v1.26 with the clarity patch sends these fields on every heartbeat.",
    );
  }

  if (staleExpiredCommandIds.length > 0) {
    diagnoses.push(
      `${staleExpiredCommandIds.length} stale SENT_TO_MT5_DEMO command(s) older than 2 minutes were auto-expired to FAILED with reason EXPIRED_DEMO_NO_EA_PICKUP_2MIN. Ids: ${staleExpiredCommandIds.map((id) => id.slice(0, 14)).join(", ")}.`,
    );
  }

  res.json({
    ok: true,
    safetyMode: "demo_only",
    liveExecutionBlocked: true,

    bridge: {
      connectionId: conn?.id ?? null,
      accountLoginMasked: maskLogin(conn?.accountNumber ?? null),
      accountType: conn?.accountType ?? null,
      eaVersionReported: conn?.eaVersion ?? null,
      lastHeartbeatAt: lastHeartbeatAt ? new Date(lastHeartbeatAt).toISOString() : null,
      heartbeatAgeSeconds,
      // legacy 60s "presence" window — keep for backwards-compat consumers
      heartbeatFresh: bridgeHeartbeatFresh,
      // STRICT 15s dispatch-eligibility window — same threshold the
      // dispatch gate uses. UI must use this (not heartbeatFresh) to
      // decide whether to allow submit.
      heartbeatFreshStrict: gateEvidence?.heartbeatFresh ?? false,
      // EA version comparison vs EA_MIN_DEMO_VERSION (1.26+). Authoritative.
      eaVersionAtLeast: gateEvidence?.eaVersionAtLeast ?? false,
      // Final server verdict — true iff this bridge would be accepted by
      // the dispatch gate right now. UI submit-gate MUST use this.
      bridgeReady: gateEvidence
        ? (
            gateEvidence.bridgeConnectionId === (conn?.id ?? null) &&
            gateEvidence.userOwnsBridge &&
            gateEvidence.heartbeatFresh &&
            gateEvidence.accountTypeExplicitDemo &&
            gateEvidence.eaVersionAtLeast &&
            gateEvidence.readOnlyModeReported !== true &&
            gateEvidence.enableDemoExecutionReported !== false &&
            (gateEvidence.bridgeBlockers?.length ?? 0) === 0
          )
        : false,
      bridgeBlockers: gateEvidence?.bridgeBlockers ?? [],
      gateBlockers,
      // v1.26 EA clarity — actual EA input state from the heartbeat.
      eaInputs: {
        readOnlyMode: readOnlyModeReported,
        enableDemoExecution: enableDemoExecutionReported,
        reportedAt: eaInputsReportedAt,
      },
    },

    // v1.26 EA clarity — all non-revoked connections for this user, so the
    // UI can show duplicate / leftover bridge registrations. The active one
    // has isActive=true; older entries are clutter but not harmful.
    allBridgeConnections: allBridges,
    staleBridgeCount: staleBridges.length,
    sameAccountDuplicateBridgeCount: sameAccountDuplicateConnIds.length,
    sameAccountDuplicateBridgeIds: sameAccountDuplicateConnIds,
    staleExpiredCommandIds,

    demoConsumer: {
      eaDemoConsumerActive,
      lastPollAt: lastPollAt ? new Date(lastPollAt).toISOString() : null,
      lastPollAgeSeconds,
      lastPollOutcome: lastPoll?.eventType ?? null,
      lastPollServedCount:
        (lastPollServed?.metadata as { count?: number } | undefined)?.count ?? null,
      lastDispatchSentAt: lastDispatchSent?.createdAt
        ? new Date(lastDispatchSent.createdAt).toISOString()
        : null,
      lastResultAt: lastResult?.createdAt
        ? new Date(lastResult.createdAt).toISOString()
        : null,
      lastResultOutcome: lastResult?.eventType ?? null,
      lastResultMessage: lastResult?.message ?? null,
    },

    pending: {
      sentToMt5DemoCount: pendingCount,
      pickupableByCurrentBridge: pickupablePending,
      orphanedFromPreviousBridge: orphanedPending.length,
      orphanedCommandIds: orphanedPending.map((r) => r.commandId),
      earlyOrphanedCount: earlyOrphans.length,
      earlyOrphanedCommandIds: earlyOrphans.map((r) => r.commandId),
      totalOrphanedAnyState,
      oldestSentAt:
        recentCmds.find((c) => c.status === "SENT_TO_MT5_DEMO")?.sentAt?.toISOString() ?? null,
    },

    lastTerminalCommand: lastTerminal
      ? {
          commandId: lastTerminal.commandId,
          status: lastTerminal.status,
          reason: lastTerminal.reason ?? null,
          brokerTicket: lastTerminal.brokerTicket ?? null,
          fillPrice: lastTerminal.fillPrice ?? null,
          filledAt: lastTerminal.filledAt?.toISOString() ?? null,
        }
      : null,

    diagnoses,
  });
});

export default router;
