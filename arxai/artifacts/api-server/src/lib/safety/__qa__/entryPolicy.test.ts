// Offline regression coverage for the entry policies named by the release lane.
// These helpers can refuse an entry; a null result is not trade authorization.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_ENTRY_HOLD_ENV,
  AI_ENTRY_POLICY_PENDING,
  aiEntryHoldEnabled,
  aiEntryPolicyReason,
  paperEntryPolicyReason,
  type PaperPosture,
} from "../entryPolicy.js";

const held = { [AI_ENTRY_HOLD_ENV]: "true" };
const released = { [AI_ENTRY_HOLD_ENV]: "false" };
const ready: PaperPosture = {
  readable: true, present: true, engaged: false,
  operationalMode: "PAPER_TRADING", globalState: "NORMAL",
};

test("the AI entry hold fails closed for missing, blank and unrecognized configuration", () => {
  for (const value of [undefined, "", "  ", "true", "1", "on", "yes", "disabled", "false-ish"]) {
    assert.equal(aiEntryHoldEnabled({ [AI_ENTRY_HOLD_ENV]: value }), true, String(value));
    assert.equal(aiEntryPolicyReason({ action: "OPEN", origin: "eleanor" }, {
      env: { [AI_ENTRY_HOLD_ENV]: value },
    }), AI_ENTRY_POLICY_PENDING);
  }
});

test("only an explicit supported opt-out releases the AI entry hold", () => {
  for (const value of ["false", "0", "off", "no", " FALSE ", "Off", "NO"]) {
    const env = { [AI_ENTRY_HOLD_ENV]: value };
    assert.equal(aiEntryHoldEnabled(env), false, value);
    assert.equal(aiEntryPolicyReason({ action: "OPEN", origin: "eleanor" }, { env }), null);
  }
});

test("the policy reads configuration on each evaluation", () => {
  const env: Record<string, string | undefined> = {};
  assert.equal(aiEntryHoldEnabled(env), true);
  env[AI_ENTRY_HOLD_ENV] = "false";
  assert.equal(aiEntryHoldEnabled(env), false);
  delete env[AI_ENTRY_HOLD_ENV];
  assert.equal(aiEntryHoldEnabled(env), true);
});

test("every generated origin is held, while unmarked manual/API/system entries retain their other gates", () => {
  for (const origin of ["eleanor", "automation", "strategy"] as const) {
    assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, { env: held }), AI_ENTRY_POLICY_PENDING);
  }
  for (const origin of ["manual", "api", "system"] as const) {
    assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, { env: held }), null);
  }
});

test("a generated decision cannot bypass the hold by relabelling its origin", () => {
  for (const origin of ["manual", "api", "system"] as const) {
    assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, {
      env: held, generatedEntry: true,
    }), AI_ENTRY_POLICY_PENDING);
    assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, {
      env: released, generatedEntry: true,
    }), null);
  }
});

test("the AI-entry hold does not trap protective actions, even with generated decision provenance", () => {
  for (const action of ["CLOSE", "PARTIAL_CLOSE", "MODIFY"] as const) {
    for (const origin of ["eleanor", "automation", "strategy", "manual", "api", "system"] as const) {
      assert.equal(aiEntryPolicyReason({ action, origin }, { env: held, generatedEntry: true }), null);
    }
  }
});

test("a missing or unreadable paper safety posture cannot grant entry permission", () => {
  for (const posture of [
    { ...ready, readable: false },
    { ...ready, present: false },
    { ...ready, readable: false, present: false },
  ]) assert.match(paperEntryPolicyReason(posture)!, /^PAPER_SAFETY_STATE_UNAVAILABLE:/);
});

test("the paper kill switch blocks even an otherwise executable posture", () => {
  assert.match(paperEntryPolicyReason({ ...ready, engaged: true })!, /^PAPER_SAFETY_STOP:/);
});

test("paper entries require a recognized executable mode", () => {
  for (const operationalMode of [null, "", "OFF", "SHADOW", "ANALYSIS_ONLY", "paper_trading", "UNKNOWN"]) {
    assert.match(paperEntryPolicyReason({ ...ready, operationalMode })!, /^PAPER_MODE_BLOCK:/);
  }
  for (const operationalMode of ["PAPER_TRADING", "LIVE_TRADING"]) {
    assert.equal(paperEntryPolicyReason({ ...ready, operationalMode }), null);
  }
});

test("recovery, degraded, shutdown and unknown paper states fail closed", () => {
  for (const globalState of [null, "", "RECOVERY", "DEGRADED", "SHUTDOWN", "UNKNOWN", "normal"]) {
    assert.match(paperEntryPolicyReason({ ...ready, globalState })!, /^PAPER_STATE_BLOCK:/);
  }
});

test("recognized cautious paper states remain subject to the other governor rules", () => {
  for (const globalState of ["NORMAL", "HIGH_VOLATILITY", "TREND_EXPANSION", "CHOP_DANGER", "NEWS_RISK",
    "LOW_LIQUIDITY", "EXECUTION_RISK", "COGNITIVE_FATIGUE", "DEFENSIVE_MODE"]) {
    assert.equal(paperEntryPolicyReason({ ...ready, globalState }), null, globalState);
  }
});

test("releasing the AI hold does not release paper safety restrictions", () => {
  assert.equal(aiEntryPolicyReason({ action: "OPEN", origin: "eleanor" }, { env: released }), null);
  assert.match(paperEntryPolicyReason({ ...ready, engaged: true })!, /^PAPER_SAFETY_STOP:/);
  assert.match(paperEntryPolicyReason({ ...ready, readable: false })!, /^PAPER_SAFETY_STATE_UNAVAILABLE:/);
});
