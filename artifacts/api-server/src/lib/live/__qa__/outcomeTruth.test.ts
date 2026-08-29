// OUTCOME TRUTH — realised profit must not be biased upward.
//
// THE DEFECT
//   `recordMissionTradeClose` had exactly ONE runtime entrance: an ARX-issued
//   CLOSE_LIVE_POSITION command reaching LIVE_FILLED. Take-profit, trailing and
//   protective exits route through ARX and were recorded. A position closed by
//   its own STOP-LOSS *at the broker* never came back through that path, so its
//   loss was never recorded. Wins in, stop-loss losses out — mission "Realised
//   profit", "Peak realised", the target-locked badge and compounding all read
//   better than the truth.
//
// WHAT THIS SUITE PINS
//   1. A position closed at its STOP at the broker, with NO ARX close command,
//      produces a RECORDED LOSS (from the broker's own number).
//   2. A broker-side close with no numbers records the close with pnl NULL and a
//      typed UNRECONCILED reason — it NEVER invents a price or a P/L.
//   3. A mixed win/loss set does NOT lock the mission target while any outcome
//      is unrecorded or unreconciled.
//   4. The evidence bar for observing an absence is the same one the ACTION path
//      uses: a blocked candidate records nothing at all.
//
// Offline / pure: imports only IO-free modules, so it runs in the root `ci`
// lane, not the DB-backed integration lane.
//
// Run: pnpm --filter @workspace/api-server run test:outcome-truth

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  resolveBrokerCloseOutcome,
  planBrokerCloseRecordings,
  isBrokerReportedPnl,
  isBrokerReportedClosePrice,
  OUTCOME_UNRECONCILED_BROKER_ABSENT,
  OUTCOME_UNRECONCILED_NO_BROKER_PNL,
  BROKER_SIDE_EXIT_REASON,
} from "../brokerCloseOutcome.js";
import {
  findBrokerAbsentGhostPositionIds,
  type BrokerAbsentCandidateRow,
  type BrokerAbsenceEvalContext,
} from "../brokerAbsenceReconcile.js";
import {
  brokerCloseObservationPolicy,
  brokerAbsenceAutoReconcilePolicy,
} from "../brokerAbsencePolicy.js";
import {
  computeMissionOutcomeCompleteness,
  applyCompletenessToMilestone,
  TARGET_LOCK_HELD_REASON,
  type MissionDraftOutcomeRow,
  type MissionPositionOutcomeRow,
} from "../../missionOutcomeCompleteness.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const LONG_AGO = new Date(NOW.getTime() - 10 * 60_000);

function absentRow(over: Partial<BrokerAbsentCandidateRow> = {}): BrokerAbsentCandidateRow {
  return {
    positionId: 1,
    userId: 7,
    bridgeConnectionId: 3,
    brokerTicket: "TKT-1",
    symbol: "EURUSD",
    closedAt: null,
    reconcileState: null,
    brokerAbsentSnapshotCount: brokerCloseObservationPolicy.requiredReliableAbsences,
    firstBrokerAbsentAt: LONG_AGO,
    lastBrokerAbsentAt: LONG_AGO,
    lastReliableSnapshotAt: LONG_AGO,
    sourceCommandId: null,
    ...over,
  };
}

function evalCtx(over: Partial<BrokerAbsenceEvalContext> = {}): BrokerAbsenceEvalContext {
  return {
    now: NOW.getTime(),
    policy: brokerCloseObservationPolicy,
    scope: { userId: 7, bridgeConnectionId: 3 },
    pendingCloseTickets: new Set<string>(),
    snapshotReliable: true,
    snapshotComplete: true,
    ...over,
  };
}

function draft(over: Partial<MissionDraftOutcomeRow> = {}): MissionDraftOutcomeRow {
  return {
    draftId: "d-1",
    brokerTicket: "TKT-1",
    closedAt: NOW,
    pnl: 100,
    outcomeStatus: "RECONCILED",
    ...over,
  };
}

