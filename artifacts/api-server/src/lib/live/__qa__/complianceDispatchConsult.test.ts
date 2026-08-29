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
const { verdictFromEligibilityRows, outsideClientFundsFromRelationship } =
  await import("../complianceDispatchInput.js");

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
  const gateSrc = readFileSync(
    fileURLToPath(new URL("../../../../../../lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    gateSrc.includes("complianceEligibility?:"),
    "the evaluator input must carry the compliance block (inside gate #3, not a new key)",
  );
});
