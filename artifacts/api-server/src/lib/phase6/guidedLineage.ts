// Phase 6 — forensic lineage for a guided attempt.
//
// One question this must answer for any attempt, from one identifier:
//
//   what setup triggered it, what did Ruby say, what risk did ARX calculate,
//   which Constitution version governed, which gates passed, what did the user
//   approve, what intent was issued, was the frame written, what did the venue
//   return, and what is the position NOW?
//
// THE SPINE IS THE INTENT ID. Ticket, live command, Deriv intent, journal entry
// and debrief all carry it, so reconstruction is a lookup rather than a
// timestamp-correlation exercise. Timestamp correlation is how two concurrent
// attempts get merged into one story.
//
// HONESTY RULES.
//   - The state vocabulary distinguishes UNKNOWN from every terminal state, and
//     nothing maps UNKNOWN onto one.
//   - A position is never inferred. No venue-proven contract id means no
//     contract id is written — not an empty string, not a placeholder.
//   - Every payload passes assertNoSecretLeak before it is persisted, so a
//     credential cannot ride along in a detail string or a metadata blob.

import { assertNoSecretLeak } from "./derivDependencyResolver.js";

/**
 * The audit vocabulary. Each names a DIFFERENT epistemic situation, and the
 * distinctions are the point:
 *   - DRY_RUN_REFUSED is not VENUE_REJECTED. Nothing was sent.
 *   - VENUE_REJECTED is not EXECUTION_UNKNOWN. The venue replied and said no,
 *     which proves transmission and proves no position.
 *   - EXECUTION_UNKNOWN is not a failure and is NOT terminal.
 *   - CONTRADICTION is not UNKNOWN: it is two sources of venue truth
 *     disagreeing, which needs a human, not another poll.
 */
export const GUIDED_AUDIT_EVENTS = [
  "PROPOSAL_CREATED",
  "USER_APPROVED",
  "USER_REJECTED",
  "TICKET_EXPIRED",
  "DISPATCH_CLAIMED",
  "DRY_RUN_REFUSED",
  "GATE_REFUSED",
  "VENUE_REJECTED",
  "EXECUTED",
  "EXECUTION_UNKNOWN",
  "RECONCILED",
  "CONTRADICTION",
] as const;
export type GuidedAuditEvent = (typeof GUIDED_AUDIT_EVENTS)[number];

/** Terminal for the ATTEMPT. UNKNOWN and CONTRADICTION are deliberately absent. */
export const TERMINAL_AUDIT_EVENTS: readonly GuidedAuditEvent[] = [
  "USER_REJECTED", "TICKET_EXPIRED", "DRY_RUN_REFUSED",
  "GATE_REFUSED", "VENUE_REJECTED", "EXECUTED", "RECONCILED",
] as const;

/**
 * How a position may be represented. Mirrors the certified execution states so
 * a reader never has to translate between two vocabularies.
 */
export const GUIDED_POSITION_STATES = [
  "PENDING",
  "DISPATCHING",
  "OPEN",
  "CLOSED",
  "UNRESOLVED",
  "RECONCILIATION_REQUIRED",
] as const;
export type GuidedPositionState = (typeof GUIDED_POSITION_STATES)[number];

export interface GuidedLineageRecord {
  /** The spine. Present on every row of the attempt. */
  intentId: string;
  ticketId: string;
  userId: number;
  liveCommandId: string | null;
  event: GuidedAuditEvent;
  occurredAtIso: string;
  constitutionVersion: number;
  /** Venue-proven only. Null when nothing proved a contract exists. */
  venueContractRef: string | null;
  /** Free text for a human. Never a secret — asserted before persistence. */
  detail: string;
  scannerSignalId: string | null;
  rubyExplanation: string | null;
  /**
   * VENUE-REPORTED realized P/L. Permitted ONLY on RECONCILED (null = the
   * venue stated no number). Any other event carrying it is refused —
   * a P/L claim without a venue settlement behind it is a fabrication.
   */
  venueProfitUsd?: number | null;
}

/**
 * Map an audit event to how the position must be DISPLAYED.
 *
 * The forbidden inferences are unreachable here by construction:
 *   - EXECUTION_UNKNOWN maps to UNRESOLVED, never to CLOSED or to no-position.
 *   - VENUE_REJECTED maps to CLOSED only because the venue said so.
 *   - DRY_RUN_REFUSED maps to CLOSED with no contract — nothing was ever sent.
 *   - CONTRADICTION maps to RECONCILIATION_REQUIRED, never resolved by a poll.
 */
