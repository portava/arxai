// ── Compliance & eligibility gate: pure refusal evaluator (R6 Phase 0) ──────
//
// Blueprint §70 "Compliance and Eligibility Gate": outputs ELIGIBLE /
// RESTRICTED / COMPLIANCE_HOLD / INELIGIBLE with reasons; safety behavior is
// "Outside-client managed accounts remain COMPLIANCE_HOLD until the required
// approvals exist" (MASTER_BLUEPRINT_EXTRACTED.md ~L2399), reinforced at
// ~L2817: "Keep outside-client managed accounts in COMPLIANCE_HOLD until
// jurisdiction-specific counsel and broker approval are documented" and
// ~L4025: "Engineering cannot decide whether outside-client management is
// lawful."
//
// Pure and deterministic: no IO, no DB, no clock, no imports outside this
// package. Wiring into routes / the dispatch pipeline is a separate slice
// (liveCommandPipeline.ts is owned by another agent this wave).
//
// Refusal philosophy (matches risk-correlation and the kill-switch pre-gate):
//   - DEFAULT-DENY. Anything unknown, missing, or malformed REFUSES — an
//     unrecognized status is never coerced to the nearest permissive one.
//   - ALL applicable refusal reasons are collected (no short-circuit), so a
//     caller can show the complete picture instead of one-at-a-time failures.
//   - Allowing requires the input to prove eligibility; refusing requires
//     nothing.

/**
 * Canonical status vocabulary (blueprint §70). The DB schema
 * (lib/db/src/schema/brokerEligibility.ts) repeats these literals because
 * lib/db does not depend on this package; scripts/src/complianceGateTest.ts
 * pins the two against each other.
 */
export const ELIGIBILITY_STATUSES = [
  "ELIGIBLE",
  "RESTRICTED",
  "COMPLIANCE_HOLD",
  "INELIGIBLE",
] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

/** The fail-closed default posture (spec §1.3) — mirrors the DB column default. */
export const DEFAULT_ELIGIBILITY_STATUS: EligibilityStatus = "COMPLIANCE_HOLD";

// ── Refusal reason codes ─────────────────────────────────────────────────────

/** Outside-client funds attested true — held for counsel (inviolable, see below). */
export const OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL =
  "OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL" as const;
/** Outside-client-funds provenance not verifiably false — unknown refuses. */
export const OUTSIDE_CLIENT_FUNDS_UNKNOWN =
  "OUTSIDE_CLIENT_FUNDS_UNKNOWN" as const;
/** Status is COMPLIANCE_HOLD (the default posture; nothing reviewed it open). */
export const ELIGIBILITY_COMPLIANCE_HOLD =
  "ELIGIBILITY_COMPLIANCE_HOLD" as const;
/** Status is INELIGIBLE (reviewed and refused). */
export const ELIGIBILITY_INELIGIBLE = "ELIGIBILITY_INELIGIBLE" as const;
/** Status missing or not in the exact vocabulary (case-sensitive) — refuses. */
export const ELIGIBILITY_STATUS_UNKNOWN =
  "ELIGIBILITY_STATUS_UNKNOWN" as const;
/** RESTRICTED user on a venue that requires explicit approval — refuses. */
export const RESTRICTED_VENUE_REQUIRES_APPROVAL =
  "RESTRICTED_VENUE_REQUIRES_APPROVAL" as const;
/** RESTRICTED user, but the venue's approval requirement is unknown — refuses. */
export const VENUE_APPROVAL_REQUIREMENT_UNKNOWN =
  "VENUE_APPROVAL_REQUIREMENT_UNKNOWN" as const;

export type ComplianceRefusalReason =
  | typeof OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL
  | typeof OUTSIDE_CLIENT_FUNDS_UNKNOWN
  | typeof ELIGIBILITY_COMPLIANCE_HOLD
  | typeof ELIGIBILITY_INELIGIBLE
  | typeof ELIGIBILITY_STATUS_UNKNOWN
  | typeof RESTRICTED_VENUE_REQUIRES_APPROVAL
  | typeof VENUE_APPROVAL_REQUIREMENT_UNKNOWN;

