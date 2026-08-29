// Capability #52 — compliance-eligibility consult in the live dispatch path.
//
// Pins, offline (no DB, no network):
//   1. GATE #3 CONSULT. A supplied refusing compliance verdict fails gate #3
//      (USER_NOT_LIVE_APPROVED) even when the admin approval flag is true —
//      and can never rescue a missing admin approval.
//   2. NULL = NOT EVALUATED, LOUDLY. Omitted compliance leaves gate #3's
//      legacy behavior intact but stamps the "NOT evaluated" detail.
//   3. READ_ONLY REFUSES DISPATCH. The new vocabulary entry refuses trading
//      with exactly ELIGIBILITY_READ_ONLY.
//   4. ROW→VERDICT MAPPING (pure part of the dispatch builder): no row
//      refuses; READ_ONLY/HOLD refuse; a reviewed SELF+ELIGIBLE row allows;
//      case-mismatched duplicate venue rows must BOTH allow; unknown
//      relationship refuses as unknown funds provenance.
//   5. WIRING PIN. liveCommandPipeline.ts supplies `complianceEligibility`
//      to the evaluator on the dispatch path (source pin, like the
//      foundation-gates pin) and the evaluator input names the field.
//   6. CLOSE-PATH POSTURE. A refusing verdict is degraded to ADVISORY for
//      exactly CLOSE_LIVE_POSITION (recorded, not blocking — a compliance
//      hold must never trap an open position); entries and MODIFY_LIVE_SLTP
//      stay fully blocked; advisory can never rescue a missing admin
//      approval; the pipeline applies the posture with row.commandType.
//   7. ADMIN ROUTE MERGE INVIOLABLE. The PUT route's OUTSIDE_CLIENT→
//      COMPLIANCE_HOLD 422 evaluates the POST-MERGE effective relationship:
//      omitting (or null-ing) relationshipToMaster against an existing
//      OUTSIDE_CLIENT row cannot store OUTSIDE_CLIENT + ELIGIBLE.
//
// Run: node --import tsx --test src/lib/live/__qa__/complianceDispatchConsult.test.ts

process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Dynamic imports: ESM hoists static imports above the env dummies, and the
// dispatch-input module transitively imports @workspace/db (env-checked).
import type { LivePhaseBGateInput } from "@workspace/domain/safety-contracts";
const { evaluateLivePhaseBDispatchGate } = await import("@workspace/domain/safety-contracts");
const { evaluateComplianceGate, ELIGIBILITY_READ_ONLY } =
  await import("@workspace/domain/compliance-gate");
const { verdictFromEligibilityRows, outsideClientFundsFromRelationship, complianceVerdictForCommand } =
  await import("../complianceDispatchInput.js");
const { outsideClientHoldViolation } = await import("../../../routes/adminCompliance.js");

/** A gate input that passes every gate (compliance omitted). */
function passingInput(): LivePhaseBGateInput {
  return {
    liveBrokerExecutionEnabled: true,
    globalLiveEnabled: true,
    userLiveApproved: true,
    userArmed: true,
    killSwitchEngaged: false,
    bridgeAccountType: "live",
    bridgeHeartbeatAgeSec: 2,
    bridgeEaVersion: "1.30",
    bridgeEnableLiveExecution: true,
    bridgeReadOnlyMode: false,
    bridgeTerminalConnected: true,
    bridgeAlgoTradingAllowed: true,
    commandSymbol: "EURUSD",
    commandVolume: 0.01,
    commandHasStopLoss: true,
    allowedSymbols: ["EURUSD"],
    maxLotForSymbol: 1,
    dailyLossLimitUsd: 0,
    realisedDailyLossUsd: 0,
    requireStopLoss: true,
    adminAllowNoStopLoss: false,
    requireTakeProfit: true,
    adminAllowNoTakeProfit: false,
    commandHasTakeProfit: true,
    disclosureAccepted: true,
  };
}

test("gate #3 fails when a supplied compliance verdict refuses — admin approval does not override", () => {
  const r = evaluateLivePhaseBDispatchGate({
    ...passingInput(),
    complianceEligibility: { allowed: false, reasons: [ELIGIBILITY_READ_ONLY] },
  });
  assert.equal(r.decision, "BLOCKED");
  assert.ok(r.blockReasons.includes("USER_NOT_LIVE_APPROVED"));
  const g3 = r.gates.find((g) => g.key === "USER_NOT_LIVE_APPROVED");
  assert.ok(g3 && !g3.passed);
  assert.ok(g3.detail?.includes(ELIGIBILITY_READ_ONLY), "detail names the refusal reason");
});

test("gate #3 passes when the compliance verdict allows (all else green)", () => {
  const r = evaluateLivePhaseBDispatchGate({
    ...passingInput(),
    complianceEligibility: { allowed: true, reasons: [] },
  });
  assert.equal(r.decision, "PASS");
});

test("compliance can never rescue a missing admin approval", () => {
  const r = evaluateLivePhaseBDispatchGate({
    ...passingInput(),
    userLiveApproved: false,
    complianceEligibility: { allowed: true, reasons: [] },
  });
  assert.equal(r.decision, "BLOCKED");
  assert.ok(r.blockReasons.includes("USER_NOT_LIVE_APPROVED"));
});

