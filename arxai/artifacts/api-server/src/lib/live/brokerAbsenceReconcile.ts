// Broker-Side Close Reconciliation Guardrail — PURE helpers (no DB access).
//
// These functions hold ALL of the safety logic for converting "a live position
// is absent from the broker's reliable complete snapshots" into "it is safe to
// stamp closed_at + reconcileState=RECONCILED_BROKER_ABSENT". They are pure so
// they can be unit-tested offline without a database and so the DB runner has a
// single, auditable decision surface.
//
// HARD RULES encoded here:
//   • Never stamp on a single missing snapshot — require N consecutive reliable
//     absences AND a minimum first-absence age.
//   • Never stamp from an unreliable or partial sweep.
//   • Never cross user/bridge isolation.
//   • Never race a pending ARX-initiated close.
//   • Never touch the broker — this only mirrors closes the broker already made.

import type { BrokerAbsenceReconcilePolicy } from "./brokerAbsencePolicy.js";

// --- Consecutive-absence evidence state (one per arx_live_positions row) ---

export interface AbsenceEvidenceState {
  brokerAbsentSnapshotCount: number;
  firstBrokerAbsentAt: Date | null;
  lastBrokerAbsentAt: Date | null;
  lastReliableSnapshotAt: Date | null;
}

/**
 * Compute the next absence-evidence state for ONE position given the latest
 * sweep. Pure + deterministic so the ingest path and tests share identical
 * semantics.
 *
 * Reset rules (Step 5):
 *   - position reappears in a reliable complete snapshot → reset to 0
 *   - snapshot is unreliable or partial → reset to 0 (untrusted, not evidence)
 * Accumulate rule:
 *   - absent in a reliable complete sweep → count + 1, stamp first/last absent
 */
export function nextAbsenceEvidence(
  prev: AbsenceEvidenceState,
  opts: { presentInSnapshot: boolean; snapshotReliable: boolean; snapshotComplete: boolean; now: Date },
): AbsenceEvidenceState {
  if (!opts.snapshotReliable || !opts.snapshotComplete) {
    return {
      brokerAbsentSnapshotCount: 0,
      firstBrokerAbsentAt: null,
      lastBrokerAbsentAt: null,
      lastReliableSnapshotAt: prev.lastReliableSnapshotAt,
    };
  }
  if (opts.presentInSnapshot) {
    return {
      brokerAbsentSnapshotCount: 0,
      firstBrokerAbsentAt: null,
      lastBrokerAbsentAt: null,
      lastReliableSnapshotAt: opts.now,
    };
  }
  return {
    brokerAbsentSnapshotCount: prev.brokerAbsentSnapshotCount + 1,
    firstBrokerAbsentAt: prev.firstBrokerAbsentAt ?? opts.now,
    lastBrokerAbsentAt: opts.now,
    lastReliableSnapshotAt: opts.now,
  };
}

// --- Candidate evaluation -------------------------------------------------

export interface BrokerAbsentCandidateRow {
  positionId: number;
  userId: number;
  bridgeConnectionId: number | null;
  brokerTicket: string | null;
  symbol: string;
  closedAt: Date | null;
  reconcileState: string | null;
  brokerAbsentSnapshotCount: number;
  firstBrokerAbsentAt: Date | null;
  lastBrokerAbsentAt: Date | null;
  lastReliableSnapshotAt: Date | null;
  sourceCommandId: string | null;
}

export type BrokerAbsenceCandidateState =
  | "alert_only"
  | "accumulating_absence_evidence"
  | "eligible_for_broker_absence_reconcile"
  | "auto_reconciled_broker_absent"
  | "blocked_due_to_unreliable_snapshot"
  | "blocked_due_to_mapping_conflict"
  | "blocked_due_to_pending_arx_close";

export interface BrokerAbsentGhostCandidate {
  positionId: string;
  userId: string;
  bridgeConnectionId?: string;
  brokerTicket?: string;
  mt5PositionTicket?: string;
  symbol: string;
  absentSnapshotCount: number;
  firstAbsentAt?: string;
  lastAbsentAt?: string;
  lastReliableSnapshotAt?: string;
  reason: "BROKER_CONFIRMED_ABSENT";
  safeToStampClosed: boolean;
  blockedReason?: string;
  candidateState: BrokerAbsenceCandidateState;
}

export interface BrokerAbsenceEvalContext {
  now: number;
  policy: BrokerAbsenceReconcilePolicy;
  /** The authenticated user/bridge scope this sweep belongs to. */
  scope: { userId: number; bridgeConnectionId: number | null };
  /** Broker tickets with a pending (non-terminal) ARX CLOSE command. */
  pendingCloseTickets: Set<string>;
  /** Latest snapshot marker recent enough to trust as current broker truth. */
  snapshotReliable: boolean;
  /** Latest sweep was a complete (not partial/degraded) position list. */
  snapshotComplete: boolean;
}

/**
 * Evaluate the user's open live-position rows against accumulated absence
 * evidence and return per-row candidates. Only rows with `safeToStampClosed`
 * may be stamped by the DB runner; everything else carries a blockedReason and
 * a reconciliation-center candidateState. Pure: no DB, no clock beyond ctx.now.
 */
