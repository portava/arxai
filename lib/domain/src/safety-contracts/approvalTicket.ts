// Phase 6 - Approval Inbox: ticket lifecycle and the material-terms binding.
//
// A guided trade becomes a ticket that a human must explicitly approve before
// anything can dispatch. This module is the pure lifecycle law; persistence and
// the atomic dispatch claim live in the repository, and the CAS in the database.
//
// Four rules do the real safety work here.
//
// 1. APPROVAL IS BOUND TO EXACT TERMS. `materialTermsFingerprint` hashes the
//    precise executable terms. The fingerprint is recorded when the user
//    approves, and re-derived at dispatch. Change the stake, the symbol, the
//    side, the account, the protection - anything the venue would act on - and
//    the fingerprints differ and dispatch refuses. The approval a user gave
//    cannot be transplanted onto a trade they never saw.
//
// 2. APPROVAL IS SCOPED. A ticket names one user, one broker, one account and
//    one intent. Another user's approval, or the same user's approval for a
//    different account, cannot authorize it.
//
// 3. TERMINAL IS TERMINAL. REJECTED, EXPIRED, CANCELLED and EXECUTED accept no
//    outgoing transition. An expired ticket can never later execute, which is
//    why expiry is checked against the DISPATCH clock, not only at read time.
//
// 4. UNRESOLVED RESOLVES ONLY ON VENUE EVIDENCE. An order whose fate is unknown
//    may not be recorded as executed or as never-sent because a timer elapsed
//    or a retry seemed safe. `resolveUnresolved` demands evidence, which is the
//    ticket-level expression of the governing invariant: ARX may be
//    conservative, but it may never be falsely certain.
//
// Contract-only: nothing here dispatches, and importing it unlocks nothing.

import { createHash } from "node:crypto";

export const APPROVAL_TICKET_STATES = [
  "PENDING",      // awaiting the human
  "APPROVED",     // human said yes; not yet claimed for dispatch
  "REJECTED",     // refused - NO order exists at the venue (terminal)
  "EXPIRED",      // the approval window elapsed (terminal)
  "DISPATCHING",  // exactly one dispatch claim was won; in flight
  "EXECUTED",     // venue-proven that an order exists (terminal)
  "UNRESOLVED",   // may or may not exist at the venue - NOT terminal
  "CANCELLED",    // withdrawn before dispatch (terminal)
] as const;
export type ApprovalTicketState = (typeof APPROVAL_TICKET_STATES)[number];

export const TERMINAL_TICKET_STATES: readonly ApprovalTicketState[] =
  ["REJECTED", "EXPIRED", "EXECUTED", "CANCELLED"] as const;

/**
 * Why a ticket was rejected. A user saying no and the transport proving it
 * never transmitted are both "no order exists", but conflating them in the
 * audit trail would hide a system refusal behind an apparent human decision.
 */
export const REJECTION_SOURCES = ["USER", "SYSTEM_PRE_TRANSMISSION", "SYSTEM_GATE"] as const;
export type RejectionSource = (typeof REJECTION_SOURCES)[number];

/**
 * The exact terms the venue would act on. Every field here is material: if it
 * can change what happens at the venue, it belongs in the fingerprint.
 */
export interface MaterialTradeTerms {
  userId: number;
  broker: string;
  accountRef: string;
  instrument: string;
  side: "BUY" | "SELL";
  stakeUsd: number;
  multiplier: number;
  /** Null means "no stop requested" - distinct from a stop of 0. */
  stopLossUsd: number | null;
  takeProfitUsd: number | null;
  /** The venue-neutral intent id this ticket authorizes. */
  intentId: string;
}

const FINGERPRINT_VERSION = "v1";

/**
 * A stable fingerprint over an EXPLICIT ordered field list.
 *
 * Deliberately not a generic object hasher: this repo already carries three
 * copies of `stableStringify` whose agreement is pinned by a parity test, and
 * adding a fourth would inherit that coupling. Naming the fields explicitly
 * also means adding a material field is a visible edit here rather than a
 * silent change in hash behaviour.
 *
 * Numbers go through a fixed decimal rendering so 1 and 1.0 agree, and null is
 * encoded distinctly from 0 and from the empty string. Every string is
 * length-prefixed so that ("ab","c") and ("a","bc") cannot collide.
 */
