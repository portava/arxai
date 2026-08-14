// Broker-Side Close Reconciliation Guardrail — DB runner.
//
// Orchestrates the PURE decision in `brokerAbsenceReconcile.ts` against the
// database: fetches the user's open live positions + accumulated absence
// evidence, computes current snapshot reliability, evaluates candidates, and —
// ONLY when the policy is enabled and not a dry-run — stamps closed_at +
// reconcileState=RECONCILED_BROKER_ABSENT on safe candidates with a CAS guard
// and a system audit row. NEVER sends a broker command.

import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  db,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  mt5ConnectionTable,
  liveTradingAuditTable,
} from "@workspace/db";
import { logger } from "../logger.js";
import { isSnapshotReliable } from "./positionFreshness.js";
import {
  brokerAbsenceAutoReconcilePolicy,
  type BrokerAbsenceReconcilePolicy,
} from "./brokerAbsencePolicy.js";
import {
  findBrokerAbsentGhostPositionIds,
  chooseReconciledCloseAt,
  type BrokerAbsentGhostCandidate,
} from "./brokerAbsenceReconcile.js";

// Non-terminal ARX CLOSE statuses — a position with one of these in-flight must
// NOT be broker-absence reconciled (don't race the ARX close path).
const PENDING_CLOSE_STATUSES = [
  "LIVE_DRAFT",
  "LIVE_CONFIRMATION_REQUIRED",
  "LIVE_APPROVED",
  "SENT_TO_MT5_LIVE",
] as const;

export interface BrokerAbsenceReconcileResult {
  enabled: boolean;
  dryRun: boolean;
  snapshotReliable: boolean;
  scope: { userId: number; bridgeConnectionId: number | null };
  candidateCount: number;
  safeToStampCount: number;
  blockedCount: number;
  stampedCount: number;
  blockedReasons: Record<string, number>;
  candidateStates: Record<string, number>;
  oldestCandidateAgeMs: number | null;
  candidates: BrokerAbsentGhostCandidate[];
}

/**
 * Evaluate (and, when enabled and not a dry-run, apply) broker-absence
 * reconciliation for one user, optionally scoped to a single bridge connection.
 */