function position(over: Partial<MissionPositionOutcomeRow> = {}): MissionPositionOutcomeRow {
  return {
    brokerTicket: "TKT-1",
    closedAt: null,
    reconcileState: null,
    brokerAbsentSnapshotCount: 0,
    ...over,
  };
}

// ── 1. THE DEFECT ITSELF: a broker-side STOP-LOSS produces a recorded LOSS ────

test("a position closed at its STOP at the broker — no ARX close command — records the LOSS", () => {
  // The EA reports the closed deal: the broker's own realised P/L is negative.
  // There is NO ARX CLOSE_LIVE_POSITION command anywhere in this fixture, which
  // is exactly the case the old single-entrance recorder dropped on the floor.
  const plan = planBrokerCloseRecordings({
    reports: [{ brokerTicket: "TKT-SL", brokerRealisedPnl: -42.5, brokerClosePrice: 1.0812 }],
  });

  assert.equal(plan.length, 1, "the broker-side stop-out must produce exactly one recording");
  const rec = plan[0]!;
  assert.equal(rec.brokerTicket, "TKT-SL");
  assert.equal(rec.realisedPnl, -42.5, "the LOSS is recorded, not dropped and not softened");
  assert.equal(rec.outcomeStatus, "RECONCILED");
  assert.equal(rec.outcomeSource, "BROKER_CLOSE_REPORT");
  assert.equal(rec.unreconciledReason, null);
  assert.equal(rec.brokerClosePrice, 1.0812, "the broker's own close price is carried verbatim");
  assert.equal(rec.exitReason, BROKER_SIDE_EXIT_REASON);
});

test("a broker-side WIN and a broker-side LOSS are recorded by the same rule", () => {
  const plan = planBrokerCloseRecordings({
    reports: [
      { brokerTicket: "TKT-WIN", brokerRealisedPnl: 88.25 },
      { brokerTicket: "TKT-LOSS", brokerRealisedPnl: -61.75 },
    ],
  });
  assert.deepEqual(
    plan.map((p) => [p.brokerTicket, p.realisedPnl, p.outcomeStatus]),
    [
      ["TKT-WIN", 88.25, "RECONCILED"],
      ["TKT-LOSS", -61.75, "RECONCILED"],
    ],
    "no asymmetry: a loss travels the identical path a win does",
  );
});

test("a realised P/L of exactly zero is a real broker result, not a missing one", () => {
  const out = resolveBrokerCloseOutcome({ source: "BROKER_CLOSE_REPORT", brokerRealisedPnl: 0 });
  assert.equal(out.status, "RECONCILED");
  assert.equal(out.realisedPnl, 0);
});

// ── 2. NEVER INVENT: no broker numbers → honest typed null ───────────────────

test("the unreconciled path never invents a price or a P/L", () => {
  const out = resolveBrokerCloseOutcome({ source: "BROKER_ABSENCE" });
  assert.equal(out.realisedPnl, null, "no P/L may be fabricated");
  assert.equal(out.closePrice, null, "no price may be fabricated");
  assert.equal(out.status, "UNRECONCILED");
  assert.equal(out.unreconciledReason, OUTCOME_UNRECONCILED_BROKER_ABSENT);
});

test("a broker close report WITHOUT a P/L records the close, not a guess", () => {
  const out = resolveBrokerCloseOutcome({
    source: "BROKER_CLOSE_REPORT",
    brokerClosePrice: 1.234,
  });
  assert.equal(out.status, "UNRECONCILED");
  assert.equal(out.unreconciledReason, OUTCOME_UNRECONCILED_NO_BROKER_PNL);
  assert.equal(out.realisedPnl, null, "a close PRICE alone must never become a P/L");
  assert.equal(out.closePrice, 1.234, "the price is kept as evidence only");
});

test("non-numbers are never accepted as a broker P/L or a broker close price", () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, "12", {}, []]) {
    assert.equal(isBrokerReportedPnl(bad), false, `P/L must reject ${String(bad)}`);
    assert.equal(isBrokerReportedClosePrice(bad), false, `price must reject ${String(bad)}`);
  }
  // MT5 reports 0.0 for "no value" on a price — never a phantom fill at zero.
  assert.equal(isBrokerReportedClosePrice(0), false);
  assert.equal(isBrokerReportedClosePrice(-1), false);
  assert.equal(isBrokerReportedPnl(-1), true, "a negative P/L is a real loss");
  assert.equal(isBrokerReportedPnl(0), true);
});

