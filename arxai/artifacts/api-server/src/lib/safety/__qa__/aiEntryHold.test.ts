// AI-entry hold (PR #102). ON by default with an explicit opt-out (owner decision 2026-11-09).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AI_ENTRY_HOLD_ENV, AI_ENTRY_POLICY_PENDING, aiEntryHoldEnabled, aiEntryPolicyReason } from "../entryPolicy.js";

const ON = { [AI_ENTRY_HOLD_ENV]: "true" };
const GENERATED = ["eleanor", "automation", "strategy"] as const;
const NOT_GENERATED = ["manual", "api", "system"] as const;
const PROTECTIVE = ["CLOSE", "PARTIAL_CLOSE", "MODIFY"] as const;

test("default ON: unset, empty, true-ish or unrecognised values all hold generated entries (fails closed)", () => {
  for (const env of [{}, { [AI_ENTRY_HOLD_ENV]: "" }, { [AI_ENTRY_HOLD_ENV]: "true" }, { [AI_ENTRY_HOLD_ENV]: "1" }, { [AI_ENTRY_HOLD_ENV]: "enabled" }, { [AI_ENTRY_HOLD_ENV]: "disable" }]) {
    assert.equal(aiEntryHoldEnabled(env), true, JSON.stringify(env));
    for (const origin of GENERATED) assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, { env }), AI_ENTRY_POLICY_PENDING);
  }
});

test("explicit opt-out: false/0/off/no in any case switches the hold off", () => {
  for (const v of ["false", "FALSE", "0", "off", " no "]) {
    const env = { [AI_ENTRY_HOLD_ENV]: v };
    assert.equal(aiEntryHoldEnabled(env), false, v);
    for (const origin of GENERATED) assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, { env, generatedEntry: true }), null);
  }
});

test("the process default (no env argument) follows the same rule", () => {
  const prev = process.env[AI_ENTRY_HOLD_ENV];
  try {
    delete process.env[AI_ENTRY_HOLD_ENV];
    assert.equal(aiEntryHoldEnabled(), true);
    process.env[AI_ENTRY_HOLD_ENV] = "false";
    assert.equal(aiEntryHoldEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env[AI_ENTRY_HOLD_ENV]; else process.env[AI_ENTRY_HOLD_ENV] = prev;
  }
});

test("ON: generated entries are held; protective actions and manual entries are not", () => {
  for (const origin of GENERATED) {
    assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, { env: ON }), AI_ENTRY_POLICY_PENDING);
    for (const action of PROTECTIVE) assert.equal(aiEntryPolicyReason({ action, origin }, { env: ON, generatedEntry: true }), null);
  }
  for (const origin of NOT_GENERATED) assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, { env: ON }), null);
});

test("ON: an entry carrying an AI decision id is held whatever its origin label", () => {
  for (const origin of NOT_GENERATED) assert.equal(aiEntryPolicyReason({ action: "OPEN", origin }, { env: ON, generatedEntry: true }), AI_ENTRY_POLICY_PENDING);
});

test("wiring: the governor raises the hold as an unoverridable trading_halt; live and paper entries pass their decision link", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const enforce = src("../../riskGovernor/enforce.ts");
  assert.match(enforce, /aiEntryPolicyReason\(intent, \{ generatedEntry: opts\.generatedEntry \}\)/);
  assert.match(enforce, /blockedBy: \[\.\.\.new Set\(\[TRADING_HALT, \.\.\.decision\.blockedBy\]\)\]/);
  // overrideApplies needs trading_discipline to be the SOLE blocker, so a halt is never overridable.
  assert.match(enforce, /decision\.blockedBy\.length === 1 && decision\.blockedBy\[0\] === "trading_discipline"/);
  assert.match(src("../../live/liveCommandPipeline.ts"), /generatedEntry: row\.selfTradeDecisionId != null/);
  assert.equal(src("../../tradeEngine/paperVenue.ts").match(/generatedEntry: a\.decisionId != null/g)?.length, 2);
});
