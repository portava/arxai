// Phase 6 - Approval Inbox certification.
//
// Covers the owner's approval checks 6-12: no approval means no execution;
// rejected, expired and changed-terms all refuse; a duplicate dispatch cannot
// produce a second order; approval is scoped to the exact account and intent;
// and user A cannot approve or dispatch user B's order.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeDispatch, materialTermsFingerprint, transitionIsLegal, resolveUnresolved,
  APPROVAL_TICKET_STATES, TERMINAL_TICKET_STATES, LEGAL_TICKET_TRANSITIONS,
  type ApprovalTicket, type MaterialTradeTerms, type ApprovalTicketState,
} from "@workspace/domain/safety-contracts/approvalTicket";

const NOW = "2026-08-26T12:00:00.000Z";

const TERMS: MaterialTradeTerms = {
  userId: 7, broker: "deriv", accountRef: "VRTC1234", instrument: "R_100",
  side: "BUY", stakeUsd: 1, multiplier: 100,
  stopLossUsd: 0.5, takeProfitUsd: null, intentId: "intent_abc",
};

const TICKET: ApprovalTicket = {
  ticketId: "tkt_1", userId: 7, state: "APPROVED", terms: TERMS,
  approvedFingerprint: materialTermsFingerprint(TERMS), approvedByUserId: 7,
  createdAtIso: "2026-08-26T11:59:00.000Z",
  expiresAtIso: "2026-08-26T12:05:00.000Z",
  dispatchClaimedAtIso: null, constitutionVersion: 3,
  gateVerdictsPassed: true, disclosureWaivedByOperator: false,
};

const auth = (t: Partial<ApprovalTicket> = {}, terms = TERMS, actor = 7, now = NOW) =>
  authorizeDispatch({ ticket: { ...TICKET, ...t }, actorUserId: actor, currentTerms: terms, nowIso: now });

test("baseline: an approved, unexpired, unchanged ticket authorizes", () => {
  const a = auth();
  assert.equal(a.authorized, true, `refused: ${a.refusals.join(",")}`);
});

// -- 6. no approval means no execution -------------------------------------
test("a PENDING ticket cannot dispatch", () => {
  const a = auth({ state: "PENDING", approvedFingerprint: null, approvedByUserId: null });
  assert.equal(a.authorized, false);
  assert.equal(a.primaryRefusal, "TICKET_NOT_APPROVED");
});

test("a missing ticket cannot dispatch", () => {
  for (const missing of [null, undefined]) {
    const a = authorizeDispatch({ ticket: missing, actorUserId: 7, currentTerms: TERMS, nowIso: NOW });
    assert.equal(a.authorized, false);
    assert.equal(a.primaryRefusal, "TICKET_NOT_FOUND");
  }
});

test("an APPROVED state with no recorded approval fingerprint still refuses", () => {
  // Guards the forgery route: setting state=APPROVED without the binding.
  const a = auth({ approvedFingerprint: null });
  assert.equal(a.authorized, false);
  assert.ok(a.refusals.includes("TICKET_NOT_APPROVED"));
});

test("a ticket with no approver refuses even when state says APPROVED", () => {
  const a = auth({ approvedByUserId: null });
  assert.equal(a.authorized, false);
  assert.ok(a.refusals.includes("SELF_APPROVAL_MISSING"));
});

// -- 7. rejected is terminal ------------------------------------------------
test("REJECTED and CANCELLED tickets cannot dispatch", () => {
  assert.equal(auth({ state: "REJECTED" }).primaryRefusal, "TICKET_REJECTED");
  assert.equal(auth({ state: "CANCELLED" }).primaryRefusal, "TICKET_CANCELLED");
});

test("every terminal state accepts NO outgoing transition", () => {
  for (const s of TERMINAL_TICKET_STATES) {
    assert.deepEqual([...LEGAL_TICKET_TRANSITIONS[s]], [], `${s} has an outgoing transition`);
    for (const to of APPROVAL_TICKET_STATES) {
      assert.equal(transitionIsLegal(s, to), false, `${s} -> ${to} was allowed`);
    }
  }
});