test("a broker absence records an UNRECONCILED close and carries no numbers at all", () => {
  const candidates = findBrokerAbsentGhostPositionIds([absentRow()], evalCtx());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.safeToStampClosed, true);

  const plan = planBrokerCloseRecordings({ absenceCandidates: candidates });
  assert.equal(plan.length, 1);
  assert.deepEqual(
    {
      pnl: plan[0]!.realisedPnl,
      price: plan[0]!.brokerClosePrice,
      status: plan[0]!.outcomeStatus,
      reason: plan[0]!.unreconciledReason,
    },
    {
      pnl: null,
      price: null,
      status: "UNRECONCILED",
      reason: OUTCOME_UNRECONCILED_BROKER_ABSENT,
    },
  );
});

// ── 3. OBSERVATION IS NOT GATED BY THE ACTION FLAG ───────────────────────────

test("observation is always on; the auto-reconcile ACTION flag stays default-off", () => {
  // Recording a close the broker ALREADY made changes nothing at the broker, so
  // it must not sit behind the flag that authorises ARX to act on the book —
  // that gating is what dropped broker-side stop-losses in the first place.
  assert.equal(brokerCloseObservationPolicy.enabled, true);
  assert.equal(
    brokerAbsenceAutoReconcilePolicy.enabled,
    process.env["BROKER_ABSENCE_AUTO_RECONCILE_ENABLED"]?.trim().toLowerCase() === "true",
    "the ACTION flag keeps its own env-gated default-off behaviour",
  );
  // ...but the evidence BAR is identical, so observation is never looser.
  assert.equal(
    brokerCloseObservationPolicy.requiredReliableAbsences,
    brokerAbsenceAutoReconcilePolicy.requiredReliableAbsences,
  );
  assert.equal(
    brokerCloseObservationPolicy.minimumAbsentAgeMs,
    brokerAbsenceAutoReconcilePolicy.minimumAbsentAgeMs,
  );
  assert.equal(
    brokerCloseObservationPolicy.snapshotReliabilityWindowMs,
    brokerAbsenceAutoReconcilePolicy.snapshotReliabilityWindowMs,
  );
  assert.equal(
    brokerCloseObservationPolicy.requireCompleteSnapshot,
    brokerAbsenceAutoReconcilePolicy.requireCompleteSnapshot,
  );
});

test("the ingest wires observation OUTSIDE the auto-reconcile action flag", () => {
  // A unit test cannot see where the route calls the observer, and putting that
  // call back inside `if (brokerAbsenceAutoReconcilePolicy.enabled)` would
  // silently restore the original defect on a default-configured deployment —
  // ARX-issued closes recorded, broker-side stop-losses not. Pin the wiring.
  const routes = resolve(dirname(fileURLToPath(import.meta.url)), "../../../routes/mt5Live.ts");
  const src = readFileSync(routes, "utf8");

  assert.ok(
    src.includes("observeBrokerSideCloses("),
    "the positions ingest must observe broker-side closes",
  );
  const flagged = src.match(
    /if \(brokerAbsenceAutoReconcilePolicy\.enabled\) \{[\s\S]*?\n {2}\}\n/,
  );
  assert.ok(flagged, "the auto-reconcile ACTION block must still exist and stay flag-gated");
  assert.ok(
    flagged[0].includes("runBrokerAbsenceReconcile("),
    "the ACTION (stamping position state) is what the flag guards",
  );
  assert.equal(
    flagged[0].includes("observeBrokerSideCloses("),
    false,
    "observation must NOT sit inside the action flag — recording history is not acting",
  );
});

// ── 4. A BLOCKED CANDIDATE RECORDS NOTHING ───────────────────────────────────