test("omitted compliance = legacy behavior, stamped NOT evaluated (loud)", () => {
  const r = evaluateLivePhaseBDispatchGate(passingInput());
  assert.equal(r.decision, "PASS");
  const g3 = r.gates.find((g) => g.key === "USER_NOT_LIVE_APPROVED");
  assert.ok(g3?.passed);
  assert.ok(g3?.detail?.includes("NOT evaluated"), "null branch must be loud, never silent");
});

test("READ_ONLY status refuses a trading interaction with exactly its reason", () => {
  const d = evaluateComplianceGate({
    eligibilityStatus: "READ_ONLY",
    venueRequiresApproval: false,
    outsideClientFunds: false,
  });
  assert.equal(d.allowed, false);
  assert.deepEqual(d.reasons, [ELIGIBILITY_READ_ONLY]);
});

test("row→verdict: no MT5 row refuses (absent review = hold)", () => {
  const v = verdictFromEligibilityRows([]);
  assert.equal(v.allowed, false);
  assert.ok(v.reasons.length > 0);
});

test("row→verdict: reviewed SELF + ELIGIBLE allows; READ_ONLY and HOLD refuse", () => {
  const ok = verdictFromEligibilityRows([
    { venueCode: "MT5", eligibilityStatus: "ELIGIBLE", relationshipToMaster: "SELF" },
  ]);
  assert.equal(ok.allowed, true);

  const ro = verdictFromEligibilityRows([
    { venueCode: "MT5", eligibilityStatus: "READ_ONLY", relationshipToMaster: "SELF" },
  ]);
  assert.equal(ro.allowed, false);
  assert.ok(ro.reasons.includes(ELIGIBILITY_READ_ONLY));

  const hold = verdictFromEligibilityRows([
    { venueCode: "mt5", eligibilityStatus: "COMPLIANCE_HOLD", relationshipToMaster: "SELF" },
  ]);
  assert.equal(hold.allowed, false);
});

test("row→verdict: case-duplicate venue rows must BOTH allow (ambiguity refuses)", () => {
  const v = verdictFromEligibilityRows([
    { venueCode: "MT5", eligibilityStatus: "ELIGIBLE", relationshipToMaster: "SELF" },
    { venueCode: "mt5", eligibilityStatus: "COMPLIANCE_HOLD", relationshipToMaster: "SELF" },
  ]);
  assert.equal(v.allowed, false);
});

test("relationship mapping: only the exact vocabulary maps; unknown stays null (refuses)", () => {
  assert.equal(outsideClientFundsFromRelationship("SELF"), false);
  assert.equal(outsideClientFundsFromRelationship("SAME_ENTITY_OPERATOR"), false);
  assert.equal(outsideClientFundsFromRelationship("EMPLOYEE_OF_OWNER"), false);
  assert.equal(outsideClientFundsFromRelationship("OUTSIDE_CLIENT"), true);
  assert.equal(outsideClientFundsFromRelationship("self"), null);
  assert.equal(outsideClientFundsFromRelationship(null), null);
  assert.equal(outsideClientFundsFromRelationship(undefined), null);

  const outside = verdictFromEligibilityRows([
    { venueCode: "MT5", eligibilityStatus: "ELIGIBLE", relationshipToMaster: "OUTSIDE_CLIENT" },
  ]);
  assert.equal(outside.allowed, false, "outside-client funds refuse even when ELIGIBLE (inviolable)");
});

test("close-path posture: refusal degrades to advisory ONLY for CLOSE_LIVE_POSITION", () => {
  const refusing = { allowed: false, reasons: [ELIGIBILITY_READ_ONLY] };

  const close = complianceVerdictForCommand(refusing, "CLOSE_LIVE_POSITION");
  assert.equal(close.allowed, false, "still an honest refusal, never coerced to allowed");
  assert.deepEqual(close.reasons, [ELIGIBILITY_READ_ONLY], "reasons preserved verbatim");
  assert.equal(close.advisoryOnly, true);

  // Entries and MODIFY (a modify can widen a stop) stay fully blocking.
  for (const ct of ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER", "MODIFY_LIVE_SLTP"]) {
    const v = complianceVerdictForCommand(refusing, ct);
    assert.equal(v.allowed, false);
    assert.notEqual(v.advisoryOnly, true, `${ct} must NOT degrade to advisory`);
  }

  // An allowing verdict is never marked advisory.
  const ok = complianceVerdictForCommand({ allowed: true, reasons: [] }, "CLOSE_LIVE_POSITION");
  assert.equal(ok.allowed, true);
  assert.notEqual(ok.advisoryOnly, true);
});