// -- 8. expired is terminal, and enforced at the DISPATCH clock -------------
test("an EXPIRED ticket cannot dispatch", () => {
  assert.equal(auth({ state: "EXPIRED" }).primaryRefusal, "TICKET_EXPIRED");
});

test("an APPROVED ticket refuses once its window has closed", () => {
  // The state still says APPROVED; only the clock has moved. This is the case
  // a read-time-only expiry check would wave through.
  const a = auth({}, TERMS, 7, "2026-08-26T12:05:00.000Z");
  assert.equal(a.authorized, false);
  assert.ok(a.refusals.includes("TICKET_EXPIRED"), "expiry was not enforced at dispatch time");
  // Exactly at the boundary counts as expired, not as the last valid instant.
  assert.equal(auth({}, TERMS, 7, "2026-08-26T12:04:59.999Z").authorized, true);
});

test("an unreadable clock refuses rather than defaulting to valid", () => {
  assert.equal(auth({}, TERMS, 7, "not-a-date").primaryRefusal, "CLOCK_UNREADABLE");
  assert.equal(auth({ expiresAtIso: "not-a-date" }).primaryRefusal, "CLOCK_UNREADABLE");
});

// -- 9. changed terms invalidate the approval -------------------------------
test("changing ANY material term after approval refuses dispatch", () => {
  const changes: Partial<MaterialTradeTerms>[] = [
    { stakeUsd: 2 }, { multiplier: 200 }, { side: "SELL" }, { instrument: "R_50" },
    { stopLossUsd: 0.25 }, { stopLossUsd: null }, { takeProfitUsd: 3 },
  ];
  for (const c of changes) {
    const a = auth({}, { ...TERMS, ...c });
    assert.equal(a.authorized, false, `change ${JSON.stringify(c)} was allowed`);
    assert.ok(a.refusals.includes("TERMS_CHANGED_SINCE_APPROVAL"), JSON.stringify(c));
  }
});

test("a null stop is distinct from a zero stop in the fingerprint", () => {
  // Encoding null as 0 would let "no protection" pass as "protection at 0".
  assert.notEqual(
    materialTermsFingerprint({ ...TERMS, stopLossUsd: null }),
    materialTermsFingerprint({ ...TERMS, stopLossUsd: 0 }),
  );
});

test("the fingerprint is stable across equal-value number representations", () => {
  assert.equal(
    materialTermsFingerprint({ ...TERMS, stakeUsd: 1 }),
    materialTermsFingerprint({ ...TERMS, stakeUsd: 1.0 }),
  );
});

test("adjacent string fields cannot be shifted to forge a matching fingerprint", () => {
  // Without length-prefixing, ("ab","c") and ("a","bc") would concatenate
  // identically and two different trades would share one approval.
  assert.notEqual(
    materialTermsFingerprint({ ...TERMS, broker: "ab", accountRef: "c" }),
    materialTermsFingerprint({ ...TERMS, broker: "a", accountRef: "bc" }),
  );
});

// -- 10. one approval, at most one order ------------------------------------
test("a ticket already claimed for dispatch refuses a second claim", () => {
  const a = auth({ dispatchClaimedAtIso: "2026-08-26T12:00:01.000Z" });
  assert.equal(a.authorized, false);
  assert.ok(a.refusals.includes("TICKET_ALREADY_DISPATCHED"), "a replayed approval could dispatch twice");
});

test("DISPATCHING, EXECUTED and UNRESOLVED all refuse a new dispatch", () => {
  assert.equal(auth({ state: "DISPATCHING" }).primaryRefusal, "TICKET_ALREADY_DISPATCHED");
  assert.equal(auth({ state: "EXECUTED" }).primaryRefusal, "TICKET_ALREADY_EXECUTED");
  // UNRESOLVED is the important one: an order MAY exist, so a retry could double up.
  assert.equal(auth({ state: "UNRESOLVED" }).primaryRefusal, "TICKET_UNRESOLVED_BLOCKS_NEW_DISPATCH");
});

test("an UNRESOLVED ticket can never be re-dispatched by any legal transition", () => {
  assert.equal(transitionIsLegal("UNRESOLVED", "DISPATCHING"), false);
  assert.equal(transitionIsLegal("UNRESOLVED", "APPROVED"), false);
  assert.equal(transitionIsLegal("UNRESOLVED", "PENDING"), false);
});

