// One-time operator data repair: reconcile OWNER phantom live positions using
// the broker's OWN account-state evidence (margin / equity / balance) when the
// always-on broker-absence auto-runner cannot fire because the EA is offline
// (no fresh positions-snapshot marker → snapshotReliable is false by design).
//
// WHAT THIS IS: a bridge-scoped, dry-run-first, audited operator correction. It
// reuses the EXISTING canonical pure decision engine
// (`findBrokerAbsentGhostPositionIds`), the SAME CAS stamp guard, the SAME
// `reconcileState=RECONCILED_BROKER_ABSENT` value, and writes the SAME
// `liveTradingAudit` BROKER_SIDE_CLOSE_RECONCILED rows the auto-runner writes —
// plus a single `admin_action_audit_log` summary row. It is NOT a second close
// path and sends NO broker/EA command: it only mirrors closes the broker has
// ALREADY made.
//
// WHY IT EXISTS (vs `reconcileOwnerPhantomLivePositions.ts`): that sibling
// script wraps the auto-runner, which refuses to stamp unless the latest
// positions-snapshot marker is within the reliability window — correct for an
// AUTOMATED path. When the EA is offline the marker goes stale and the runner
// blocks every row as SNAPSHOT_UNRELIABLE, even though the broker's LAST
// heartbeat already proves the account holds ZERO open positions. This script
// substitutes that one input — "current broker truth" — with the strongest
// possible DIRECT broker statement: the broker-reported `margin == 0` AND
// `equity == balance` on the bridge connection (the broker computes margin from
// its own open positions; margin 0 + zero floating P/L == nothing open). It
// does NOT touch, relax, or re-use the shared auto-runner or its policy.
//
// SAFETY (nothing relaxed beyond the explicit, documented substitution above):
//   - HARD EVIDENCE GATE: aborts unless the scoped bridge is a live/real
//     account AND broker margin == 0 AND |equity - balance| <= epsilon. If the
//     broker reports ANY used margin or ANY floating P/L, a real position may be
//     open → we refuse to reconcile anything.
//   - Per-row safety is the canonical pure engine: requires the broker-ticket,
//     >= requiredReliableAbsences consecutive absences, a minimum first-absence
//     age, per-user + per-bridge isolation, and skips any ticket with an
//     in-flight ARX CLOSE (never raced).
//   - CAS stamp re-asserts ticket + first-absent + absence-count + bridge +
//     still-open + still-unreconciled, so anything that changed since
//     evaluation is skipped.
//   - Each stamp + its audit row commit together in one transaction
//     (fail-closed). A summary admin_action_audit_log row records before/after.
//   - DRY-RUN by default; --apply is required to mutate. Idempotent: after apply
//     the open+unreconciled filter matches none, so a re-run stamps nothing.
//   - Also sweeps this user's stuck SENT_TO_MT5_LIVE commands whose TTL already
//     elapsed to the terminal LIVE_EXPIRED state via the EXISTING
//     `sweepExpiredLiveCommands` (honest terminal — never a fabricated fill).
//
// USAGE:
//   tsx src/scripts/reconcileOwnerPhantomLiveByBrokerState.ts --user=4 --bridge=446          # dry-run
//   tsx src/scripts/reconcileOwnerPhantomLiveByBrokerState.ts --user=4 --bridge=446 --apply  # apply

import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  db,
  arxLivePositionsTable,
  arxLiveCommandsTable,
  mt5ConnectionTable,
  liveTradingAuditTable,
  adminActionAuditLogTable,
} from "@workspace/db";
import { brokerAbsenceAutoReconcilePolicy } from "../lib/live/brokerAbsencePolicy.js";
import {
  findBrokerAbsentGhostPositionIds,
  chooseReconciledCloseAt,
} from "../lib/live/brokerAbsenceReconcile.js";
import { sweepExpiredLiveCommands } from "../lib/live/liveCommandPipeline.js";

// Equity/balance equality tolerance (USD). Broker numbers are 2-dp; anything
// within a cent is "no floating P/L".
const EQUITY_BALANCE_EPSILON = 0.01;

