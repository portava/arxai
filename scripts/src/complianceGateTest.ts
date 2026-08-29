// Test: compliance/eligibility gate pure core
// (lib/domain/src/compliance-gate — R6 Phase 0, blueprint §70, spec §1.3/§9).
//
// What this suite pins, and why each pin exists:
//
//   1. THE INVIOLABLE. outsideClientFunds=true refuses for EVERY status —
//      including ELIGIBLE — with OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL.
//      Blueprint §70 (~L2399): outside-client managed accounts remain
//      COMPLIANCE_HOLD until the required approvals exist; ~L2817: until
//      jurisdiction-specific counsel and broker approval are documented;
//      ~L4025: engineering cannot decide whether it is lawful. If any status
//      or flag combination ever overrides this, these loops go red.
//
//   2. DEFAULT-DENY ON THE UNKNOWN. Unknown funds provenance, unknown/missing
//      status, wrong-case status strings, and unknown venue-approval posture
//      (for RESTRICTED) all refuse. Nothing is coerced permissively.
//
//   3. STATUS SEMANTICS. COMPLIANCE_HOLD and INELIGIBLE always refuse;
//      RESTRICTED passes only on venues verifiably NOT requiring approval;
//      ELIGIBLE (the explicit, reviewed approval) passes venues of either
//      posture.
//
//   4. REASONS ACCUMULATE. All applicable refusal codes are returned, not
//      just the first one hit.
//
//   5. SCHEMA CROSS-PIN. lib/db cannot import @workspace/domain, so the
//      broker_eligibility schema repeats the status vocabulary and the
//      fail-closed default as literals. This test reads BOTH source files and
//      pins them to the domain constants, so vocabulary drift or a weakened
//      default (e.g. someone flipping the column default to ELIGIBLE) goes
//      red here instead of shipping.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { complianceGate } from "@workspace/domain";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const {
  evaluateComplianceGate,
  ELIGIBILITY_STATUSES,
  DEFAULT_ELIGIBILITY_STATUS,
  OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL,
  OUTSIDE_CLIENT_FUNDS_UNKNOWN,
  ELIGIBILITY_COMPLIANCE_HOLD,
  ELIGIBILITY_INELIGIBLE,
  ELIGIBILITY_READ_ONLY,
  ELIGIBILITY_STATUS_UNKNOWN,
  RESTRICTED_VENUE_REQUIRES_APPROVAL,
  VENUE_APPROVAL_REQUIREMENT_UNKNOWN,
} = complianceGate;

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }

  console.log("complianceGateTest");
  console.log("==================\n");

  // ── 1. The inviolable: outside-client funds refuse regardless of status ───
  console.log("Inviolable outside-client hold (blueprint §70 / L2817)");
  {
    const statusVariants: (string | null | undefined)[] = [
      ...ELIGIBILITY_STATUSES,
      null,
      undefined,
      "eligible",
      "GARBAGE",
    ];
    let allRefused = true;
    let allCarryReason = true;
    for (const eligibilityStatus of statusVariants) {
      for (const venueRequiresApproval of [true, false, null, undefined]) {
        const d = evaluateComplianceGate({
          eligibilityStatus,
          venueRequiresApproval,
          outsideClientFunds: true,
        });
        if (d.allowed) allRefused = false;
        if (!d.reasons.includes(OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL)) allCarryReason = false;
      }
    }
    assert(allRefused, "outsideClientFunds=true refuses for EVERY status × venue posture (incl. ELIGIBLE)");
    assert(allCarryReason, "…and every refusal names OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL");

    // Truthy garbage never passes as `false`.
    const stringFalse = evaluateComplianceGate({
      eligibilityStatus: "ELIGIBLE",
      venueRequiresApproval: false,
      // deliberately wrong type, as a corrupted caller might supply
      outsideClientFunds: "false" as unknown as boolean,
    });
    assert(
      !stringFalse.allowed && stringFalse.reasons.includes(OUTSIDE_CLIENT_FUNDS_UNKNOWN),
      'the string "false" is NOT the boolean false — refuses as unknown provenance',
    );

    for (const unknownFunds of [null, undefined]) {
      const d = evaluateComplianceGate({
        eligibilityStatus: "ELIGIBLE",
        venueRequiresApproval: false,
        outsideClientFunds: unknownFunds,
      });
      assert(
        !d.allowed && d.reasons.includes(OUTSIDE_CLIENT_FUNDS_UNKNOWN),
        `outsideClientFunds=${String(unknownFunds)} refuses with OUTSIDE_CLIENT_FUNDS_UNKNOWN`,
      );
    }
  }

  // ── 2. Status semantics with clean funds provenance ───────────────────────
  console.log("\nStatus semantics (outsideClientFunds=false)");
  {
    const gate = (eligibilityStatus: string | null | undefined, venueRequiresApproval: boolean | null | undefined) =>
      evaluateComplianceGate({ eligibilityStatus, venueRequiresApproval, outsideClientFunds: false });

    for (const posture of [true, false, null]) {
      const hold = gate("COMPLIANCE_HOLD", posture);
      assert(
        !hold.allowed && hold.reasons.includes(ELIGIBILITY_COMPLIANCE_HOLD),
        `COMPLIANCE_HOLD refuses (venueRequiresApproval=${String(posture)})`,
      );
      const inel = gate("INELIGIBLE", posture);
      assert(
        !inel.allowed && inel.reasons.includes(ELIGIBILITY_INELIGIBLE),
        `INELIGIBLE refuses (venueRequiresApproval=${String(posture)})`,
      );
      const ok = gate("ELIGIBLE", posture);
      assert(
        ok.allowed && ok.reasons.length === 0,
        `ELIGIBLE allows with empty reasons (venueRequiresApproval=${String(posture)} — explicit review satisfies either posture)`,
      );
    }

    // Capability #52 — READ_ONLY: reviewed "view but never trade". Trading
    // interactions refuse with exactly ELIGIBILITY_READ_ONLY as the reason
    // (so a read surface can distinguish it from a hard refusal).
    for (const posture of [true, false, null]) {
      const ro = gate("READ_ONLY", posture);
      assert(
        !ro.allowed && ro.reasons.includes(ELIGIBILITY_READ_ONLY) && ro.reasons.length === 1,
        `READ_ONLY refuses trading with exactly [ELIGIBILITY_READ_ONLY] (venueRequiresApproval=${String(posture)})`,
      );
    }
    // Wrong-case / padded READ_ONLY never matches — exact vocabulary only.
    for (const stranger of ["read_only", "Read_Only", " READ_ONLY "]) {
      const d = gate(stranger, false);
      assert(
        !d.allowed && d.reasons.includes(ELIGIBILITY_STATUS_UNKNOWN),
        `status ${JSON.stringify(stranger)} refuses as unknown (READ_ONLY is case-exact)`,
      );
    }

    const restrictedOpen = gate("RESTRICTED", false);
    assert(restrictedOpen.allowed, "RESTRICTED allows on a venue verifiably NOT requiring approval");
    const restrictedGated = gate("RESTRICTED", true);
    assert(
      !restrictedGated.allowed && restrictedGated.reasons.includes(RESTRICTED_VENUE_REQUIRES_APPROVAL),
      "RESTRICTED refuses on an approval-required venue",
    );
    for (const unknownPosture of [null, undefined]) {
      const d = gate("RESTRICTED", unknownPosture);
      assert(
        !d.allowed && d.reasons.includes(VENUE_APPROVAL_REQUIREMENT_UNKNOWN),
        `RESTRICTED with venueRequiresApproval=${String(unknownPosture)} refuses (unknown posture)`,
      );
    }

    for (const stranger of [null, undefined, "", "eligible", "Eligible", "APPROVED", " ELIGIBLE "]) {
      const d = gate(stranger, false);
      assert(
        !d.allowed && d.reasons.includes(ELIGIBILITY_STATUS_UNKNOWN),
        `status ${JSON.stringify(stranger)} refuses with ELIGIBILITY_STATUS_UNKNOWN (exact vocabulary, no coercion)`,
      );
    }
  }

  // ── 3. Reasons accumulate; evaluator is pure ──────────────────────────────
  console.log("\nReason accumulation + purity");
  {
    const both = evaluateComplianceGate({
      eligibilityStatus: "COMPLIANCE_HOLD",
      venueRequiresApproval: true,
      outsideClientFunds: true,
    });
    assert(
      !both.allowed &&
        both.reasons.includes(OUTSIDE_CLIENT_FUNDS_HELD_FOR_COUNSEL) &&
        both.reasons.includes(ELIGIBILITY_COMPLIANCE_HOLD) &&
        both.reasons.length === 2,
      "outside-client + hold returns BOTH refusal codes (no short-circuit)",
    );

    const a = evaluateComplianceGate({ eligibilityStatus: "RESTRICTED", venueRequiresApproval: null, outsideClientFunds: null });
    const b = evaluateComplianceGate({ eligibilityStatus: "RESTRICTED", venueRequiresApproval: null, outsideClientFunds: null });
    assert(JSON.stringify(a) === JSON.stringify(b), "evaluator is pure and deterministic");
    assert(
      a.reasons.includes(OUTSIDE_CLIENT_FUNDS_UNKNOWN) && a.reasons.includes(VENUE_APPROVAL_REQUIREMENT_UNKNOWN),
      "…and the all-unknown input collects every applicable unknown-refusal",
    );
  }

  // ── 4. Cross-pins: domain constant, schema literals, inviolable comment ───
  console.log("\nCross-pins (domain ↔ db schema ↔ citation)");
  {
    assert(
      DEFAULT_ELIGIBILITY_STATUS === "COMPLIANCE_HOLD",
      "DEFAULT_ELIGIBILITY_STATUS is COMPLIANCE_HOLD (spec §1.3 fail-closed posture)",
    );
    assert(
      ELIGIBILITY_STATUSES.length === 5 &&
        (["ELIGIBLE", "RESTRICTED", "READ_ONLY", "COMPLIANCE_HOLD", "INELIGIBLE"] as const).every((s) =>
          (ELIGIBILITY_STATUSES as readonly string[]).includes(s),
        ),
      "domain vocabulary is the blueprint §70 statuses + READ_ONLY (capability #52 five-outcome spec)",
    );

    // lib/db must not import @workspace/domain, so the schema repeats the
    // literals — pin the schema SOURCE to the domain constants (drift alarm).
    const schemaSource = readFileSync(
      fileURLToPath(new URL("../../lib/db/src/schema/brokerEligibility.ts", import.meta.url)),
      "utf8",
    );
    assert(
      schemaSource.includes('.default("COMPLIANCE_HOLD")'),
      "broker_eligibility.eligibility_status defaults to COMPLIANCE_HOLD in the schema source",
    );
    assert(
      (ELIGIBILITY_STATUSES as readonly string[]).every((s) => schemaSource.includes(`"${s}"`)),
      "schema source lists the exact same five status literals",
    );
    assert(
      !schemaSource.includes('.default("ELIGIBLE")'),
      "no column in the schema defaults to ELIGIBLE (nothing becomes tradable by row creation)",
    );
    assert(
      schemaSource.includes('uniqueIndex("broker_eligibility_user_venue_uq")'),
      "one governing row per user × venue is uniqueness-enforced (ambiguity must not resolve permissively)",
    );

    // The inviolable must remain marked as such, with its citation, in the
    // gate source — a silent rewrite of the comment is a red flag by itself.
    const gateSource = readFileSync(
      fileURLToPath(new URL("../../lib/domain/src/compliance-gate/eligibilityGate.ts", import.meta.url)),
      "utf8",
    );
    assert(
      gateSource.includes("INVIOLABLE") && gateSource.includes("§70"),
      "eligibilityGate.ts keeps the INVIOLABLE marker and the blueprint §70 citation",
    );
    assert(
      !gateSource.includes("bypass") || gateSource.includes("no bypass parameter"),
      "the gate source contains no bypass affordance beyond the explicit 'no bypass parameter' statement",
    );
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "complianceGateTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[complianceGateTest] FAILED:", err);
      process.exit(1);
    },
  );
}