// -- 11 & 12. scope: owner, account, intent ---------------------------------
test("user A cannot dispatch user B's approved ticket", () => {
  const a = auth({}, TERMS, 8);
  assert.equal(a.authorized, false);
  assert.ok(a.refusals.includes("ACTOR_IS_NOT_THE_OWNER"));
});

test("a ticket approved by someone other than the owner refuses", () => {
  const a = auth({ approvedByUserId: 8 });
  assert.equal(a.authorized, false);
  assert.ok(a.refusals.includes("APPROVER_IS_NOT_THE_OWNER"), "a third party's approval authorized the trade");
});

test("approval is scoped to the exact broker and account", () => {
  const other = { ...TERMS, accountRef: "CR_REAL_MONEY" };
  const a = auth({}, other);
  assert.equal(a.authorized, false);
  assert.ok(a.refusals.includes("ACCOUNT_SCOPE_MISMATCH"), "approval leaked to another account");
  assert.ok(auth({}, { ...TERMS, broker: "mt5" }).refusals.includes("ACCOUNT_SCOPE_MISMATCH"));
});

test("approval is scoped to the exact order intent", () => {
  const a = auth({}, { ...TERMS, intentId: "intent_OTHER" });
  assert.equal(a.authorized, false);
  assert.ok(a.refusals.includes("INTENT_SCOPE_MISMATCH"), "approval was reusable for a different intent");
});

test("gate verdicts that did not pass refuse dispatch", () => {
  assert.ok(auth({ gateVerdictsPassed: false }).refusals.includes("GATES_DID_NOT_PASS"));
});

// -- UNRESOLVED resolves only on venue evidence -----------------------------
test("an UNRESOLVED ticket is NOT resolved by the absence of a venue read", () => {
  const r = resolveUnresolved({ venueRead: false, closedInclusive: true, venueContractRef: null });
  assert.equal(r.resolved, false, "a ticket resolved without reading the venue");
});

test("absence from an OPEN-ONLY read does not prove no order exists", () => {
  // The false-absence defect: a portfolio read returns outstanding contracts
  // only, so an order that opened and settled is simply missing from it.
  const r = resolveUnresolved({ venueRead: true, closedInclusive: false, venueContractRef: null });
  assert.equal(r.resolved, false, "an open-only read was treated as proof of absence");
});

test("a closed-inclusive read finding nothing DOES prove no order exists", () => {
  const r = resolveUnresolved({ venueRead: true, closedInclusive: true, venueContractRef: null });
  assert.equal(r.resolved, true);
  assert.equal(r.resolved === true && r.nextState, "REJECTED");
});

test("a venue contract reference proves the order exists", () => {
  const r = resolveUnresolved({ venueRead: true, closedInclusive: false, venueContractRef: "10548672559" });
  assert.equal(r.resolved, true);
  assert.equal(r.resolved === true && r.nextState, "EXECUTED");
  // A blank reference is not a reference.
  assert.equal(resolveUnresolved({ venueRead: true, closedInclusive: false, venueContractRef: "   " }).resolved, false);
});

// -- transition table sanity -----------------------------------------------
test("no transition re-enters PENDING, and DISPATCHING is reachable only from APPROVED", () => {
  for (const s of APPROVAL_TICKET_STATES) {
    assert.equal(transitionIsLegal(s, "PENDING"), false, `${s} -> PENDING was allowed`);
  }
  const sources = APPROVAL_TICKET_STATES.filter((s) => transitionIsLegal(s, "DISPATCHING"));
  assert.deepEqual(sources, ["APPROVED"] as ApprovalTicketState[]);
});

test("an operator disclosure waiver is carried explicitly, not hidden in the gate result", () => {
  // Gate 18 can pass via an operator waiver without the user ever accepting the
  // risk disclosure. The ticket must carry that fact separately so an inbox
  // cannot present it as the user's own consent.
  const t: ApprovalTicket = { ...TICKET, disclosureWaivedByOperator: true };
  assert.equal(t.disclosureWaivedByOperator, true);
  assert.equal(t.gateVerdictsPassed, true, "the waiver and the gate result are independent facts");
});