export function positionStateForEvent(event: GuidedAuditEvent): GuidedPositionState {
  switch (event) {
    case "PROPOSAL_CREATED":
    case "USER_APPROVED":
      return "PENDING";
    case "DISPATCH_CLAIMED":
      return "DISPATCHING";
    case "EXECUTED":
      return "OPEN";
    case "EXECUTION_UNKNOWN":
      return "UNRESOLVED";
    case "CONTRADICTION":
      return "RECONCILIATION_REQUIRED";
    case "USER_REJECTED":
    case "TICKET_EXPIRED":
    case "DRY_RUN_REFUSED":
    case "GATE_REFUSED":
    case "VENUE_REJECTED":
    case "RECONCILED":
      return "CLOSED";
    default: {
      // An unrecognised event must not silently become CLOSED. Claiming a
      // position is closed on the strength of not understanding an event is the
      // falsely-certain direction.
      const never: never = event;
      void never;
      return "RECONCILIATION_REQUIRED";
    }
  }
}

/**
 * Human-facing text for a state. UNRESOLVED must never read as "no trade",
 * "failed" or "closed" — a caller pasting this into a UI must not be able to
 * mislead by accident.
 */
export function positionStateLabel(state: GuidedPositionState): string {
  switch (state) {
    case "PENDING": return "Awaiting your approval";
    case "DISPATCHING": return "Sending to the venue";
    case "OPEN": return "Open at the venue";
    case "CLOSED": return "Closed";
    case "UNRESOLVED": return "Outcome unknown — an order may exist at the venue";
    case "RECONCILIATION_REQUIRED": return "Needs reconciliation — sources disagree";
  }
}

/**
 * Build a lineage record, refusing anything dishonest.
 *
 * Throws rather than sanitising: a caller passing a contract id for an UNKNOWN
 * outcome has a bug, and silently dropping the field would hide it.
 */
export function buildLineageRecord(r: GuidedLineageRecord): GuidedLineageRecord {
  if (typeof r.intentId !== "string" || r.intentId.trim() === "") {
    throw new Error("LINEAGE_REFUSED: an attempt with no intent id cannot be reconstructed");
  }
  if (r.event === "EXECUTION_UNKNOWN" && r.venueContractRef !== null) {
    throw new Error("LINEAGE_REFUSED: an UNKNOWN outcome cannot carry a venue contract reference");
  }
  if (r.event === "EXECUTED" && (typeof r.venueContractRef !== "string" || r.venueContractRef.trim() === "")) {
    throw new Error("LINEAGE_REFUSED: EXECUTED requires the venue's own contract reference");
  }
  if (r.event === "DRY_RUN_REFUSED" && r.venueContractRef !== null) {
    throw new Error("LINEAGE_REFUSED: a dry run cannot produce a venue contract reference");
  }
  if (r.event === "RECONCILED" && (typeof r.venueContractRef !== "string" || r.venueContractRef.trim() === "")) {
    throw new Error("LINEAGE_REFUSED: RECONCILED is venue evidence by definition and requires the venue's contract reference");
  }
  if (r.event !== "RECONCILED" && r.venueProfitUsd !== undefined && r.venueProfitUsd !== null) {
    throw new Error("LINEAGE_REFUSED: a realized P/L may only ride on a RECONCILED event — anywhere else it is a claim without a settlement");
  }
  assertNoSecretLeak(r, "guided lineage record");
  return r;
}

/**
 * Reconstruct one attempt from its records.
 *
 * The CURRENT state is derived from the LAST record, except that UNRESOLVED and
 * RECONCILIATION_REQUIRED are sticky: once an attempt is uncertain, a later
 * record cannot quietly make it certain again unless that record is itself a
 * resolution (RECONCILED / EXECUTED / VENUE_REJECTED), which by definition
 * carries venue evidence.
 */
export function reconstructAttempt(records: readonly GuidedLineageRecord[]): {
  intentId: string | null;
  state: GuidedPositionState;
  venueContractRef: string | null;
  events: GuidedAuditEvent[];
  complete: boolean;
} {
  if (records.length === 0) {
    return { intentId: null, state: "RECONCILIATION_REQUIRED", venueContractRef: null, events: [], complete: false };
  }
  const events = records.map((r) => r.event);
  let state: GuidedPositionState = "PENDING";
  let contract: string | null = null;
  let uncertain = false;

  for (const r of records) {
    const next = positionStateForEvent(r.event);
    if (r.venueContractRef) contract = r.venueContractRef;
    if (next === "UNRESOLVED" || next === "RECONCILIATION_REQUIRED") {
      uncertain = true;
      state = next;
      continue;
    }
    // Only a record carrying venue evidence may lift uncertainty.
    const resolves = r.event === "RECONCILED" || r.event === "EXECUTED" || r.event === "VENUE_REJECTED";
    if (uncertain && !resolves) continue;
    if (uncertain && resolves) uncertain = false;
    state = next;
  }

  // An attempt is only "complete" when it reached a terminal event AND is not
  // still uncertain.
  const last = events[events.length - 1] as GuidedAuditEvent;
  const complete = !uncertain && TERMINAL_AUDIT_EVENTS.includes(last);
  return { intentId: records[0]!.intentId, state, venueContractRef: contract, events, complete };
}