test("gate #3: an advisoryOnly refusal passes LOUDLY (close not trapped), plain refusal still blocks", () => {
  const advisory = evaluateLivePhaseBDispatchGate({
    ...passingInput(),
    complianceEligibility: { allowed: false, reasons: [ELIGIBILITY_READ_ONLY], advisoryOnly: true },
  });
  assert.equal(advisory.decision, "PASS");
  const g3 = advisory.gates.find((g) => g.key === "USER_NOT_LIVE_APPROVED");
  assert.ok(g3?.passed);
  assert.ok(g3?.detail?.includes(ELIGIBILITY_READ_ONLY), "the refusal reason is recorded verbatim");
  assert.ok(g3?.detail?.includes("ADVISORY"), "the degradation is named, never silent");

  // Without the advisory mark the identical verdict still blocks (mutation guard).
  const blocking = evaluateLivePhaseBDispatchGate({
    ...passingInput(),
    complianceEligibility: { allowed: false, reasons: [ELIGIBILITY_READ_ONLY] },
  });
  assert.equal(blocking.decision, "BLOCKED");
});

test("gate #3: advisoryOnly can never rescue a missing admin approval", () => {
  const r = evaluateLivePhaseBDispatchGate({
    ...passingInput(),
    userLiveApproved: false,
    complianceEligibility: { allowed: false, reasons: [ELIGIBILITY_READ_ONLY], advisoryOnly: true },
  });
  assert.equal(r.decision, "BLOCKED");
  assert.ok(r.blockReasons.includes("USER_NOT_LIVE_APPROVED"));
});

test("admin route INVIOLABLE evaluates the POST-MERGE effective relationship", () => {
  // The original defect: body omits relationshipToMaster against an existing
  // OUTSIDE_CLIENT row + asks for ELIGIBLE → must refuse (422 in the route).
  assert.equal(outsideClientHoldViolation({
    bodyRelationship: undefined,
    existingRelationship: "OUTSIDE_CLIENT",
    eligibilityStatus: "ELIGIBLE",
  }), true, "omitting the field cannot launder OUTSIDE_CLIENT into ELIGIBLE");

  // Explicit null keeps the existing value too (mirrors the `??` patch merge).
  assert.equal(outsideClientHoldViolation({
    bodyRelationship: null,
    existingRelationship: "OUTSIDE_CLIENT",
    eligibilityStatus: "ELIGIBLE",
  }), true, "an explicit null does not clear an OUTSIDE_CLIENT mark");

  // Body-supplied OUTSIDE_CLIENT still refuses regardless of the existing row.
  assert.equal(outsideClientHoldViolation({
    bodyRelationship: "OUTSIDE_CLIENT",
    existingRelationship: "SELF",
    eligibilityStatus: "ELIGIBLE",
  }), true);

  // COMPLIANCE_HOLD is the one status OUTSIDE_CLIENT may be recorded with.
  assert.equal(outsideClientHoldViolation({
    bodyRelationship: undefined,
    existingRelationship: "OUTSIDE_CLIENT",
    eligibilityStatus: "COMPLIANCE_HOLD",
  }), false);

  // A reviewed non-outside relationship in the body supersedes the old row.
  assert.equal(outsideClientHoldViolation({
    bodyRelationship: "SELF",
    existingRelationship: "OUTSIDE_CLIENT",
    eligibilityStatus: "ELIGIBLE",
  }), false);

  // No relationship anywhere → not the OUTSIDE_CLIENT rule's concern (unknown
  // provenance still refuses at dispatch via OUTSIDE_CLIENT_FUNDS_UNKNOWN).
  assert.equal(outsideClientHoldViolation({
    bodyRelationship: undefined,
    existingRelationship: null,
    eligibilityStatus: "ELIGIBLE",
  }), false);

  // SOURCE PIN: the route's 422 uses this helper AFTER reading the existing
  // row, and the stored patch uses the same effective value.
  const routeSrc = readFileSync(
    fileURLToPath(new URL("../../../routes/adminCompliance.js".replace(/\.js$/, ".ts"), import.meta.url)),
    "utf8",
  );
  assert.ok(routeSrc.includes("outsideClientHoldViolation({"), "route calls the shared helper");
  const fetchIdx = routeSrc.indexOf("const [existing] = await db.select()");
  const checkIdx = routeSrc.indexOf("outsideClientHoldViolation({", fetchIdx);
  assert.ok(fetchIdx >= 0 && checkIdx > fetchIdx, "422 check runs after the existing row is read");
  assert.ok(routeSrc.includes("relationshipToMaster: effectiveRelationship"),
    "the patch stores exactly the value the 422 evaluated");
});

test("WIRING PIN: the dispatch pipeline supplies complianceEligibility to the evaluator", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    src.includes("buildComplianceEligibilityVerdict"),
    "liveCommandPipeline must build the compliance verdict at dispatch",
  );
  assert.ok(
    /complianceEligibility,/.test(src),
    "liveCommandPipeline must pass complianceEligibility into evaluateLivePhaseBDispatchGate",
  );
  assert.ok(
    src.includes("complianceVerdictForCommand(raw, row.commandType)"),
    "liveCommandPipeline must apply the close-path posture with the real command type",
  );
  const gateSrc = readFileSync(
    fileURLToPath(new URL("../../../../../../lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    gateSrc.includes("complianceEligibility?:"),
    "the evaluator input must carry the compliance block (inside gate #3, not a new key)",
  );
});