export async function runBrokerAbsenceReconcile(args: {
  userId: number;
  bridgeConnectionId?: number | null;
  dryRun?: boolean;
  policy?: BrokerAbsenceReconcilePolicy;
  now?: Date;
}): Promise<BrokerAbsenceReconcileResult> {
  const policy = args.policy ?? brokerAbsenceAutoReconcilePolicy;
  const now = args.now ?? new Date();
  const bridgeConnectionId = args.bridgeConnectionId ?? null;
  const dryRun = args.dryRun ?? !policy.enabled;

  // Current snapshot reliability for the user's bridge(s). When a specific
  // bridge is in scope use its marker; otherwise use the freshest marker the
  // user has. A stale/missing marker => we have no reliable current broker
  // truth, so nothing is stampable (the helper blocks every row).
  const connRows = await db.select({
    id: mt5ConnectionTable.id,
    lastPositionsSnapshotAt: mt5ConnectionTable.lastPositionsSnapshotAt,
  }).from(mt5ConnectionTable).where(
    bridgeConnectionId != null
      ? and(eq(mt5ConnectionTable.userId, args.userId), eq(mt5ConnectionTable.id, bridgeConnectionId))
      : eq(mt5ConnectionTable.userId, args.userId),
  );
  let markerMs: number | null = null;
  for (const c of connRows) {
    const t = c.lastPositionsSnapshotAt ? c.lastPositionsSnapshotAt.getTime() : null;
    if (t != null && (markerMs == null || t > markerMs)) markerMs = t;
  }
  const snapshotReliable = isSnapshotReliable(markerMs, policy.snapshotReliabilityWindowMs, now.getTime());

  // Open, not-yet-reconciled rows for this user (+ bridge if scoped).
  const openRows = await db.select().from(arxLivePositionsTable).where(and(
    eq(arxLivePositionsTable.userId, args.userId),
    isNull(arxLivePositionsTable.closedAt),
    isNull(arxLivePositionsTable.reconcileState),
    ...(bridgeConnectionId != null ? [eq(arxLivePositionsTable.bridgeConnectionId, bridgeConnectionId)] : []),
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
      scope: { userId: args.userId, bridgeConnectionId },
      pendingCloseTickets,
      snapshotReliable,
      snapshotComplete: true, // EA pushes the COMPLETE open-position list per sweep
    },
  );

  const blockedReasons: Record<string, number> = {};
  const candidateStates: Record<string, number> = {};
  let oldestCandidateAgeMs: number | null = null;
  for (const c of candidates) {
    candidateStates[c.candidateState] = (candidateStates[c.candidateState] ?? 0) + 1;
    if (c.blockedReason) blockedReasons[c.blockedReason] = (blockedReasons[c.blockedReason] ?? 0) + 1;
    if (c.firstAbsentAt) {
      const age = now.getTime() - new Date(c.firstAbsentAt).getTime();
      if (oldestCandidateAgeMs == null || age > oldestCandidateAgeMs) oldestCandidateAgeMs = age;
    }
  }

  const safe = candidates.filter((c) => c.safeToStampClosed);
  let stampedCount = 0;

  // Writes require a CONCRETE bridge scope. Without it the snapshot-reliability
  // marker is the freshest across ALL of the user's bridges, so a fresh bridge B
  // could make a stale bridge A row look reliable. Dry-run (read-only) may run
  // unscoped; stamping may not. Auto-run from ingest is always bridge-scoped.
  const writeScopeOk = bridgeConnectionId != null;

  if (!dryRun && policy.enabled && writeScopeOk) {
    for (const c of safe) {
      const positionId = Number(c.positionId);
      // Evidence values captured at EVALUATION time. The stamp CAS re-asserts
      // them so a snapshot that landed between eval and write (re-confirming the
      // position → evidence reset, or a new absence cycle → new firstAbsent)
      // cannot be closed by this now-stale evaluation.
      const evaluatedFirstAbsent = c.firstAbsentAt ? new Date(c.firstAbsentAt) : null;
      const closeAt = chooseReconciledCloseAt(
        {
          firstBrokerAbsentAt: evaluatedFirstAbsent,
          lastBrokerAbsentAt: c.lastAbsentAt ? new Date(c.lastAbsentAt) : null,
          lastReliableSnapshotAt: c.lastReliableSnapshotAt ? new Date(c.lastReliableSnapshotAt) : null,
        },
        now,
      );
      const reconcileReason =
        `Broker-confirmed absent across ${c.absentSnapshotCount} reliable sweeps` +
        (c.firstAbsentAt ? `; first absent ${c.firstAbsentAt}` : "");
      // A safe candidate always has a ticket + firstAbsent (the helper requires
      // both); guard defensively so we never widen the CAS to a null match.
      if (evaluatedFirstAbsent == null || !c.brokerTicket) continue;
      try {
        // CAS guard: only stamp a row that is STILL open + unreconciled AND whose
        // absence evidence is UNCHANGED since evaluation — same ticket, same
        // first-absent timestamp, same bridge, still over the required absence
        // count. A re-appeared position (count→0, firstAbsent→null) or a new
        // absence cycle (different firstAbsent) fails the match and is skipped,
        // so we never close a position the broker re-confirmed open.
        const stamped = await db.update(arxLivePositionsTable).set({
          closedAt: closeAt,
          reconcileState: "RECONCILED_BROKER_ABSENT",
          reconcileReason,
          reconciledAt: now,
          lastSyncedAt: now,
        }).where(and(
          eq(arxLivePositionsTable.id, positionId),
          eq(arxLivePositionsTable.userId, args.userId),
          eq(arxLivePositionsTable.bridgeConnectionId, bridgeConnectionId),
          eq(arxLivePositionsTable.brokerTicket, c.brokerTicket),
          eq(arxLivePositionsTable.firstBrokerAbsentAt, evaluatedFirstAbsent),
          gte(arxLivePositionsTable.brokerAbsentSnapshotCount, policy.requiredReliableAbsences),
          isNull(arxLivePositionsTable.closedAt),
          isNull(arxLivePositionsTable.reconcileState),
        )).returning({ id: arxLivePositionsTable.id });
        if (stamped.length === 0) continue; // lost the race — leave as-is
        stampedCount += 1;
        c.candidateState = "auto_reconciled_broker_absent";
        await db.insert(liveTradingAuditTable).values({
          eventId: randomUUID(),
          eventType: "BROKER_SIDE_CLOSE_RECONCILED",
          severity: "HIGH",
          mode: "READ_ONLY",
          symbol: c.symbol,
          actorRole: "system",
          message:
            `Broker-side close reconciled for position ${positionId} ` +
            `(ticket ${c.brokerTicket ?? "?"}, ${c.symbol}): ${reconcileReason}`,
          metadata: {
            source: "broker_absence_reconciler",
            actor: "system",
            userId: args.userId,
            positionId,
            bridgeConnectionId: c.bridgeConnectionId ?? null,
            brokerTicket: c.brokerTicket ?? null,
            mt5PositionTicket: c.mt5PositionTicket ?? null,
            symbol: c.symbol,
            absentSnapshotCount: c.absentSnapshotCount,
            firstAbsentAt: c.firstAbsentAt ?? null,
            lastAbsentAt: c.lastAbsentAt ?? null,
            lastReliableSnapshotAt: c.lastReliableSnapshotAt ?? null,
            reconcileState: "RECONCILED_BROKER_ABSENT",
            estimatedCloseTime: true,
            closedAt: closeAt.toISOString(),
          },
        });
      } catch (err) {
        logger.error({
          event: "BROKER_ABSENCE_RECONCILE_STAMP_FAILED",
          userId: args.userId, positionId,
          error: err instanceof Error ? err.message : String(err),
        }, "broker-absence reconcile stamp failed");
      }
    }
  }

  return {
    enabled: policy.enabled,
    dryRun,
    snapshotReliable,
    scope: { userId: args.userId, bridgeConnectionId },
    candidateCount: candidates.length,
    safeToStampCount: safe.length,
    blockedCount: candidates.filter((c) => !c.safeToStampClosed).length,
    stampedCount,
    blockedReasons,
    candidateStates,
    oldestCandidateAgeMs,
    candidates,
  };
}
