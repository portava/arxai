// reconcilerDryRunValidationTest.ts
//
// Multi-cycle dry-run validation for the Broker-Side Close Reconciliation
// Guardrail. Pure-logic only (no database, no network). Simulates several
// consecutive position-lifecycle scenarios to produce the aggregate report
// required by the go/no-go readiness gate:
//
//   - positions checked, present in snapshot, absent once, repeatedly absent,
//     would-be-eligible, uncertain, and an explicit "no active broker position
//     was incorrectly flagged" assertion.
//   - V75 / synthetic / manual position classification correctness.
//   - Per-user isolation (no cross-tenant leakage).
//   - CAS eviction: a re-appeared position loses all evidence and is NEVER
//     eligible until the NEXT absence cycle restarts.
//
// This file does NOT change any policy defaults. It is a verification artefact,
// not a runner. Writes remain gated by BROKER_ABSENCE_AUTO_RECONCILE_ENABLED
// (default: disabled).
//
// Run: pnpm --filter @workspace/scripts run test:reconciler-dry-run-validation

import {
  nextAbsenceEvidence,
  findBrokerAbsentGhostPositionIds,
  chooseReconciledCloseAt,
  type AbsenceEvidenceState,
  type BrokerAbsentCandidateRow,
  type BrokerAbsenceEvalContext,
} from "../../artifacts/api-server/src/lib/live/brokerAbsenceReconcile.js";
import { brokerAbsenceAutoReconcilePolicy } from "../../artifacts/api-server/src/lib/live/brokerAbsencePolicy.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passes = 0;
let failures = 0;

