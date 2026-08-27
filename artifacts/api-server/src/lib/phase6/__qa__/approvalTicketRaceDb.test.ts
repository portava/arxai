// Phase 6 — the atomic dispatch claim, proven against a LIVE Postgres.
//
// The pure lifecycle law (approvalTicket.ts) refuses a second dispatch on a
// ticket it can SEE is already claimed. That is necessary and not sufficient:
// two requests racing in separate processes each read state='APPROVED' before
// either writes, so both pass the pure check. Nothing in application code can
// break that tie — a mutex is invisible across processes.
//
// Only the database can. This suite fires N simultaneous claims at ONE approved
// ticket and asserts exactly one wins.
//
// It follows the established pattern of liveDispatchDoubleSendRace.test.ts,
// including its most important feature: a CONTROL ARM that performs the same
// burst with the CAS predicate removed. That arm must produce MORE THAN ONE
// winner. If it ever yields exactly one, the race no longer reproduces and this
// whole suite has stopped proving anything — so the control failing is a louder
// signal than the primary assertion failing.
//
// Writes only synthetic rows (ticket ids prefixed __qa_ticket_race__, a negative
// synthetic user id) and deletes them in a finally. It never approves a real
// user, touches broker credentials, or dispatches anything to a venue.

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, like, sql } from "drizzle-orm";
import { db, approvalTicketsTable } from "@workspace/db";
import { approvalTicketsRepo } from "@workspace/db";

const PREFIX = "__qa_ticket_race__";
const QA_USER = -970601;
const CONCURRENCY = 12;

function ticketId(tag: string): string {
  // No Math.random / Date.now in the id itself would be nicer, but uniqueness
  // across repeated local runs matters more here and this is test-only code.
  return `${PREFIX}${tag}_${process.pid}_${Date.now()}`;
}

async function seedTicket(tag: string, state: string, minutesToExpiry = 10): Promise<string> {
  const id = ticketId(tag);
  await db.insert(approvalTicketsTable).values({
    ticketId: id,
    userId: QA_USER,
    state,
    broker: "deriv",
    accountRef: "VRTC_QA",
    instrument: "R_100",
    side: "BUY",
    stakeUsd: 1,
    multiplier: 100,
    intentId: `${id}_intent`,
    approvedFingerprint: state === "APPROVED" ? "f".repeat(64) : null,
    approvedByUserId: state === "APPROVED" ? QA_USER : null,
    expiresAt: new Date(Date.now() + minutesToExpiry * 60_000),
    constitutionVersion: 1,
    gateVerdictsPassed: true,
  });
  return id;
}

async function cleanup(): Promise<void> {
  await db.delete(approvalTicketsTable).where(like(approvalTicketsTable.ticketId, `${PREFIX}%`));
}

test("N concurrent dispatch claims on ONE approved ticket yield exactly one winner", async () => {
  try {
    const id = await seedTicket("primary", "APPROVED");
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        approvalTicketsRepo.claimTicketForDispatch({
          ticketId: id, userId: QA_USER, liveCommandId: `cmd_${i}`,
        })),
    );
    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1,
      `${winners.length} of ${CONCURRENCY} concurrent claims won — each winner would place a venue order`);

    // The winner's command id must be the one recorded: a losing claim must not
    // overwrite the winner's lineage on its way out.
    const [row] = await db.select().from(approvalTicketsTable)
      .where(eq(approvalTicketsTable.ticketId, id));
    assert.equal(row?.state, "DISPATCHING");
    assert.equal(row?.liveCommandId, winners[0]?.liveCommandId);
    assert.ok(row?.dispatchClaimedAt instanceof Date, "the claim timestamp was not recorded");
  } finally {
    await cleanup();
  }
});

