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
//   3. A mixed win/loss set holds the mission's target CLAIM while any outcome
//      is unrecorded — without ever removing the STOP (removing it would resume
//      trading on an unverified set).
//   4. The evidence bar for observing an absence is the same one the ACTION path
//      uses: a blocked candidate records nothing at all.
//   5. The user-facing copy never describes an incomplete figure as a floor, a
//      minimum or any other bound. It is a bound in neither direction.
//   6. An outcome the flag-gated ACTION path already reconciled still reaches
//      the mission recorder (the observer would otherwise lose it forever).
//   7. The broker close-report ingest is scoped by BRIDGE, so one bridge's EA
//      can never write a realised P/L onto another bridge's position.
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
  attributeBrokerCloseReports,
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
  TARGET_CLAIM_HELD_REASON,
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

/**
 * Return `src` with the CONTENTS of comments, string literals and template
 * literals replaced by spaces, preserving length so every index still lines up
 * with the original. Blanking comments is what makes "just comment the call
 * out" a detectable mutation rather than a passing one.
 */
function blankNonCode(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  const blank = (at: number): void => {
    if (src[at] !== "\n") out[at] = " ";
  };
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < n && src[i] !== "\n") blank(i++);
      continue;
    }
    if (two === "/*") {
      blank(i++);
      while (i < n && src.slice(i, i + 2) !== "*/") blank(i++);
      if (i < n) {
        blank(i++);
        blank(i++);
      }
      continue;
    }
    const q = src[i];
    if (q === '"' || q === "'" || q === "`") {
      i += 1; // keep the opening quote as a token boundary
      while (i < n) {
        if (src[i] === "\\") {
          blank(i++);
          if (i < n) blank(i++);
          continue;
        }
        if (src[i] === q) {
          i += 1;
          break;
        }
        blank(i++);
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Headers of every `{ ... }` block enclosing `idx`, innermost last. */
function enclosingBlockHeaders(code: string, idx: number): string[] {
  const open: number[] = [];
  for (let i = 0; i < idx; i += 1) {
    if (code[i] === "{") open.push(i);
    else if (code[i] === "}") open.pop();
  }
  return open.map((bracePos) => {
    let start = 0;
    for (let i = bracePos - 1; i >= 0; i -= 1) {
      const c = code[i]!;
      if (c === ";" || c === "{" || c === "}") {
        start = i + 1;
        break;
      }
    }
    return code.slice(start, bracePos);
  });
}

test("the ingest wires observation OUTSIDE the auto-reconcile action flag — and unconditionally", () => {
  // A unit test cannot see where the route calls the observer, and putting that
  // call back inside `if (brokerAbsenceAutoReconcilePolicy.enabled)` would
  // silently restore the original defect on a default-configured deployment —
  // ARX-issued closes recorded, broker-side stop-losses not.
  //
  // A plain substring grep for the call is NOT enough: it survives `if (false)
  // await observeBrokerSideCloses(...)` and it survives commenting the call out.
  // A dead call proves nothing about a deployed binary. So this test parses the
  // route's BLOCK STRUCTURE (with comments and string bodies blanked out, so a
  // commented-out call simply does not exist) and asserts the call is reached
  // unconditionally: no enclosing `if`, no statement-level guard on it.
  //
  // HONEST LIMIT: this is still a structural read of source, not an execution
  // trace. It cannot see an early `return` placed above the call, and it cannot
  // see the module-resolution layer. Those need the DB-backed route test in the
  // integration lane; what is pinned here is everything a source read can prove.
  const routes = resolve(dirname(fileURLToPath(import.meta.url)), "../../../routes/mt5Live.ts");
  const src = readFileSync(routes, "utf8");
  const code = blankNonCode(src);

  assert.equal(code.length, src.length, "blanking must preserve every index");
  let depth = 0;
  for (const ch of code) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    assert.ok(depth >= 0, "brace scan went negative — the blanking pass mis-parsed the route");
  }
  assert.equal(depth, 0, "braces must balance — otherwise this test's structural read is unsound");

  const awaited = code.indexOf("await observeBrokerSideCloses(");
  assert.ok(
    awaited >= 0,
    "the positions ingest must AWAIT observeBrokerSideCloses in live (non-comment) code",
  );

  for (const header of enclosingBlockHeaders(code, awaited)) {
    assert.equal(
      /\bif\s*\(/.test(header),
      false,
      `observation must not sit inside any conditional block — found header: ${header.trim()}`,
    );
    assert.equal(
      header.includes("brokerAbsenceAutoReconcilePolicy"),
      false,
      "observation must NOT sit inside the action flag — recording history is not acting",
    );
  }

  // Statement-level guard check: `if (false) await observeBrokerSideCloses(...)`
  // adds no block, so the enclosing-header scan above cannot see it.
  let stmtStart = 0;
  for (let i = awaited - 1; i >= 0; i -= 1) {
    const c = code[i]!;
    if (c === ";" || c === "{" || c === "}") {
      stmtStart = i + 1;
      break;
    }
  }
  const stmtPrefix = code.slice(stmtStart, awaited);
  assert.equal(
    /\b(if|else|while|for|switch|case)\b/.test(stmtPrefix),
    false,
    `the observation call must not be guarded by a statement-level condition: ${stmtPrefix.trim()}`,
  );
  assert.equal(
    /(&&|\|\||\?)/.test(stmtPrefix),
    false,
    `the observation call must not be short-circuited: ${stmtPrefix.trim()}`,
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

test("an incomplete set holds the target CLAIM but never removes the STOP", () => {
  // FORWARD-FIX. The first cut of this gate flipped `stopAndLock` true -> false
  // on an incomplete set and called that "protective". It is the opposite:
  // `missionDriver` derives `targetReached` from `stopAndLock`, so turning it
  // off RESUMES trading on a set ARX cannot verify — an automated widening of
  // exposure. The stop stays; only the claim is withheld.
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
  assert.equal(
    gated.stopAndLock,
    true,
    "the stop is never removed — an unverified mission must not resume trading",
  );
  assert.ok(gated.reasons.includes(TARGET_CLAIM_HELD_REASON));
  assert.ok(gated.reasons.includes("Target reached."), "existing reasons are preserved, not replaced");
});

test("the completeness gate never changes stopAndLock in either direction", () => {
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

// ── 6. THE COPY MAY NEVER CLAIM A BOUND ──────────────────────────────────────

test("incompleteness copy never claims the shown figure is a floor or a minimum", () => {
  // FORWARD-FIX. The first cut said "treat it as a floor, not the final result".
  // A floor asserts truth >= shown. The excluded outcomes skew toward stop-loss
  // LOSSES, so the shown figure is if anything upward-biased — the claim was
  // false in exactly the case it was written for. An incomplete realised figure
  // bounds the truth in NEITHER direction, and the copy must say so.
  const incomplete = computeMissionOutcomeCompleteness({
    drafts: [
      draft({ draftId: "win", brokerTicket: "T1", pnl: 250 }),
      draft({ draftId: "sl", brokerTicket: "T2", pnl: null, outcomeStatus: "UNRECONCILED" }),
    ],
    positions: [position({ brokerTicket: "T1", closedAt: NOW }), position({ brokerTicket: "T2", closedAt: NOW })],
    absenceEvidenceThreshold: 3,
  });
  const copy = [...incomplete.reasons, TARGET_CLAIM_HELD_REASON]
    .join(" \n ")
    // Explicit DENIALS of a bound are the point — strip them so the scan below
    // only ever sees an affirmative claim.
    .replace(/\bnot a (floor|minimum|lower bound)\b/gi, "");

  for (const forbidden of [
    /\bfloor\b/i,
    /\bminimum\b/i,
    /\bat least\b/i,
    /\blower bound\b/i,
    /\bno less than\b/i,
    /\bnot less than\b/i,
  ]) {
    assert.equal(
      forbidden.test(copy),
      false,
      `an incomplete figure must not be described with ${forbidden} — it is not a bound`,
    );
  }
  assert.match(
    copy,
    /may be higher or lower/i,
    "the copy must state plainly that the truth can land either side of the number",
  );
  assert.match(
    copy,
    /most often stop-losses/i,
    "and must name the direction of the known skew rather than implying a favourable one",
  );
});

// ── 7. RECOVERY: the ACTION path winning the race must not lose the outcome ───

test("a row the ACTION path already reconciled still reaches the mission recorder", () => {
  // With BROKER_ABSENCE_AUTO_RECONCILE_ENABLED=true the reconciler stamps
  // closedAt + reconcileState, which removes the row from the observer's
  // candidate query permanently. Without the recovery source the outcome would
  // never be recorded and the draft would stay open forever.
  const plan = planBrokerCloseRecordings({ reconciledAbsentTickets: ["TKT-RECONCILED"] });
  assert.equal(plan.length, 1);
  assert.deepEqual(
    {
      ticket: plan[0]!.brokerTicket,
      pnl: plan[0]!.realisedPnl,
      price: plan[0]!.brokerClosePrice,
      status: plan[0]!.outcomeStatus,
      reason: plan[0]!.unreconciledReason,
    },
    {
      ticket: "TKT-RECONCILED",
      pnl: null,
      price: null,
      status: "UNRECONCILED",
      reason: OUTCOME_UNRECONCILED_BROKER_ABSENT,
    },
    "recovery records the same honest numberless close — it invents nothing",
  );
});

test("recovery never overrides a real broker number and never double-records", () => {
  const plan = planBrokerCloseRecordings({
    reports: [{ brokerTicket: "TKT-1", brokerRealisedPnl: -77.5 }],
    absenceCandidates: findBrokerAbsentGhostPositionIds([absentRow()], evalCtx()),
    reconciledAbsentTickets: ["TKT-1", "TKT-1", "  "],
  });
  assert.equal(plan.length, 1, "one ticket is never recorded twice, whatever the source");
  assert.equal(plan[0]!.realisedPnl, -77.5, "the broker's own number wins over every numberless source");
  assert.equal(plan[0]!.outcomeSource, "BROKER_CLOSE_REPORT");
});

// ── 8. BRIDGE ISOLATION OF THE CLOSE-REPORT INGEST ───────────────────────────

test("a close report for a ticket that lives on ANOTHER bridge is refused", () => {
  // Broker tickets are broker-local, so one user's two bridges can carry the
  // same ticket string. A userId-only match let bridge A's EA write a
  // broker-realised P/L onto bridge B's position — and that number reaches the
  // mission's realised money figure.
  const out = attributeBrokerCloseReports({
    bridgeConnectionId: 3,
    reportTickets: ["TKT-FOREIGN"],
    positionRows: [{ brokerTicket: "TKT-FOREIGN", bridgeConnectionId: 44 }],
  });
  assert.deepEqual(out.accepted, [], "a foreign bridge's ticket must never be accepted");
  assert.deepEqual(out.refused, [{ brokerTicket: "TKT-FOREIGN", attribution: "OTHER_BRIDGE" }]);
});

test("a close report for a ticket on THIS bridge is accepted, even once the row is closed", () => {
  const out = attributeBrokerCloseReports({
    bridgeConnectionId: 3,
    reportTickets: ["TKT-1"],
    // Same ticket present on this bridge AND on another — this bridge wins.
    positionRows: [
      { brokerTicket: "TKT-1", bridgeConnectionId: 44 },
      { brokerTicket: "TKT-1", bridgeConnectionId: 3 },
    ],
  });
  assert.deepEqual(out.accepted, ["TKT-1"]);
  assert.deepEqual(out.refused, []);
});

test("a ticket with no position row anywhere is still accepted — refusing it would DROP a real broker P/L", () => {
  // Position rows are created ONLY by the snapshot ingest, so a trade that
  // opens and stops out between two sweeps never gets one. A "must be on this
  // bridge" rule would throw away exactly the broker-confirmed loss this branch
  // exists to capture, and there is no competing bridge to confuse it with.
  const out = attributeBrokerCloseReports({
    bridgeConnectionId: 3,
    reportTickets: ["TKT-NEVER-SNAPSHOTTED"],
    positionRows: [],
  });
  assert.deepEqual(out.accepted, ["TKT-NEVER-SNAPSHOTTED"]);
  assert.deepEqual(out.refused, []);
});

test("attribution ignores blanks and never returns a ticket twice", () => {
  const out = attributeBrokerCloseReports({
    bridgeConnectionId: 3,
    reportTickets: ["  ", "TKT-1", "TKT-1", " TKT-1 "],
    positionRows: [{ brokerTicket: " TKT-1 ", bridgeConnectionId: 3 }],
  });
  assert.deepEqual(out.accepted, ["TKT-1"]);
});

test("the ingest routes close reports through attribution before they reach the recorder", () => {
  const routes = resolve(dirname(fileURLToPath(import.meta.url)), "../../../routes/mt5Live.ts");
  const code = blankNonCode(readFileSync(routes, "utf8"));

  assert.ok(
    code.includes("attributeBrokerCloseReports({"),
    "the ingest must attribute reports to a bridge before believing them",
  );
  assert.ok(
    code.includes("eq(arxLivePositionsTable.bridgeConnectionId, conn.id)"),
    "the stamping UPDATE must carry the bridge scope",
  );
  assert.ok(
    code.includes("reports: attributableCloseReports.map("),
    "only bridge-attributable reports may be forwarded to the per-user recorder",
  );
  assert.equal(
    code.includes("reports: closeReports.map("),
    false,
    "the unfiltered report list must never reach the observer",
  );
});
