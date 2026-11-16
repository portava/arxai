// qaBrokerAbsenceReconcile.ts — pure-logic QA for the Broker-Side Close
// Reconciliation Guardrail. NO database: exercises the pure decision surface
// (nextAbsenceEvidence, findBrokerAbsentGhostPositionIds, chooseReconciledCloseAt)
// so the safety rules are verifiable offline and deterministically.
//
// HARD RULES under test:
//   • Never stamp on a single missing snapshot (need N consecutive reliable).
//   • Never stamp before the minimum first-absence age (anti-flap).
//   • Never stamp from an unreliable or partial sweep.
//   • Never cross user/bridge isolation.
//   • Never race a pending ARX-initiated close.
//   • Reset evidence the moment the position reappears.

import {
  nextAbsenceEvidence,
  findBrokerAbsentGhostPositionIds,
  chooseReconciledCloseAt,
  type AbsenceEvidenceState,
  type BrokerAbsentCandidateRow,
  type BrokerAbsenceEvalContext,
} from "../../artifacts/api-server/src/lib/live/brokerAbsenceReconcile.js";
import { brokerAbsenceAutoReconcilePolicy } from "../../artifacts/api-server/src/lib/live/brokerAbsencePolicy.js";

type Probe = { n: number; name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(n: number, name: string, pass: boolean, note: string): void {
  results.push({ n, name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${String(n).padStart(2, " ")}. ${name} — ${note}`);
}

const NOW = new Date("2026-06-07T12:00:00.000Z");
const policy = brokerAbsenceAutoReconcilePolicy; // requiredReliableAbsences:3, minimumAbsentAgeMs:120000

const ZERO: AbsenceEvidenceState = {
  brokerAbsentSnapshotCount: 0,
  firstBrokerAbsentAt: null,
  lastBrokerAbsentAt: null,
  lastReliableSnapshotAt: null,
};

// A fully stamp-eligible row: ticketed, 3 absences, first absent 5 min ago.
function eligibleRow(over: Partial<BrokerAbsentCandidateRow> = {}): BrokerAbsentCandidateRow {
  return {
    positionId: 1,
    userId: 100,
    bridgeConnectionId: 7,
    brokerTicket: "T-1",
    symbol: "EURUSD",
    closedAt: null,
    reconcileState: null,
    brokerAbsentSnapshotCount: 3,
    firstBrokerAbsentAt: new Date(NOW.getTime() - 5 * 60_000),
    lastBrokerAbsentAt: new Date(NOW.getTime() - 5_000),
    lastReliableSnapshotAt: new Date(NOW.getTime() - 5_000),
    sourceCommandId: null,
    ...over,
  };
}

function baseCtx(over: Partial<BrokerAbsenceEvalContext> = {}): BrokerAbsenceEvalContext {
  return {
    now: NOW.getTime(),
    policy,
    scope: { userId: 100, bridgeConnectionId: 7 },
    pendingCloseTickets: new Set<string>(),
    snapshotReliable: true,
    snapshotComplete: true,
    ...over,
  };
}

function evalOne(row: BrokerAbsentCandidateRow, ctx: BrokerAbsenceEvalContext) {
  return findBrokerAbsentGhostPositionIds([row], ctx)[0]!;
}

// ── 1. Absent in a reliable complete sweep increments + stamps firstAbsent ──
{
  const next = nextAbsenceEvidence(ZERO, { presentInSnapshot: false, snapshotReliable: true, snapshotComplete: true, now: NOW });
  record(1, "absence increments evidence",
    next.brokerAbsentSnapshotCount === 1 && next.firstBrokerAbsentAt?.getTime() === NOW.getTime() && next.lastBrokerAbsentAt?.getTime() === NOW.getTime(),
    `count=${next.brokerAbsentSnapshotCount} first=${next.firstBrokerAbsentAt?.toISOString()}`);
}

// ── 2. firstAbsent preserved across consecutive absences ──
{
  const first = new Date(NOW.getTime() - 60_000);
  const prev: AbsenceEvidenceState = { brokerAbsentSnapshotCount: 2, firstBrokerAbsentAt: first, lastBrokerAbsentAt: first, lastReliableSnapshotAt: first };
  const next = nextAbsenceEvidence(prev, { presentInSnapshot: false, snapshotReliable: true, snapshotComplete: true, now: NOW });
  record(2, "firstAbsent preserved on repeat absence",
    next.brokerAbsentSnapshotCount === 3 && next.firstBrokerAbsentAt?.getTime() === first.getTime(),
    `count=${next.brokerAbsentSnapshotCount} first=${next.firstBrokerAbsentAt?.toISOString()}`);
}

// ── 3. Reappearance resets evidence to zero ──
{
  const prev: AbsenceEvidenceState = { brokerAbsentSnapshotCount: 5, firstBrokerAbsentAt: NOW, lastBrokerAbsentAt: NOW, lastReliableSnapshotAt: NOW };
  const next = nextAbsenceEvidence(prev, { presentInSnapshot: true, snapshotReliable: true, snapshotComplete: true, now: NOW });
  record(3, "reappearance resets evidence",
    next.brokerAbsentSnapshotCount === 0 && next.firstBrokerAbsentAt === null && next.lastReliableSnapshotAt?.getTime() === NOW.getTime(),
    `count=${next.brokerAbsentSnapshotCount}`);
}

// ── 4. Unreliable/partial sweep resets evidence (untrusted, not evidence) ──
{
  const prev: AbsenceEvidenceState = { brokerAbsentSnapshotCount: 5, firstBrokerAbsentAt: NOW, lastBrokerAbsentAt: NOW, lastReliableSnapshotAt: NOW };
  const unreliable = nextAbsenceEvidence(prev, { presentInSnapshot: false, snapshotReliable: false, snapshotComplete: true, now: NOW });
  const partial = nextAbsenceEvidence(prev, { presentInSnapshot: false, snapshotReliable: true, snapshotComplete: false, now: NOW });
  record(4, "unreliable/partial sweep resets evidence",
    unreliable.brokerAbsentSnapshotCount === 0 && partial.brokerAbsentSnapshotCount === 0,
    `unreliable=${unreliable.brokerAbsentSnapshotCount} partial=${partial.brokerAbsentSnapshotCount}`);
}

// ── 5. Fully-eligible row is safe to stamp ──
{
  const c = evalOne(eligibleRow(), baseCtx());
  record(5, "fully-eligible row safeToStampClosed",
    c.safeToStampClosed === true && c.candidateState === "eligible_for_broker_absence_reconcile" && !c.blockedReason,
    `state=${c.candidateState}`);
}

// ── 6. Single missing snapshot (count<N) is NOT stampable ──
{
  const c = evalOne(eligibleRow({ brokerAbsentSnapshotCount: 1 }), baseCtx());
  record(6, "single absence not stampable",
    c.safeToStampClosed === false && c.blockedReason === "ACCUMULATING_ABSENCE_EVIDENCE" && c.candidateState === "accumulating_absence_evidence",
    `blocked=${c.blockedReason}`);
}

// ── 7. Absence window too young is NOT stampable (anti-flap) ──
{
  const c = evalOne(eligibleRow({ firstBrokerAbsentAt: new Date(NOW.getTime() - 30_000) }), baseCtx());
  record(7, "young absence window blocked",
    c.safeToStampClosed === false && c.blockedReason === "ABSENCE_WINDOW_TOO_YOUNG",
    `blocked=${c.blockedReason}`);
}

// ── 8. Unreliable current snapshot blocks every row ──
{
  const c = evalOne(eligibleRow(), baseCtx({ snapshotReliable: false }));
  record(8, "unreliable snapshot blocks stamping",
    c.safeToStampClosed === false && c.blockedReason === "SNAPSHOT_UNRELIABLE" && c.candidateState === "blocked_due_to_unreliable_snapshot",
    `blocked=${c.blockedReason}`);
}

// ── 9. Incomplete sweep blocks (requireCompleteSnapshot) ──
{
  const c = evalOne(eligibleRow(), baseCtx({ snapshotComplete: false }));
  record(9, "incomplete sweep blocks stamping",
    c.safeToStampClosed === false && c.blockedReason === "SNAPSHOT_INCOMPLETE",
    `blocked=${c.blockedReason}`);
}

// ── 10. Pending ARX close never raced ──
{
  const c = evalOne(eligibleRow(), baseCtx({ pendingCloseTickets: new Set(["T-1"]) }));
  record(10, "pending ARX close blocks stamping",
    c.safeToStampClosed === false && c.blockedReason === "PENDING_ARX_CLOSE" && c.candidateState === "blocked_due_to_pending_arx_close",
    `blocked=${c.blockedReason}`);
}

// ── 11. Cross-user / cross-bridge / no-ticket isolation blocks ──
{
  const crossUser = evalOne(eligibleRow({ userId: 999 }), baseCtx());
  const crossBridge = evalOne(eligibleRow({ bridgeConnectionId: 999 }), baseCtx());
  const noTicket = evalOne(eligibleRow({ brokerTicket: null }), baseCtx());
  record(11, "isolation + mapping-uncertain block",
    crossUser.blockedReason === "CROSS_USER_MISMATCH" &&
    crossBridge.blockedReason === "CROSS_BRIDGE_MISMATCH" &&
    noTicket.blockedReason === "MAPPING_UNCERTAIN_NO_TICKET" &&
    [crossUser, crossBridge, noTicket].every((c) => c.safeToStampClosed === false),
    `${crossUser.blockedReason}/${crossBridge.blockedReason}/${noTicket.blockedReason}`);
}

// ── 12. closed/reconciled rows are not fresh candidates; close-at lower bound ──
{
  const alreadyClosed = findBrokerAbsentGhostPositionIds([eligibleRow({ closedAt: NOW })], baseCtx());
  const alreadyReconciled = evalOne(eligibleRow({ reconcileState: "RECONCILED_BROKER_ABSENT" }), baseCtx());
  const first = new Date(NOW.getTime() - 5 * 60_000);
  const chosen = chooseReconciledCloseAt({ firstBrokerAbsentAt: first, lastBrokerAbsentAt: NOW, lastReliableSnapshotAt: NOW }, NOW);
  const fallback = chooseReconciledCloseAt({ firstBrokerAbsentAt: null, lastBrokerAbsentAt: null, lastReliableSnapshotAt: null }, NOW);
  record(12, "closed skipped, reconciled flagged, closeAt prefers firstAbsent",
    alreadyClosed.length === 0 &&
    alreadyReconciled.safeToStampClosed === false && alreadyReconciled.blockedReason === "ALREADY_RECONCILED" &&
    chosen.getTime() === first.getTime() && fallback.getTime() === NOW.getTime(),
    `closeAt=${chosen.toISOString()}`);
}

const failed = results.filter((r) => !r.pass);
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`FAILED: ${failed.map((f) => `#${f.n} ${f.name}`).join(", ")}`);
  process.exit(1);
}