test("CONTROL: without the CAS predicate, the SAME burst produces MULTIPLE winners", async () => {
  // Proves the race is real and this suite can detect it. If this ever yields
  // exactly one, the primary test above has stopped meaning anything.
  try {
    const id = await seedTicket("control", "APPROVED");
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        db.update(approvalTicketsTable)
          .set({ state: "DISPATCHING", dispatchClaimedAt: new Date(), liveCommandId: `ctl_${i}` })
          .where(eq(approvalTicketsTable.ticketId, id))   // <- ticket id ONLY, no state guard
          .returning()),
    );
    const winners = results.filter((r) => r.length > 0);
    assert.ok(winners.length > 1,
      `the control arm produced ${winners.length} winner(s). The double-claim race no longer ` +
      "reproduces, so the primary assertion above proves nothing. Investigate before trusting it.");
  } finally {
    await cleanup();
  }
});

test("a claim on a ticket that already left APPROVED refuses", async () => {
  try {
    for (const state of ["PENDING", "REJECTED", "EXPIRED", "DISPATCHING", "EXECUTED", "UNRESOLVED", "CANCELLED"]) {
      const id = await seedTicket(`state_${state}`, state);
      const r = await approvalTicketsRepo.claimTicketForDispatch({
        ticketId: id, userId: QA_USER, liveCommandId: "cmd_x",
      });
      assert.equal(r, null, `a ticket in state ${state} was claimed for dispatch`);
    }
  } finally {
    await cleanup();
  }
});

test("another user cannot claim, approve or reject this user's ticket", async () => {
  try {
    const id = await seedTicket("owner", "APPROVED");
    const other = QA_USER - 1;

    assert.equal(
      await approvalTicketsRepo.claimTicketForDispatch({ ticketId: id, userId: other, liveCommandId: "x" }),
      null, "another user claimed this ticket for dispatch");

    const pending = await seedTicket("owner_pending", "PENDING");
    assert.equal(
      await approvalTicketsRepo.approveTicket({
        ticketId: pending, userId: other, approvedByUserId: other, approvedFingerprint: "a".repeat(64),
      }),
      null, "another user approved this ticket");
    assert.equal(
      await approvalTicketsRepo.rejectTicket({
        ticketId: pending, userId: other, rejectedByUserId: other, reason: "x", source: "USER",
      }),
      null, "another user rejected this ticket");

    // And the owner-shaped call with a mismatched approver is refused too.
    assert.equal(
      await approvalTicketsRepo.approveTicket({
        ticketId: pending, userId: QA_USER, approvedByUserId: other, approvedFingerprint: "a".repeat(64),
      }),
      null, "a third party's approval was recorded against the owner's ticket");
  } finally {
    await cleanup();
  }
});

test("an EXPIRED-by-the-clock ticket cannot be approved or claimed", async () => {
  // Expiry is enforced with the DATABASE clock, so a caller whose own clock is
  // behind cannot dispatch a ticket whose window has closed.
  try {
    const id = await seedTicket("expired", "APPROVED", -1);
    assert.equal(
      await approvalTicketsRepo.claimTicketForDispatch({ ticketId: id, userId: QA_USER, liveCommandId: "x" }),
      null, "an expired ticket was claimed for dispatch");

    const p = await seedTicket("expired_pending", "PENDING", -1);
    assert.equal(
      await approvalTicketsRepo.approveTicket({
        ticketId: p, userId: QA_USER, approvedByUserId: QA_USER, approvedFingerprint: "b".repeat(64),
      }),
      null, "an expired ticket was approved");
  } finally {
    await cleanup();
  }
});

test("N concurrent approvals of ONE pending ticket yield exactly one winner", async () => {
  try {
    const id = await seedTicket("approve_race", "PENDING");
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        approvalTicketsRepo.approveTicket({
          ticketId: id, userId: QA_USER, approvedByUserId: QA_USER, approvedFingerprint: "c".repeat(64),
        })),
    );
    assert.equal(results.filter((r) => r !== null).length, 1,
      "a double-click produced more than one recorded approval");
  } finally {
    await cleanup();
  }
});

