// Entry policy holds (PR #102 port onto the chart chain). Pure functions, no DB.
//
// Run: node --import tsx --test --test-force-exit src/lib/safety/__qa__/entryPolicy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_ENTRY_POLICY_PENDING,
  aiEntryPolicyReason,
  paperEntryOrigin,
  paperEntryPolicyReason,
} from "../entryPolicy.js";

const open = (origin: string) => ({ action: "OPEN" as const, origin: origin as never });

test("AI-originated OPEN entries are held until the owner approves a confidence policy", () => {
  for (const origin of ["ruby", "automation", "strategy"]) {
    assert.equal(aiEntryPolicyReason(open(origin)), AI_ENTRY_POLICY_PENDING, origin);
  }
});

test("manual, api and system entries and every protective action pass the AI hold", () => {
  for (const origin of ["manual", "api", "system"]) assert.equal(aiEntryPolicyReason(open(origin)), null, origin);
  for (const action of ["CLOSE", "PARTIAL_CLOSE", "MODIFY"] as const) {
    assert.equal(aiEntryPolicyReason({ action, origin: "ruby" }), null, action);
  }
});

test("a paper entry carrying a decision id keeps its AI origin instead of being relabelled manual", () => {
  assert.equal(paperEntryOrigin("manual", 42), "ruby");
  assert.equal(paperEntryOrigin("api", 42), "ruby");
  assert.equal(paperEntryOrigin("manual", null), "manual");
  assert.equal(paperEntryOrigin("strategy", 42), "strategy");
  assert.equal(paperEntryOrigin(undefined, undefined), "manual");
});

test("paper booking requires one readable Safety Core row, no kill switch, a booking mode and a trading state", () => {
  const ok = { readable: true, present: true, operationalMode: "PAPER_TRADING", globalState: "NORMAL", engaged: false };
  assert.equal(paperEntryPolicyReason(ok), null);
  assert.equal(paperEntryPolicyReason({ ...ok, operationalMode: "LIVE_TRADING" }), null);
  assert.match(paperEntryPolicyReason({ ...ok, readable: false })!, /PAPER_SAFETY_STATE_UNAVAILABLE/);
  assert.match(paperEntryPolicyReason({ ...ok, present: false })!, /PAPER_SAFETY_STATE_UNAVAILABLE/);
  assert.match(paperEntryPolicyReason({ ...ok, engaged: true })!, /PAPER_SAFETY_STOP/);
  assert.match(paperEntryPolicyReason({ ...ok, operationalMode: "OBSERVE_ONLY" })!, /PAPER_MODE_BLOCK/);
  assert.match(paperEntryPolicyReason({ ...ok, operationalMode: "SUGGEST_ONLY" })!, /PAPER_MODE_BLOCK/);
  assert.match(paperEntryPolicyReason({ ...ok, operationalMode: null })!, /PAPER_MODE_BLOCK/);
  assert.match(paperEntryPolicyReason({ ...ok, globalState: "SHUTDOWN" })!, /PAPER_STATE_BLOCK/);
  assert.match(paperEntryPolicyReason({ ...ok, globalState: null })!, /PAPER_STATE_BLOCK/);
});