test("an unreliable, young, thin or contested absence records nothing", () => {
  const cases: Array<[string, BrokerAbsentCandidateRow[], BrokerAbsenceEvalContext]> = [
    ["unreliable snapshot", [absentRow()], evalCtx({ snapshotReliable: false })],
    ["partial snapshot", [absentRow()], evalCtx({ snapshotComplete: false })],
    [
      "too few absences",
      [absentRow({ brokerAbsentSnapshotCount: 1 })],
      evalCtx(),
    ],
    [
      "absence too young",
      [absentRow({ firstBrokerAbsentAt: new Date(NOW.getTime() - 1_000) })],
      evalCtx(),
    ],
    ["no ticket mapping", [absentRow({ brokerTicket: null })], evalCtx()],
    [
      "an ARX close is already in flight",
      [absentRow()],
      evalCtx({ pendingCloseTickets: new Set(["TKT-1"]) }),
    ],
    ["another user's row", [absentRow({ userId: 99 })], evalCtx()],
    ["another bridge's row", [absentRow({ bridgeConnectionId: 44 })], evalCtx()],
  ];
  for (const [label, rows, ctx] of cases) {
    const plan = planBrokerCloseRecordings({
      absenceCandidates: findBrokerAbsentGhostPositionIds(rows, ctx),
    });
    assert.equal(plan.length, 0, `${label}: must record nothing`);
  }
});

test("an explicit broker report wins over absence evidence for the same ticket", () => {
  const plan = planBrokerCloseRecordings({
    reports: [{ brokerTicket: "TKT-1", brokerRealisedPnl: -12 }],
    absenceCandidates: findBrokerAbsentGhostPositionIds([absentRow()], evalCtx()),
  });
  assert.equal(plan.length, 1, "one ticket is never recorded twice");
  assert.equal(plan[0]!.realisedPnl, -12, "the report's real number beats the numberless absence");
  assert.equal(plan[0]!.outcomeSource, "BROKER_CLOSE_REPORT");
});

// ── 5. COMPLETENESS: the figure is labelled, and the target lock is HELD ──────

test("a mixed win/loss set is COMPLETE only when every closed outcome is confirmed", () => {
  const c = computeMissionOutcomeCompleteness({
    drafts: [
      draft({ draftId: "win", brokerTicket: "T1", pnl: 250 }),
      draft({ draftId: "loss", brokerTicket: "T2", pnl: -90 }),
    ],
    positions: [position({ brokerTicket: "T1", closedAt: NOW }), position({ brokerTicket: "T2", closedAt: NOW })],
    absenceEvidenceThreshold: 3,
  });
  assert.equal(c.complete, true);
  assert.equal(c.reconciledCloseCount, 2);
  assert.equal(c.unreconciledCloseCount, 0);
  assert.equal(c.pendingOutcomeCount, 0);
  assert.deepEqual(c.reasons, []);
});

test("a closed trade with no broker-confirmed P/L makes the set INCOMPLETE", () => {
  const c = computeMissionOutcomeCompleteness({
    drafts: [
      draft({ draftId: "win", brokerTicket: "T1", pnl: 250 }),
      // Recorded closed from a broker absence: honest, but carries no P/L.
      draft({ draftId: "sl", brokerTicket: "T2", pnl: null, outcomeStatus: "UNRECONCILED" }),
    ],
    positions: [position({ brokerTicket: "T1", closedAt: NOW }), position({ brokerTicket: "T2", closedAt: NOW })],
    absenceEvidenceThreshold: 3,
  });
  assert.equal(c.complete, false);
  assert.equal(c.unreconciledCloseCount, 1);
  assert.ok(
    c.reasons.some((r) => /incomplete/i.test(r)),
    "the incompleteness must be stated plainly, not implied",
  );
});