export function findBrokerAbsentGhostPositionIds(
  rows: BrokerAbsentCandidateRow[],
  ctx: BrokerAbsenceEvalContext,
): BrokerAbsentGhostCandidate[] {
  const out: BrokerAbsentGhostCandidate[] = [];
  for (const r of rows) {
    // A row with closed_at already set is not a candidate at all.
    if (r.closedAt != null) continue;

    const base = {
      positionId: String(r.positionId),
      userId: String(r.userId),
      bridgeConnectionId: r.bridgeConnectionId != null ? String(r.bridgeConnectionId) : undefined,
      brokerTicket: r.brokerTicket ?? undefined,
      mt5PositionTicket: r.brokerTicket ?? undefined,
      symbol: r.symbol,
      absentSnapshotCount: r.brokerAbsentSnapshotCount,
      firstAbsentAt: r.firstBrokerAbsentAt?.toISOString(),
      lastAbsentAt: r.lastBrokerAbsentAt?.toISOString(),
      lastReliableSnapshotAt: r.lastReliableSnapshotAt?.toISOString(),
      reason: "BROKER_CONFIRMED_ABSENT" as const,
    };
    const blocked = (
      blockedReason: string,
      candidateState: BrokerAbsenceCandidateState,
    ): BrokerAbsentGhostCandidate => ({ ...base, safeToStampClosed: false, blockedReason, candidateState });

    // Already carries a reconcile state — not a fresh broker-absence candidate.
    if (r.reconcileState != null) {
      out.push(blocked(
        "ALREADY_RECONCILED",
        r.reconcileState === "RECONCILED_BROKER_ABSENT" ? "auto_reconciled_broker_absent" : "alert_only",
      ));
      continue;
    }
    // Current snapshot must be reliable + complete or we have no broker truth.
    if (!ctx.snapshotReliable) {
      out.push(blocked("SNAPSHOT_UNRELIABLE", "blocked_due_to_unreliable_snapshot"));
      continue;
    }
    if (ctx.policy.requireCompleteSnapshot && !ctx.snapshotComplete) {
      out.push(blocked("SNAPSHOT_INCOMPLETE", "blocked_due_to_unreliable_snapshot"));
      continue;
    }
    // Per-user / per-bridge isolation — never reconcile across owners.
    if (r.userId !== ctx.scope.userId) {
      out.push(blocked("CROSS_USER_MISMATCH", "blocked_due_to_mapping_conflict"));
      continue;
    }
    if (
      ctx.scope.bridgeConnectionId != null && r.bridgeConnectionId != null &&
      r.bridgeConnectionId !== ctx.scope.bridgeConnectionId
    ) {
      out.push(blocked("CROSS_BRIDGE_MISMATCH", "blocked_due_to_mapping_conflict"));
      continue;
    }
    // Ticket mapping must be certain.
    if (!r.brokerTicket) {
      out.push(blocked("MAPPING_UNCERTAIN_NO_TICKET", "blocked_due_to_mapping_conflict"));
      continue;
    }
    // Never race an in-flight ARX-initiated close.
    if (ctx.pendingCloseTickets.has(r.brokerTicket)) {
      out.push(blocked("PENDING_ARX_CLOSE", "blocked_due_to_pending_arx_close"));
      continue;
    }
    // Enough consecutive reliable absences?
    if (r.brokerAbsentSnapshotCount < ctx.policy.requiredReliableAbsences) {
      out.push(blocked("ACCUMULATING_ABSENCE_EVIDENCE", "accumulating_absence_evidence"));
      continue;
    }
    // First absence old enough (anti-flap)?
    if (r.firstBrokerAbsentAt == null) {
      out.push(blocked("NO_ABSENCE_TIMESTAMP", "accumulating_absence_evidence"));
      continue;
    }
    if (ctx.now - r.firstBrokerAbsentAt.getTime() < ctx.policy.minimumAbsentAgeMs) {
      out.push(blocked("ABSENCE_WINDOW_TOO_YOUNG", "accumulating_absence_evidence"));
      continue;
    }
    // All safety conditions satisfied.
    out.push({ ...base, safeToStampClosed: true, candidateState: "eligible_for_broker_absence_reconcile" });
  }
  return out;
}

/**
 * Pick the closed_at to stamp for a broker-absence reconciliation. We never
 * know the EXACT broker close time, so prefer the earliest evidence that the
 * position was gone (firstBrokerAbsentAt) as the closest defensible lower
 * bound, then last-absent, then the reliable snapshot time, then now. Callers
 * MUST flag this as an estimated time in audit metadata.
 */
export function chooseReconciledCloseAt(
  c: { firstBrokerAbsentAt: Date | null; lastBrokerAbsentAt: Date | null; lastReliableSnapshotAt: Date | null },
  now: Date,
): Date {
  return c.firstBrokerAbsentAt ?? c.lastBrokerAbsentAt ?? c.lastReliableSnapshotAt ?? now;
}