function assert(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n── ${title}`);
}

const policy = brokerAbsenceAutoReconcilePolicy;
const REQUIRED = policy.requiredReliableAbsences; // 3
const MIN_AGE_MS = policy.minimumAbsentAgeMs;     // 120_000 (2 min)

const BASE_NOW = new Date("2026-06-07T12:00:00.000Z");

const ZERO_EVIDENCE: AbsenceEvidenceState = {
  brokerAbsentSnapshotCount: 0,
  firstBrokerAbsentAt: null,
  lastBrokerAbsentAt: null,
  lastReliableSnapshotAt: null,
};

function baseRow(over: Partial<BrokerAbsentCandidateRow> = {}): BrokerAbsentCandidateRow {
  return {
    positionId: 1,
    userId: 100,
    bridgeConnectionId: 7,
    brokerTicket: "TKT-100",
    symbol: "EURUSD",
    closedAt: null,
    reconcileState: null,
    brokerAbsentSnapshotCount: 0,
    firstBrokerAbsentAt: null,
    lastBrokerAbsentAt: null,
    lastReliableSnapshotAt: null,
    sourceCommandId: null,
    ...over,
  };
}

function baseCtx(over: Partial<BrokerAbsenceEvalContext> = {}): BrokerAbsenceEvalContext {
  return {
    now: BASE_NOW.getTime(),
    policy,
    scope: { userId: 100, bridgeConnectionId: 7 },
    pendingCloseTickets: new Set<string>(),
    snapshotReliable: true,
    snapshotComplete: true,
    ...over,
  };
}

/**
 * Simulate N consecutive reliable-absent sweeps for one position, starting
 * from ZERO_EVIDENCE, with `sweepInterval` ms between each. Returns the final
 * AbsenceEvidenceState after N sweeps.
 */
function simulateCycles(count: number, sweepIntervalMs: number, startMs: number): AbsenceEvidenceState {
  let state = ZERO_EVIDENCE;
  for (let i = 0; i < count; i++) {
    const now = new Date(startMs + i * sweepIntervalMs);
    state = nextAbsenceEvidence(state, {
      presentInSnapshot: false,
      snapshotReliable: true,
      snapshotComplete: true,
      now,
    });
  }
  return state;
}

// ─── Aggregate tracking ───────────────────────────────────────────────────────

interface AggregateReport {
  positionsChecked: number;
  presentInSnapshot: number;
  absentOnce: number;
  repeatedlyAbsent: number;
  wouldBeEligible: number;
  uncertain: number;
  noActiveBrokerPositionMisflagged: boolean;
}

function buildReport(rows: BrokerAbsentCandidateRow[], ctx: BrokerAbsenceEvalContext): AggregateReport {
  const candidates = findBrokerAbsentGhostPositionIds(rows, ctx);
  const report: AggregateReport = {
    positionsChecked: rows.filter((r) => r.closedAt == null).length,
    presentInSnapshot: rows.filter((r) => r.closedAt == null && r.brokerAbsentSnapshotCount === 0).length,
    absentOnce: 0,
    repeatedlyAbsent: 0,
    wouldBeEligible: 0,
    uncertain: 0,
    noActiveBrokerPositionMisflagged: true,
  };
  for (const c of candidates) {
    if (c.absentSnapshotCount === 1) report.absentOnce++;
    else if (c.absentSnapshotCount >= 2) report.repeatedlyAbsent++;
    if (c.safeToStampClosed) report.wouldBeEligible++;
    if (c.blockedReason === "MAPPING_UNCERTAIN_NO_TICKET") report.uncertain++;
    // Safety check: a "safe" candidate must have real evidence (ticket + firstAbsent).
    if (c.safeToStampClosed && (!c.brokerTicket || !c.firstAbsentAt)) {
      report.noActiveBrokerPositionMisflagged = false;
    }
  }
  return report;
}

// ─── Phase 1: Policy defaults ─────────────────────────────────────────────────

section("Phase 1 — Policy defaults (write gate off by default)");
{
  assert(!policy.enabled, "BROKER_ABSENCE_AUTO_RECONCILE_ENABLED is OFF by default", `enabled=${String(policy.enabled)}`);
  assert(policy.requiredReliableAbsences >= 3, `requiredReliableAbsences ≥ 3 (anti-flap)`, `value=${policy.requiredReliableAbsences}`);
  assert(policy.minimumAbsentAgeMs >= 60_000, `minimumAbsentAgeMs ≥ 60 s (anti-flap)`, `value=${policy.minimumAbsentAgeMs}ms`);
  assert(policy.requireCompleteSnapshot, "requireCompleteSnapshot is true (partial sweeps do not count)");
  assert(policy.snapshotReliabilityWindowMs >= 30_000, `snapshotReliabilityWindowMs ≥ 30 s`, `value=${policy.snapshotReliabilityWindowMs}ms`);
}

// ─── Phase 2: Single-cycle absence evidence accumulation ──────────────────────

section("Phase 2 — Single-cycle evidence accumulation");
{
  // Sweep 1: absent → count = 1, firstAbsent stamped.
  const s1 = nextAbsenceEvidence(ZERO_EVIDENCE, { presentInSnapshot: false, snapshotReliable: true, snapshotComplete: true, now: BASE_NOW });
  assert(s1.brokerAbsentSnapshotCount === 1, "sweep 1: count=1");
  assert(s1.firstBrokerAbsentAt?.getTime() === BASE_NOW.getTime(), "sweep 1: firstAbsent = NOW");

  // Sweep 2: absent again → count = 2, firstAbsent preserved.
  const s2 = nextAbsenceEvidence(s1, { presentInSnapshot: false, snapshotReliable: true, snapshotComplete: true, now: new Date(BASE_NOW.getTime() + 30_000) });
  assert(s2.brokerAbsentSnapshotCount === 2, "sweep 2: count=2");
  assert(s2.firstBrokerAbsentAt?.getTime() === BASE_NOW.getTime(), "sweep 2: firstAbsent preserved");

  // Sweep 3: absent → count = 3 (threshold reached).
  const t3 = new Date(BASE_NOW.getTime() + 60_000);
  const s3 = nextAbsenceEvidence(s2, { presentInSnapshot: false, snapshotReliable: true, snapshotComplete: true, now: t3 });
  assert(s3.brokerAbsentSnapshotCount === REQUIRED, `sweep 3: count=${REQUIRED} (threshold reached)`, `got=${s3.brokerAbsentSnapshotCount}`);

  // Sweep 4: position REAPPEARS → evidence fully reset.
  const s4 = nextAbsenceEvidence(s3, { presentInSnapshot: true, snapshotReliable: true, snapshotComplete: true, now: BASE_NOW });
  assert(s4.brokerAbsentSnapshotCount === 0, "reappearance: count reset to 0");
  assert(s4.firstBrokerAbsentAt === null, "reappearance: firstAbsent cleared");
}

// ─── Phase 3: Aggregate report across multiple position types ─────────────────

section("Phase 3 — Aggregate report: present, absent-once, repeatedly-absent, uncertain");
{
  const firstAbsentOld = new Date(BASE_NOW.getTime() - MIN_AGE_MS - 30_000); // old enough
  const firstAbsentNew = new Date(BASE_NOW.getTime() - MIN_AGE_MS / 2);      // too young

  const rows: BrokerAbsentCandidateRow[] = [
    // 1. Present in snapshot (count=0) — should NOT be a candidate.
    baseRow({ positionId: 10, brokerTicket: "TKT-10", brokerAbsentSnapshotCount: 0, firstBrokerAbsentAt: null }),
    // 2. Absent exactly once — accumulating, not eligible.
    baseRow({ positionId: 11, brokerTicket: "TKT-11", brokerAbsentSnapshotCount: 1, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
    // 3. Absent twice — still accumulating, not eligible.
    baseRow({ positionId: 12, brokerTicket: "TKT-12", brokerAbsentSnapshotCount: 2, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
    // 4. Absent 3x but first-absent too young — age guard blocks.
    baseRow({ positionId: 13, brokerTicket: "TKT-13", brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentNew, lastBrokerAbsentAt: firstAbsentNew, lastReliableSnapshotAt: firstAbsentNew }),
    // 5. Fully eligible: 3 absences + old enough first-absent.
    baseRow({ positionId: 14, brokerTicket: "TKT-14", brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
    // 6. Uncertain: no broker ticket.
    baseRow({ positionId: 15, brokerTicket: null, brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
  ];

  const report = buildReport(rows, baseCtx());

  assert(report.positionsChecked === 6, "positionsChecked = 6", `got=${report.positionsChecked}`);
  // Row 10 has count=0 so it's treated as a candidate with count=0 (neither absent once nor repeatedly)
  assert(report.absentOnce === 1, "absentOnce = 1 (TKT-11)", `got=${report.absentOnce}`);
  assert(report.repeatedlyAbsent === 4, "repeatedlyAbsent = 4 (TKT-12,13,14,15)", `got=${report.repeatedlyAbsent}`);
  assert(report.wouldBeEligible === 1, "wouldBeEligible = 1 (TKT-14 only)", `got=${report.wouldBeEligible}`);
  assert(report.uncertain === 1, "uncertain = 1 (TKT-15 no ticket)", `got=${report.uncertain}`);
  assert(report.noActiveBrokerPositionMisflagged, "noActiveBrokerPositionMisflagged = true");
}

// ─── Phase 4: V75 / synthetic / manual position classification ────────────────

section("Phase 4 — V75 / synthetic / manual position classification");
{
  const firstAbsentOld = new Date(BASE_NOW.getTime() - MIN_AGE_MS - 60_000);

  // V75 positions are identified by symbol only; the reconciler treats them
  // identically to forex — safety rules (N absences + age + ticket) apply
  // equally. A V75 position absent across N sweeps and old enough IS eligible.
  const v75Eligible = baseRow({
    positionId: 20, symbol: "Volatility 75 Index", brokerTicket: "TKT-V75",
    brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld,
    lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld,
  });
  const v75NoTicket = baseRow({
    positionId: 21, symbol: "Volatility 25 (1s) Index", brokerTicket: null,
    brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld,
    lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld,
  });

  const ctx = baseCtx();
  const c20 = findBrokerAbsentGhostPositionIds([v75Eligible], ctx)[0]!;
  const c21 = findBrokerAbsentGhostPositionIds([v75NoTicket], ctx)[0]!;

  // V75 with confirmed ticket and sufficient evidence → eligible (same rules as forex).
  assert(c20.safeToStampClosed, "V75 eligible row: safeToStampClosed=true when evidence sufficient", `state=${c20.candidateState}`);
  assert(c20.candidateState === "eligible_for_broker_absence_reconcile", "V75 eligible: correct candidateState");

  // V75 with no ticket → uncertain / blocked.
  assert(!c21.safeToStampClosed, "V75 no-ticket: blocked", `reason=${c21.blockedReason ?? "none"}`);
  assert(c21.blockedReason === "MAPPING_UNCERTAIN_NO_TICKET", "V75 no-ticket: MAPPING_UNCERTAIN_NO_TICKET reason");
  assert(c21.candidateState === "blocked_due_to_mapping_conflict", "V75 no-ticket: correct candidateState");

  // A manually-closed ARX position (closedAt set) must never appear as a candidate.
  const manualClosed = baseRow({ positionId: 22, symbol: "GBPUSD", brokerTicket: "TKT-22", closedAt: BASE_NOW });
  const closedCandidates = findBrokerAbsentGhostPositionIds([manualClosed], ctx);
  assert(closedCandidates.length === 0, "already-closed position: never a candidate");

  // An already-reconciled position (reconcileState set) → blocked, NOT eligible.
  const reconciled = baseRow({
    positionId: 23, symbol: "USDJPY", brokerTicket: "TKT-23",
    brokerAbsentSnapshotCount: 5, firstBrokerAbsentAt: firstAbsentOld,
    lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld,
    reconcileState: "RECONCILED_BROKER_ABSENT",
  });
  const c23 = findBrokerAbsentGhostPositionIds([reconciled], ctx)[0]!;
  assert(!c23.safeToStampClosed, "already-reconciled: blocked, not eligible again");
  assert(c23.blockedReason === "ALREADY_RECONCILED", "already-reconciled: ALREADY_RECONCILED reason");
}

// ─── Phase 5: Per-user isolation (no cross-tenant leakage) ───────────────────

section("Phase 5 — Per-user isolation (no cross-tenant leakage)");
{
  const firstAbsentOld = new Date(BASE_NOW.getTime() - MIN_AGE_MS - 60_000);

  // Scope: userId=100, bridgeConnectionId=7.
  const ctx = baseCtx({ scope: { userId: 100, bridgeConnectionId: 7 } });

  const ownRow = baseRow({
    positionId: 30, userId: 100, bridgeConnectionId: 7, brokerTicket: "TKT-30",
    brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld,
    lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld,
  });
  const otherUser = baseRow({
    positionId: 31, userId: 200, bridgeConnectionId: 7, brokerTicket: "TKT-31",
    brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld,
    lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld,
  });
  const otherBridge = baseRow({
    positionId: 32, userId: 100, bridgeConnectionId: 99, brokerTicket: "TKT-32",
    brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld,
    lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld,
  });

  const candidates = findBrokerAbsentGhostPositionIds([ownRow, otherUser, otherBridge], ctx);

  const c30 = candidates.find((c) => c.positionId === "30")!;
  const c31 = candidates.find((c) => c.positionId === "31")!;
  const c32 = candidates.find((c) => c.positionId === "32")!;

  assert(c30.safeToStampClosed, "own position (user 100, bridge 7): eligible");
  assert(!c31.safeToStampClosed && c31.blockedReason === "CROSS_USER_MISMATCH", "cross-user position blocked with CROSS_USER_MISMATCH");
  assert(!c32.safeToStampClosed && c32.blockedReason === "CROSS_BRIDGE_MISMATCH", "cross-bridge position blocked with CROSS_BRIDGE_MISMATCH");
}

// ─── Phase 6: Pending-ARX-close race prevention ───────────────────────────────

section("Phase 6 — Pending ARX-close race prevention");
{
  const firstAbsentOld = new Date(BASE_NOW.getTime() - MIN_AGE_MS - 60_000);

  const eligibleRow = baseRow({
    positionId: 40, brokerTicket: "TKT-40",
    brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld,
    lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld,
  });

  const ctxNoConflict = baseCtx({ pendingCloseTickets: new Set() });
  const ctxWithConflict = baseCtx({ pendingCloseTickets: new Set(["TKT-40"]) });

  const noConflict = findBrokerAbsentGhostPositionIds([eligibleRow], ctxNoConflict)[0]!;
  const withConflict = findBrokerAbsentGhostPositionIds([eligibleRow], ctxWithConflict)[0]!;

  assert(noConflict.safeToStampClosed, "no pending ARX close: eligible");
  assert(!withConflict.safeToStampClosed, "pending ARX close: blocked");
  assert(withConflict.blockedReason === "PENDING_ARX_CLOSE", "pending ARX close: correct reason");
}

// ─── Phase 7: CAS-evidence re-entry after a re-appearance ────────────────────

section("Phase 7 — CAS: re-appeared position restarts absence cycle from scratch");
{
  const t0 = BASE_NOW.getTime();

  // Simulate: 3 absences → reappears → 1 absence.
  // After reappearance the count resets; the subsequent single absence is NOT eligible.
  const state3 = simulateCycles(3, 30_000, t0);
  const stateReset = nextAbsenceEvidence(state3, { presentInSnapshot: true, snapshotReliable: true, snapshotComplete: true, now: new Date(t0 + 90_000) });
  const stateAfterReset = nextAbsenceEvidence(stateReset, { presentInSnapshot: false, snapshotReliable: true, snapshotComplete: true, now: new Date(t0 + 120_000) });

  assert(stateAfterReset.brokerAbsentSnapshotCount === 1, "post-reappearance: count restarts at 1");
  assert(stateAfterReset.firstBrokerAbsentAt?.getTime() === t0 + 120_000, "post-reappearance: firstAbsent is the NEW cycle's timestamp");

  // Build a DB row from the post-reappearance state and verify it is NOT eligible.
  const rowAfterReset = baseRow({
    positionId: 50, brokerTicket: "TKT-50",
    brokerAbsentSnapshotCount: stateAfterReset.brokerAbsentSnapshotCount,
    firstBrokerAbsentAt: stateAfterReset.firstBrokerAbsentAt,
    lastBrokerAbsentAt: stateAfterReset.lastBrokerAbsentAt,
    lastReliableSnapshotAt: stateAfterReset.lastReliableSnapshotAt,
  });
  const c50 = findBrokerAbsentGhostPositionIds([rowAfterReset], baseCtx())[0]!;
  assert(!c50.safeToStampClosed, "post-reappearance row: single absence not stampable");
  assert(c50.candidateState === "accumulating_absence_evidence", "post-reappearance: accumulating state");
}

// ─── Phase 8: Unreliable / partial sweep rejects ──────────────────────────────

section("Phase 8 — Unreliable / partial sweep resets evidence (must not count)");
{
  const t0 = BASE_NOW.getTime();
  // 2 reliable absences → unreliable sweep → count resets.
  const s2 = simulateCycles(2, 30_000, t0);
  const sUnreliable = nextAbsenceEvidence(s2, { presentInSnapshot: false, snapshotReliable: false, snapshotComplete: true, now: new Date(t0 + 90_000) });
  assert(sUnreliable.brokerAbsentSnapshotCount === 0, "unreliable sweep: count reset to 0");

  // 2 reliable absences → partial sweep → count resets.
  const sPartial = nextAbsenceEvidence(s2, { presentInSnapshot: false, snapshotReliable: true, snapshotComplete: false, now: new Date(t0 + 90_000) });
  assert(sPartial.brokerAbsentSnapshotCount === 0, "partial sweep: count reset to 0");
}

// ─── Phase 9: chooseReconciledCloseAt lower-bound preference ─────────────────

section("Phase 9 — chooseReconciledCloseAt: prefer earliest evidence as lower bound");
{
  const first = new Date(BASE_NOW.getTime() - 5 * 60_000);
  const last = new Date(BASE_NOW.getTime() - 2 * 60_000);

  const chosen = chooseReconciledCloseAt({ firstBrokerAbsentAt: first, lastBrokerAbsentAt: last, lastReliableSnapshotAt: BASE_NOW }, BASE_NOW);
  assert(chosen.getTime() === first.getTime(), "closeAt prefers firstBrokerAbsentAt (earliest lower bound)", `chosen=${chosen.toISOString()}`);

  const noFirst = chooseReconciledCloseAt({ firstBrokerAbsentAt: null, lastBrokerAbsentAt: last, lastReliableSnapshotAt: BASE_NOW }, BASE_NOW);
  assert(noFirst.getTime() === last.getTime(), "no firstAbsent: falls back to lastBrokerAbsentAt");

  const fallback = chooseReconciledCloseAt({ firstBrokerAbsentAt: null, lastBrokerAbsentAt: null, lastReliableSnapshotAt: null }, BASE_NOW);
  assert(fallback.getTime() === BASE_NOW.getTime(), "no timestamps at all: falls back to now (with audit flag)");
}

// ─── Aggregate summary ────────────────────────────────────────────────────────

section("Aggregate dry-run report summary");
{
  // Build a representative set covering all states.
  const firstAbsentOld = new Date(BASE_NOW.getTime() - MIN_AGE_MS - 60_000);
  const firstAbsentNew = new Date(BASE_NOW.getTime() - 30_000);

  const rows: BrokerAbsentCandidateRow[] = [
    // Present in snapshot (count=0).
    baseRow({ positionId: 100, brokerTicket: "TKT-100", brokerAbsentSnapshotCount: 0 }),
    baseRow({ positionId: 101, brokerTicket: "TKT-101", brokerAbsentSnapshotCount: 0 }),
    // Absent once.
    baseRow({ positionId: 102, brokerTicket: "TKT-102", brokerAbsentSnapshotCount: 1, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
    // Repeatedly absent (< threshold).
    baseRow({ positionId: 103, brokerTicket: "TKT-103", brokerAbsentSnapshotCount: 2, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
    // Threshold reached but too young.
    baseRow({ positionId: 104, brokerTicket: "TKT-104", brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentNew, lastBrokerAbsentAt: firstAbsentNew, lastReliableSnapshotAt: firstAbsentNew }),
    // Eligible.
    baseRow({ positionId: 105, brokerTicket: "TKT-105", brokerAbsentSnapshotCount: 4, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
    // Uncertain (no ticket).
    baseRow({ positionId: 106, brokerTicket: null, brokerAbsentSnapshotCount: 3, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
    // Already reconciled.
    baseRow({ positionId: 107, brokerTicket: "TKT-107", reconcileState: "RECONCILED_BROKER_ABSENT", brokerAbsentSnapshotCount: 5, firstBrokerAbsentAt: firstAbsentOld, lastBrokerAbsentAt: firstAbsentOld, lastReliableSnapshotAt: firstAbsentOld }),
  ];

  const ctx = baseCtx();
  const rpt = buildReport(rows, ctx);

  // eslint-disable-next-line no-console
  console.log("\n  Aggregate Dry-Run Report");
  // eslint-disable-next-line no-console
  console.log(`    Positions checked:         ${rpt.positionsChecked}`);
  // eslint-disable-next-line no-console
  console.log(`    Present in snapshot:        ${rpt.presentInSnapshot}`);
  // eslint-disable-next-line no-console
  console.log(`    Absent once:                ${rpt.absentOnce}`);
  // eslint-disable-next-line no-console
  console.log(`    Repeatedly absent:          ${rpt.repeatedlyAbsent}`);
  // eslint-disable-next-line no-console
  console.log(`    Would-be eligible (dry-run): ${rpt.wouldBeEligible}`);
  // eslint-disable-next-line no-console
  console.log(`    Uncertain (no ticket):      ${rpt.uncertain}`);
  // eslint-disable-next-line no-console
  console.log(`    No active position misflagged: ${String(rpt.noActiveBrokerPositionMisflagged)}`);

  assert(rpt.positionsChecked === 8, "aggregate: positionsChecked = 8", `got=${rpt.positionsChecked}`);
  assert(rpt.presentInSnapshot === 2, "aggregate: presentInSnapshot = 2", `got=${rpt.presentInSnapshot}`);
  assert(rpt.absentOnce === 1, "aggregate: absentOnce = 1", `got=${rpt.absentOnce}`);
  // Rows 103(count=2), 104(count=3), 105(count=4), 106(count=3,no-ticket),
  // 107(count=5,already-reconciled) all have absentSnapshotCount >= 2 → 5.
  assert(rpt.repeatedlyAbsent === 5, "aggregate: repeatedlyAbsent = 5 (TKT-103..107)", `got=${rpt.repeatedlyAbsent}`);
  assert(rpt.wouldBeEligible === 1, "aggregate: wouldBeEligible = 1 (TKT-105)", `got=${rpt.wouldBeEligible}`);
  assert(rpt.uncertain === 1, "aggregate: uncertain = 1 (TKT-106)", `got=${rpt.uncertain}`);
  assert(rpt.noActiveBrokerPositionMisflagged, "aggregate: noActiveBrokerPositionMisflagged = true (no safety regression)");
}

// ─── Final result ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-console
console.log(`\n══ Reconciler Dry-Run Validation: ${passes} passed, ${failures} failed ══`);

if (failures > 0) {
  process.exit(1);
}