test("the sweeper NEVER expires a DISPATCHING or UNRESOLVED ticket", async () => {
  // The safety property: for those states an order may exist at the venue, and
  // time passing proves nothing about whether it does. Expiring them would turn
  // "we do not know" into "it did not happen" on a timer.
  try {
    const dispatching = await seedTicket("sweep_dispatching", "DISPATCHING", -60);
    const unresolved = await seedTicket("sweep_unresolved", "UNRESOLVED", -60);
    const pending = await seedTicket("sweep_pending", "PENDING", -60);

    await approvalTicketsRepo.expireStaleTickets(100);

    const rows = await db.select().from(approvalTicketsTable)
      .where(like(approvalTicketsTable.ticketId, `${PREFIX}%`));
    const byId = new Map(rows.map((r) => [r.ticketId, r.state]));
    assert.equal(byId.get(dispatching), "DISPATCHING", "the sweeper expired a DISPATCHING ticket");
    assert.equal(byId.get(unresolved), "UNRESOLVED", "the sweeper expired an UNRESOLVED ticket");
    assert.equal(byId.get(pending), "EXPIRED", "the sweeper failed to expire a stale PENDING ticket");
  } finally {
    await cleanup();
  }
});

test("settling requires the DISPATCHING state and, for EXECUTED, venue evidence", async () => {
  try {
    const id = await seedTicket("settle", "DISPATCHING");
    // EXECUTED without a venue reference is a claim with nothing behind it.
    assert.equal(
      await approvalTicketsRepo.settleDispatchedTicket({ ticketId: id, outcome: "EXECUTED", venueContractRef: "  " }),
      null, "a ticket was marked EXECUTED with no venue contract reference");
    assert.equal(
      await approvalTicketsRepo.settleDispatchedTicket({ ticketId: id, outcome: "EXECUTED", venueContractRef: null }),
      null, "a ticket was marked EXECUTED with a null venue reference");

    const ok = await approvalTicketsRepo.settleDispatchedTicket({
      ticketId: id, outcome: "EXECUTED", venueContractRef: "10548672559",
    });
    assert.equal(ok?.state, "EXECUTED");
    assert.equal(ok?.venueContractRef, "10548672559");

    // And a settle on a ticket that is no longer DISPATCHING refuses.
    assert.equal(
      await approvalTicketsRepo.settleDispatchedTicket({ ticketId: id, outcome: "UNRESOLVED" }),
      null, "a terminal ticket was re-settled");
  } finally {
    await cleanup();
  }
});

test("an UNRESOLVED ticket keeps its dispatch claim, so it can never be re-dispatched", async () => {
  try {
    const id = await seedTicket("unresolved_claim", "APPROVED");
    const won = await approvalTicketsRepo.claimTicketForDispatch({
      ticketId: id, userId: QA_USER, liveCommandId: "cmd_1",
    });
    assert.ok(won, "the initial claim should have succeeded");

    await approvalTicketsRepo.settleDispatchedTicket({ ticketId: id, outcome: "UNRESOLVED" });

    const [row] = await db.select().from(approvalTicketsTable)
      .where(eq(approvalTicketsTable.ticketId, id));
    assert.equal(row?.state, "UNRESOLVED");
    assert.ok(row?.dispatchClaimedAt, "the dispatch claim was cleared — the order became re-dispatchable");

    assert.equal(
      await approvalTicketsRepo.claimTicketForDispatch({ ticketId: id, userId: QA_USER, liveCommandId: "cmd_2" }),
      null, "an UNRESOLVED ticket was re-claimed — this is how one approval becomes two orders");
  } finally {
    await cleanup();
  }
});

test("the active partial index blocks a second live ticket for the same account+instrument", async () => {
  try {
    await seedTicket("uq_first", "PENDING");
    let threw = false;
    try {
      // Same QA_USER / accountRef / instrument, also in a live state.
      await seedTicket("uq_second", "APPROVED");
    } catch {
      threw = true;
    }
    assert.equal(threw, true,
      "a second live ticket was created for the same user+account+instrument — " +
      "approval_tickets_active_uq is not enforcing");
  } finally {
    await cleanup();
  }
});