test("a position the broker shows CLOSED with no recorded result is counted as missing", () => {
  const c = computeMissionOutcomeCompleteness({
    drafts: [
      draft({ draftId: "win", brokerTicket: "T1", pnl: 250 }),
      // Still open on ARX's books; the broker's row says it is gone.
      draft({ draftId: "sl", brokerTicket: "T2", closedAt: null, pnl: null, outcomeStatus: null }),
    ],
    positions: [
      position({ brokerTicket: "T1", closedAt: NOW }),
      position({ brokerTicket: "T2", brokerAbsentSnapshotCount: 3 }),
    ],
    absenceEvidenceThreshold: 3,
  });
  assert.equal(c.complete, false);
  assert.equal(c.pendingOutcomeCount, 1);
  assert.equal(c.openTradeCount, 0);
});

test("a genuinely OPEN trade is not incompleteness — a float has no realised result yet", () => {
  const c = computeMissionOutcomeCompleteness({
    drafts: [
      draft({ draftId: "win", brokerTicket: "T1", pnl: 250 }),
      draft({ draftId: "open", brokerTicket: "T2", closedAt: null, pnl: null, outcomeStatus: null }),
    ],
    positions: [position({ brokerTicket: "T1", closedAt: NOW }), position({ brokerTicket: "T2" })],
    absenceEvidenceThreshold: 3,
  });
  assert.equal(c.complete, true);
  assert.equal(c.openTradeCount, 1);
  assert.equal(c.pendingOutcomeCount, 0);
});

test("an executed trade we cannot follow to a position is counted as missing, never as a win", () => {
  for (const d of [
    draft({ draftId: "no-ticket", brokerTicket: null, closedAt: null, pnl: null, outcomeStatus: null }),
    draft({ draftId: "no-row", brokerTicket: "GHOST", closedAt: null, pnl: null, outcomeStatus: null }),
  ]) {
    const c = computeMissionOutcomeCompleteness({
      drafts: [d],
      positions: [],
      absenceEvidenceThreshold: 3,
    });
    assert.equal(c.complete, false, `${d.draftId}: an unfollowable trade is not a complete set`);
    assert.equal(c.pendingOutcomeCount, 1);
  }
});

test("the mission target does NOT lock while an outcome is unrecorded", () => {
  const incomplete = computeMissionOutcomeCompleteness({
    drafts: [
      draft({ draftId: "win", brokerTicket: "T1", pnl: 400 }),
      draft({ draftId: "sl", brokerTicket: "T2", pnl: null, outcomeStatus: "UNRECONCILED" }),
    ],
    positions: [position({ brokerTicket: "T1", closedAt: NOW }), position({ brokerTicket: "T2", closedAt: NOW })],
    absenceEvidenceThreshold: 3,
  });
  const locked = { stopAndLock: true, reasons: ["Target reached."] };
  const gated = applyCompletenessToMilestone(locked, incomplete);
  assert.equal(gated.stopAndLock, false, "a target may never lock on a partial set");
  assert.ok(gated.reasons.includes(TARGET_LOCK_HELD_REASON));
  assert.ok(gated.reasons.includes("Target reached."), "existing reasons are preserved, not replaced");
});

test("a complete set locks normally, and the gate can only ever REMOVE a lock", () => {
  const complete = computeMissionOutcomeCompleteness({
    drafts: [draft({ draftId: "win", brokerTicket: "T1", pnl: 400 })],
    positions: [position({ brokerTicket: "T1", closedAt: NOW })],
    absenceEvidenceThreshold: 3,
  });
  assert.equal(applyCompletenessToMilestone({ stopAndLock: true, reasons: [] }, complete).stopAndLock, true);

  // Stricter-only: an incomplete set must never CREATE a lock that was not there.
  const incomplete = computeMissionOutcomeCompleteness({
    drafts: [draft({ draftId: "sl", brokerTicket: "T1", pnl: null, outcomeStatus: "UNRECONCILED" })],
    positions: [position({ brokerTicket: "T1", closedAt: NOW })],
    absenceEvidenceThreshold: 3,
  });
  const unlocked = applyCompletenessToMilestone({ stopAndLock: false, reasons: [] }, incomplete);
  assert.equal(unlocked.stopAndLock, false);
  assert.deepEqual(unlocked.reasons, [], "an unlocked milestone is left exactly as it was");
});
