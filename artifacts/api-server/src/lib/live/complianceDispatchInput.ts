// Capability #52 — compliance-eligibility consult for the LIVE dispatch path.
//
// The pure evaluator lives in @workspace/domain/compliance-gate. This module
// assembles its input from the broker_eligibility row for the dispatching
// user × venue and returns the verdict block that liveCommandPipeline passes
// into gate #3 (USER_NOT_LIVE_APPROVED) of the Phase B evaluator.
//
// DEFAULT-DENY, honestly typed:
//   * No broker_eligibility row      → status null → the gate refuses
//     (ELIGIBILITY_STATUS_UNKNOWN) exactly like the COMPLIANCE_HOLD default.
//   * relationshipToMaster unknown   → outsideClientFunds null → refuses
//     (OUTSIDE_CLIENT_FUNDS_UNKNOWN). Never coerced to false.
//   * DB read failure                → typed ELIGIBILITY_READ_FAILED refusal.
//     A failed read is NEVER treated as "no restrictions".
//   * Two rows matching the venue case-insensitively ("MT5" and "mt5") →
//     BOTH must allow; reasons union otherwise. Ambiguity never resolves
//     in the permissive direction.
//
// Venue-approval posture mirrors routes/brokerCatalog.ts: MT5 (the user's own
// terminal / the owner-operated shared master, per-user bridge token) does not
// demand a separate per-user venue approval — the eligibility review itself is
// the approval surface here.

import { eq } from "drizzle-orm";
import { db, brokerEligibilityTable } from "@workspace/db";
import { evaluateComplianceGate } from "@workspace/domain/compliance-gate";
import { logger } from "../logger.js";

/** Typed reason for a failed eligibility read (service-level, not domain vocab). */
export const ELIGIBILITY_READ_FAILED = "ELIGIBILITY_READ_FAILED" as const;

/** The venue the Phase B MT5 pipeline dispatches to. Matches brokerCatalog. */
export const LIVE_DISPATCH_VENUE = "MT5" as const;

/** Mirrors routes/brokerCatalog.ts VENUE_REQUIRES_APPROVAL for MT5. */
const MT5_VENUE_REQUIRES_APPROVAL = false;

export interface ComplianceEligibilityVerdict {
  allowed: boolean;
  reasons: string[];
}

interface EligibilityRowFacts {
  venueCode: string;
  eligibilityStatus: string | null;
  relationshipToMaster: string | null;
}

/**
 * PURE: map broker_eligibility row facts to the compliance verdict for one
 * live-dispatch attempt. Exported for the offline test lane.
 *
 * `rows` = every broker_eligibility row for this user whose venueCode matches
 * the dispatch venue case-insensitively. Empty = never reviewed = refuse.
 */
export function verdictFromEligibilityRows(
  rows: EligibilityRowFacts[],
): ComplianceEligibilityVerdict {
  const matching = rows.filter(
    (r) => r.venueCode.toUpperCase() === LIVE_DISPATCH_VENUE,
  );

  if (matching.length === 0) {
    // Absence of a review refuses exactly like the COMPLIANCE_HOLD default:
    // evaluate the gate with a null status so the refusal carries the honest
    // domain reason code rather than an invented one.
    const d = evaluateComplianceGate({
      eligibilityStatus: null,
      venueRequiresApproval: MT5_VENUE_REQUIRES_APPROVAL,
      outsideClientFunds: null,
    });
    return { allowed: false, reasons: [...d.reasons] };
  }

  // Every matching row must allow; the union of refusal reasons is returned.
  // (Two rows can match when "MT5" and "mt5" both exist — ambiguity refuses
  // unless both agree to allow.)
  const reasons = new Set<string>();
  let allAllowed = true;
  for (const row of matching) {
    const d = evaluateComplianceGate({
      eligibilityStatus: row.eligibilityStatus,
      venueRequiresApproval: MT5_VENUE_REQUIRES_APPROVAL,
      outsideClientFunds: outsideClientFundsFromRelationship(row.relationshipToMaster),
    });
    if (!d.allowed) {
      allAllowed = false;
      for (const r of d.reasons) reasons.add(r);
    }
  }
  return allAllowed
    ? { allowed: true, reasons: [] }
    : { allowed: false, reasons: [...reasons] };
}

/**
 * PURE: derive the outside-client-funds attestation from the reviewed
 * relationship_to_master value. Only the exact reviewed vocabulary maps to an
 * explicit boolean; anything else stays null (unknown → the gate refuses).
 * Exported for the offline test lane.
 */
export function outsideClientFundsFromRelationship(
  relationshipToMaster: string | null | undefined,
): boolean | null {
  switch (relationshipToMaster) {
    case "SELF":
    case "SAME_ENTITY_OPERATOR":
    case "EMPLOYEE_OF_OWNER":
      return false;
    case "OUTSIDE_CLIENT":
      return true;
    default:
      return null;
  }
}

/**
 * Read this user's eligibility rows and produce the compliance verdict for
 * the Phase B evaluator's gate #3. NEVER throws: a read failure returns a
 * typed refusal (fail-closed), logged loudly.
 */
export async function buildComplianceEligibilityVerdict(
  userId: number,
): Promise<ComplianceEligibilityVerdict> {
  try {
    const rows = await db
      .select({
        venueCode: brokerEligibilityTable.venueCode,
        eligibilityStatus: brokerEligibilityTable.eligibilityStatus,
        relationshipToMaster: brokerEligibilityTable.relationshipToMaster,
      })
      .from(brokerEligibilityTable)
      .where(eq(brokerEligibilityTable.userId, userId));
    return verdictFromEligibilityRows(rows);
  } catch (err) {
    logger.warn(
      { err, userId },
      "compliance_eligibility_read_failed_fail_closed_live_dispatch",
    );
    return { allowed: false, reasons: [ELIGIBILITY_READ_FAILED] };
  }
}