export interface ComplianceGateInput {
  /**
   * The broker_eligibility row's status for this user × venue. Pass
   * null/undefined when NO row exists — the absence of a review refuses
   * exactly like the COMPLIANCE_HOLD default would.
   * Typed `string` (not EligibilityStatus) on purpose: this gate is the
   * validator, so it must accept whatever the DB actually contains and refuse
   * what it cannot vouch for.
   */
  eligibilityStatus: string | null | undefined;
  /**
   * Whether this venue demands an explicit per-user eligibility approval
   * before any activity. Only consulted for RESTRICTED users: an ELIGIBLE
   * status IS the explicit approval (reviewedBy/reviewedAt-stamped), so it
   * satisfies venues of either posture, while COMPLIANCE_HOLD/INELIGIBLE
   * refuse before the venue posture can matter.
   */
  venueRequiresApproval: boolean | null | undefined;
  /**
   * Whether the account/funds behind this activity belong to an outside
   * client (not the operator/same entity). Must be an EXPLICIT `false` to
   * pass — unknown provenance refuses.
   */
  outsideClientFunds: boolean | null | undefined;
}

export interface ComplianceGateDecision {
  allowed: boolean;
  /** Empty exactly when allowed; otherwise every applicable refusal code. */
  reasons: ComplianceRefusalReason[];
}

/**
 * Evaluate the compliance gate for one user × venue interaction.
 *
 * INVIOLABLE — blueprint §70 (~L2399) / ~L2817 / ~L4025: outside-client
 * managed funds are refused REGARDLESS of eligibility status — an ELIGIBLE
 * review does not override it, no flag relaxes it, and this function takes
 * no bypass parameter. Lifting the hold is a counsel/owner decision that must
 * arrive as a changed INPUT (outsideClientFunds === false after documented
 * approvals), never as new logic in this function.
 */
export function evaluateComplianceGate(
  input: ComplianceGateInput,
): ComplianceGateDecision {
  const reasons: ComplianceRefusalReason[] = [];

  // 1. INVIOLABLE outside-client hold (checked first, independent of status).
  //    Strict-equality on `true` vs everything-else keeps truthy garbage
  //    (e.g. the string "false") from ever passing.
  if (input.outsideClientFunds === true) {
    reasons.push(OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL);
  } else if (input.outsideClientFunds !== false) {
    reasons.push(OUTSIDE_CLIENT_FUNDS_UNKNOWN);
  }

  // 2. Eligibility status (exact, case-sensitive vocabulary).
  const status = input.eligibilityStatus;
  if (status === "COMPLIANCE_HOLD") {
    reasons.push(ELIGIBILITY_COMPLIANCE_HOLD);
  } else if (status === "INELIGIBLE") {
    reasons.push(ELIGIBILITY_INELIGIBLE);
  } else if (status === "RESTRICTED") {
    if (input.venueRequiresApproval === true) {
      reasons.push(RESTRICTED_VENUE_REQUIRES_APPROVAL);
    } else if (input.venueRequiresApproval !== false) {
      reasons.push(VENUE_APPROVAL_REQUIREMENT_UNKNOWN);
    }
    // RESTRICTED on a venue that verifiably does not require approval passes
    // this gate; the restriction's operational limits are enforced elsewhere.
  } else if (status !== "ELIGIBLE") {
    // null, undefined, wrong case, or any stranger string: refuse honestly.
    reasons.push(ELIGIBILITY_STATUS_UNKNOWN);
  }
  // ELIGIBLE adds no reason: the explicit review satisfies venues of either
  // approval posture, so venueRequiresApproval is genuinely moot for it.

  return reasons.length > 0
    ? { allowed: false, reasons }
    : { allowed: true, reasons: [] };
}