// Non-terminal ARX CLOSE statuses — a position with one of these in-flight must
// NOT be reconciled (don't race the ARX close path). Mirrors the auto-runner.
const PENDING_CLOSE_STATUSES = [
  "LIVE_DRAFT",
  "LIVE_CONFIRMATION_REQUIRED",
  "LIVE_APPROVED",
  "SENT_TO_MT5_LIVE",
] as const;

interface Args {
  userId: number;
  bridgeConnectionId: number;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  let userId: number | null = null;
  let bridgeConnectionId: number | null = null;
  let apply = false;
  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--user=")) userId = Number(a.slice("--user=".length));
    else if (a.startsWith("--bridge=")) bridgeConnectionId = Number(a.slice("--bridge=".length));
  }
  if (userId == null || !Number.isFinite(userId)) throw new Error("--user=<id> is required");
  if (bridgeConnectionId == null || !Number.isFinite(bridgeConnectionId)) {
    throw new Error("--bridge=<id> is required (write scope is mandatory; broker evidence is per-bridge)");
  }
  return { userId, bridgeConnectionId, apply };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const policy = brokerAbsenceAutoReconcilePolicy;
  const now = new Date();

  // ── 1. Load the scoped bridge + verify the broker EVIDENCE GATE ──────────
  const conns = await db.select().from(mt5ConnectionTable).where(and(
    eq(mt5ConnectionTable.userId, args.userId),
    eq(mt5ConnectionTable.id, args.bridgeConnectionId),
  ));
  const conn = conns[0];
  if (!conn) throw new Error(`No bridge ${args.bridgeConnectionId} for user ${args.userId}`);

  const accountType = (conn.accountType ?? "").toLowerCase();
  const margin = Number(conn.margin);
  const equity = Number(conn.accountEquity);
  const balance = Number(conn.accountBalance);
  const equityMatchesBalance =
    Number.isFinite(equity) && Number.isFinite(balance) &&
    Math.abs(equity - balance) <= EQUITY_BALANCE_EPSILON;
  const brokerReportsFlat =
    Number.isFinite(margin) && margin === 0 && equityMatchesBalance;

  console.log("── BROKER EVIDENCE (scoped bridge) ───────────────────────────");
  console.log(`bridge           ${conn.id}`);
  console.log(`accountType      ${accountType || "(null)"}`);
  console.log(`margin           ${margin}`);
  console.log(`equity           ${equity}`);
  console.log(`balance          ${balance}`);
  console.log(`equity==balance  ${equityMatchesBalance}`);
  console.log(`lastHeartbeat    ${conn.lastHeartbeat?.toISOString() ?? "(null)"}`);
  console.log(`brokerReportsFlat ${brokerReportsFlat}`);

  if (accountType !== "live" && accountType !== "real") {
    throw new Error(`EVIDENCE GATE FAILED: bridge ${conn.id} is not a live/real account (${accountType || "null"}).`);
  }
  if (!brokerReportsFlat) {
    throw new Error(
      `EVIDENCE GATE FAILED: broker does not report a flat account ` +
      `(margin=${margin}, equity=${equity}, balance=${balance}). A real position may be open — refusing to reconcile.`,
    );
  }

  // ── 2. Load open+unreconciled rows for this user+bridge ──────────────────
  const openRows = await db.select().from(arxLivePositionsTable).where(and(
    eq(arxLivePositionsTable.userId, args.userId),
    eq(arxLivePositionsTable.bridgeConnectionId, args.bridgeConnectionId),
    isNull(arxLivePositionsTable.closedAt),
    isNull(arxLivePositionsTable.reconcileState),
  ));

  // Pending ARX close tickets — never race the ARX-initiated close path.
  const pendingCloseTickets = new Set<string>();
  if (openRows.length > 0) {
    const pending = await db.select({ brokerTicket: arxLiveCommandsTable.brokerTicket })
      .from(arxLiveCommandsTable).where(and(
        eq(arxLiveCommandsTable.userId, args.userId),
        eq(arxLiveCommandsTable.commandType, "CLOSE_LIVE_POSITION"),
        inArray(arxLiveCommandsTable.status, [...PENDING_CLOSE_STATUSES]),
      ));
    for (const p of pending) if (p.brokerTicket) pendingCloseTickets.add(p.brokerTicket);
  }

  // ── 3. Canonical pure per-row decision. snapshotReliable=true is justified
  //    EXCLUSIVELY by the broker EVIDENCE GATE above (margin 0 + flat equity),
  //    not by a snapshot marker — that is the single, explicit substitution.
  const candidates = findBrokerAbsentGhostPositionIds(
    openRows.map((r) => ({
      positionId: r.id,
      userId: r.userId,
      bridgeConnectionId: r.bridgeConnectionId,
      brokerTicket: r.brokerTicket,
      symbol: r.symbol,
      closedAt: r.closedAt,
      reconcileState: r.reconcileState,
      brokerAbsentSnapshotCount: r.brokerAbsentSnapshotCount ?? 0,
      firstBrokerAbsentAt: r.firstBrokerAbsentAt,
      lastBrokerAbsentAt: r.lastBrokerAbsentAt,
      lastReliableSnapshotAt: r.lastReliableSnapshotAt,
      sourceCommandId: r.sourceCommandId,
    })),
    {
      now: now.getTime(),
      policy,
      scope: { userId: args.userId, bridgeConnectionId: args.bridgeConnectionId },
      pendingCloseTickets,
      snapshotReliable: true,
      snapshotComplete: true,
    },
  );

  const safe = candidates.filter((c) => c.safeToStampClosed);
  const blocked = candidates.filter((c) => !c.safeToStampClosed);
  const blockedReasons: Record<string, number> = {};
  for (const c of blocked) if (c.blockedReason) blockedReasons[c.blockedReason] = (blockedReasons[c.blockedReason] ?? 0) + 1;

  console.log("\n── CANDIDATES ────────────────────────────────────────────────");
  console.log(`open rows        ${openRows.length}`);
  console.log(`safe to stamp    ${safe.length}`);
  console.log(`blocked          ${blocked.length} ${JSON.stringify(blockedReasons)}`);
  for (const c of candidates.slice(0, 60)) {
    console.log(
      `  pos ${c.positionId} ${c.symbol} ticket=${c.brokerTicket ?? "?"} absent=${c.absentSnapshotCount} ` +
      `${c.safeToStampClosed ? "SAFE_TO_STAMP" : `BLOCKED(${c.blockedReason ?? "?"})`}`,
    );
  }

  if (!args.apply) {
    console.log("\nDRY RUN — no writes. Re-run with --apply to stamp the SAFE_TO_STAMP rows + sweep expired commands.");
    return;
  }

  // ── 4. APPLY — stamp each safe row + its audit in one transaction ────────
  const reconcileEvidence =
    `broker margin=0 & equity==balance=${balance} at heartbeat ${conn.lastHeartbeat?.toISOString() ?? "?"}`;
  const stampedIds: number[] = [];

  for (const c of safe) {
    const positionId = Number(c.positionId);
    const evaluatedFirstAbsent = c.firstAbsentAt ? new Date(c.firstAbsentAt) : null;
    if (evaluatedFirstAbsent == null || !c.brokerTicket) continue;
    const closeAt = chooseReconciledCloseAt(
      {
        firstBrokerAbsentAt: evaluatedFirstAbsent,
        lastBrokerAbsentAt: c.lastAbsentAt ? new Date(c.lastAbsentAt) : null,
        lastReliableSnapshotAt: c.lastReliableSnapshotAt ? new Date(c.lastReliableSnapshotAt) : null,
      },
      now,
    );
    const reconcileReason =
      `Broker-state reconcile (manual operator repair; EA offline so the auto-runner could not fire): ` +
      `${reconcileEvidence}; position absent across ${c.absentSnapshotCount} reliable sweeps` +
      (c.firstAbsentAt ? `; first absent ${c.firstAbsentAt}` : "");

    await db.transaction(async (tx) => {
      const stamped = await tx.update(arxLivePositionsTable).set({
        closedAt: closeAt,
        reconcileState: "RECONCILED_BROKER_ABSENT",
        reconcileReason,
        reconciledAt: now,
        lastSyncedAt: now,
      }).where(and(
        eq(arxLivePositionsTable.id, positionId),
        eq(arxLivePositionsTable.userId, args.userId),
        eq(arxLivePositionsTable.bridgeConnectionId, args.bridgeConnectionId),
        eq(arxLivePositionsTable.brokerTicket, c.brokerTicket!),
        eq(arxLivePositionsTable.firstBrokerAbsentAt, evaluatedFirstAbsent),
        gte(arxLivePositionsTable.brokerAbsentSnapshotCount, policy.requiredReliableAbsences),
        isNull(arxLivePositionsTable.closedAt),
        isNull(arxLivePositionsTable.reconcileState),
      )).returning({ id: arxLivePositionsTable.id });
      if (stamped.length === 0) return; // lost the race — leave as-is, no audit
      await tx.insert(liveTradingAuditTable).values({
        eventId: randomUUID(),
        eventType: "BROKER_SIDE_CLOSE_RECONCILED",
        severity: "HIGH",
        mode: "READ_ONLY",
        symbol: c.symbol,
        actorRole: "operator",
        message:
          `Broker-side close reconciled (operator broker-state repair) for position ${positionId} ` +
          `(ticket ${c.brokerTicket ?? "?"}, ${c.symbol}): ${reconcileReason}`,
        metadata: {
          source: "owner_phantom_broker_state_repair",
          actor: "operator",
          userId: args.userId,
          positionId,
          bridgeConnectionId: args.bridgeConnectionId,
          brokerTicket: c.brokerTicket ?? null,
          symbol: c.symbol,
          absentSnapshotCount: c.absentSnapshotCount,
          firstAbsentAt: c.firstAbsentAt ?? null,
          lastAbsentAt: c.lastAbsentAt ?? null,
          reconcileState: "RECONCILED_BROKER_ABSENT",
          estimatedCloseTime: true,
          closedAt: closeAt.toISOString(),
          brokerEvidence: { margin, equity, balance, lastHeartbeat: conn.lastHeartbeat?.toISOString() ?? null },
        },
      });
      stampedIds.push(positionId);
    });
  }

  // ── 5. Sweep this user's expired stuck live commands (honest terminal) ───
  const swept = await sweepExpiredLiveCommands({ userId: args.userId });

  // ── 6. Summary admin_action_audit_log row (operator data-repair record) ──
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.userId,
    adminRole: "OWNER",
    action: "RECONCILE_PHANTOM_LIVE_POSITIONS_BROKER_STATE",
    targetUserId: args.userId,
    beforeState: {
      bridgeConnectionId: args.bridgeConnectionId,
      openUnreconciledRows: openRows.length,
      candidateIds: candidates.map((c) => Number(c.positionId)),
      brokerEvidence: { margin, equity, balance, lastHeartbeat: conn.lastHeartbeat?.toISOString() ?? null },
      stuckSentCommandsBefore: swept.expired + 0,
    },
    afterState: {
      stampedCount: stampedIds.length,
      stampedPositionIds: stampedIds,
      sweptCommandCount: swept.expired,
      sweptCommandIds: swept.commandIds,
    },
    reason:
      `One-time operator data repair: mirrored ${stampedIds.length} broker-confirmed-absent phantom live ` +
      `position(s) closed (${reconcileEvidence}) and expired ${swept.expired} stuck live command(s). ` +
      `No broker command sent; reuses the canonical broker-absence decision + CAS guard.`,
  });

  console.log("\n── APPLIED ───────────────────────────────────────────────────");
  console.log(`stamped positions  ${stampedIds.length} ${JSON.stringify(stampedIds)}`);
  console.log(`expired commands   ${swept.expired} ${JSON.stringify(swept.commandIds)}`);
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("reconcileOwnerPhantomLiveByBrokerState FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