export function materialTermsFingerprint(t: MaterialTradeTerms): string {
  const num = (n: number | null): string =>
    n === null ? "|null|" : Number.isFinite(n) ? `|${n.toFixed(8)}|` : "|nan|";
  const str = (s: string): string => `|${s.length}:${s}|`;
  const canonical = [
    FINGERPRINT_VERSION,
    `|${t.userId}|`,
    str(t.broker),
    str(t.accountRef),
    str(t.instrument),
    str(t.side),
    num(t.stakeUsd),
    num(t.multiplier),
    num(t.stopLossUsd),
    num(t.takeProfitUsd),
    str(t.intentId),
  ].join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface ApprovalTicket {
  ticketId: string;
  /** The account owner. The only user this ticket can ever authorize. */
  userId: number;
  state: ApprovalTicketState;
  terms: MaterialTradeTerms;
  /** Fingerprint recorded at APPROVAL time. Null while PENDING. */
  approvedFingerprint: string | null;
  approvedByUserId: number | null;
  createdAtIso: string;
  expiresAtIso: string;
  /** Set when a dispatch claim is won. Non-null means an attempt happened. */
  dispatchClaimedAtIso: string | null;
  constitutionVersion: number;
  /** All 18 gate verdicts passed at proposal time. */
  gateVerdictsPassed: boolean;
  /**
   * True when gate 18 passed via an operator waiver rather than the user
   * actually accepting the risk disclosure. Carried explicitly so an inbox can
   * never present an operator waiver as the user's own consent.
   */
  disclosureWaivedByOperator: boolean;
}

export const DISPATCH_REFUSALS = [
  "TICKET_NOT_FOUND",
  "TICKET_NOT_APPROVED",
  "TICKET_REJECTED",
  "TICKET_EXPIRED",
  "TICKET_CANCELLED",
  "TICKET_ALREADY_DISPATCHED",
  "TICKET_ALREADY_EXECUTED",
  "TICKET_UNRESOLVED_BLOCKS_NEW_DISPATCH",
  "TERMS_CHANGED_SINCE_APPROVAL",
  "APPROVER_IS_NOT_THE_OWNER",
  "ACTOR_IS_NOT_THE_OWNER",
  "ACCOUNT_SCOPE_MISMATCH",
  "INTENT_SCOPE_MISMATCH",
  "GATES_DID_NOT_PASS",
  "SELF_APPROVAL_MISSING",
  "CLOCK_UNREADABLE",
] as const;
export type DispatchRefusal = (typeof DISPATCH_REFUSALS)[number];

export interface DispatchAuthorization {
  authorized: boolean;
  refusals: DispatchRefusal[];
  primaryRefusal: DispatchRefusal | null;
}

/**
 * May this ticket dispatch, right now, for this actor, against these terms?
 *
 * Default-deny and total: every unreadable input refuses. `currentTerms` is
 * what the dispatcher is ABOUT to send - re-derived from live state, never
 * echoed back from the ticket - so a mismatch means the trade drifted from
 * what the human actually approved.
 */
export function authorizeDispatch(args: {
  ticket: ApprovalTicket | null | undefined;
  actorUserId: number;
  currentTerms: MaterialTradeTerms;
  nowIso: string;
}): DispatchAuthorization {
  const out: DispatchRefusal[] = [];
  const deny = (): DispatchAuthorization => ({
    authorized: false, refusals: out, primaryRefusal: out[0] ?? null,
  });

  const t = args.ticket;
  if (!t) { out.push("TICKET_NOT_FOUND"); return deny(); }

  const now = new Date(args.nowIso);
  if (Number.isNaN(now.getTime())) { out.push("CLOCK_UNREADABLE"); return deny(); }
  const expires = new Date(t.expiresAtIso);
  if (Number.isNaN(expires.getTime())) { out.push("CLOCK_UNREADABLE"); return deny(); }

  // State first, most specific reason first.
  switch (t.state) {
    case "APPROVED": break;
    case "PENDING": out.push("TICKET_NOT_APPROVED"); break;
    case "REJECTED": out.push("TICKET_REJECTED"); break;
    case "EXPIRED": out.push("TICKET_EXPIRED"); break;
    case "CANCELLED": out.push("TICKET_CANCELLED"); break;
    case "DISPATCHING": out.push("TICKET_ALREADY_DISPATCHED"); break;
    case "EXECUTED": out.push("TICKET_ALREADY_EXECUTED"); break;
    case "UNRESOLVED": out.push("TICKET_UNRESOLVED_BLOCKS_NEW_DISPATCH"); break;
    default: out.push("TICKET_NOT_APPROVED"); break;
  }

  // Expiry is enforced against the DISPATCH clock, not only at read time: a
  // ticket approved inside its window must still refuse once the window closes.
  if (now.getTime() >= expires.getTime() && !out.includes("TICKET_EXPIRED")) {
    out.push("TICKET_EXPIRED");
  }

  // A dispatch claim already recorded means an order may exist. Even in a state
  // that otherwise looks dispatchable, refuse - this is the belt to the
  // database CAS's braces.
  if (t.dispatchClaimedAtIso !== null && !out.includes("TICKET_ALREADY_DISPATCHED")) {
    out.push("TICKET_ALREADY_DISPATCHED");
  }

  // Scope: the actor, the approver, the account and the intent must all be the
  // ticket's own. The actor check is what stops user A dispatching user B's
  // approved ticket.
  if (args.actorUserId !== t.userId) out.push("ACTOR_IS_NOT_THE_OWNER");
  if (t.approvedByUserId === null) out.push("SELF_APPROVAL_MISSING");
  else if (t.approvedByUserId !== t.userId) out.push("APPROVER_IS_NOT_THE_OWNER");

  if (args.currentTerms.userId !== t.userId && !out.includes("ACTOR_IS_NOT_THE_OWNER")) {
    out.push("ACTOR_IS_NOT_THE_OWNER");
  }
  if (args.currentTerms.accountRef !== t.terms.accountRef
      || args.currentTerms.broker !== t.terms.broker) {
    out.push("ACCOUNT_SCOPE_MISMATCH");
  }
  if (args.currentTerms.intentId !== t.terms.intentId) out.push("INTENT_SCOPE_MISMATCH");

  if (t.gateVerdictsPassed !== true) out.push("GATES_DID_NOT_PASS");

  // The binding: what is about to be sent must be identical in every material
  // field to what was approved.
  const approved = t.approvedFingerprint;
  if (approved === null) {
    if (!out.includes("TICKET_NOT_APPROVED")) out.push("TICKET_NOT_APPROVED");
  } else if (materialTermsFingerprint(args.currentTerms) !== approved) {
    out.push("TERMS_CHANGED_SINCE_APPROVAL");
  }

  return out.length === 0
    ? { authorized: true, refusals: [], primaryRefusal: null }
    : deny();
}

export const LEGAL_TICKET_TRANSITIONS: Readonly<Record<ApprovalTicketState, readonly ApprovalTicketState[]>> = {
  PENDING: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"],
  APPROVED: ["DISPATCHING", "EXPIRED", "CANCELLED", "REJECTED"],
  DISPATCHING: ["EXECUTED", "UNRESOLVED", "REJECTED"],
  // Resolvable ONLY on venue evidence - see resolveUnresolved.
  UNRESOLVED: ["EXECUTED", "REJECTED"],
  REJECTED: [],
  EXPIRED: [],
  EXECUTED: [],
  CANCELLED: [],
};

export function transitionIsLegal(from: ApprovalTicketState, to: ApprovalTicketState): boolean {
  const allowed = LEGAL_TICKET_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/** Venue evidence sufficient to resolve an UNRESOLVED ticket. */
export interface VenueResolutionEvidence {
  /** True only when the venue itself was read - never inferred from a timer. */
  venueRead: boolean;
  /**
   * True when the read covered CLOSED/settled contracts too. A read that lists
   * only OPEN positions cannot prove absence: the order may have opened and
   * closed between dispatch and read.
   */
  closedInclusive: boolean;
  /** The venue's contract/order reference, when one was found. */
  venueContractRef: string | null;
}

export type UnresolvedResolution =
  | { resolved: true; nextState: "EXECUTED" | "REJECTED"; rejectionSource?: RejectionSource }
  | { resolved: false; reason: string };

/**
 * Resolve an UNRESOLVED ticket, or refuse to.
 *
 * The absence rule is the important one: concluding "no order exists" requires
 * a CLOSED-INCLUSIVE venue read. A portfolio-style read that returns only
 * outstanding contracts omits an order that already settled, and treating that
 * omission as proof of absence is precisely the false-absence defect Phase 5
 * was hardened against.
 */
export function resolveUnresolved(evidence: VenueResolutionEvidence): UnresolvedResolution {
  if (evidence?.venueRead !== true) {
    return { resolved: false, reason: "no venue read was performed - a timer is not evidence" };
  }
  if (typeof evidence.venueContractRef === "string" && evidence.venueContractRef.trim() !== "") {
    return { resolved: true, nextState: "EXECUTED" };
  }
  if (evidence.closedInclusive !== true) {
    return {
      resolved: false,
      reason: "venue read was not closed-inclusive - absence from an open-positions read does not prove no order exists",
    };
  }
  return { resolved: true, nextState: "REJECTED", rejectionSource: "SYSTEM_PRE_TRANSMISSION" };
}
