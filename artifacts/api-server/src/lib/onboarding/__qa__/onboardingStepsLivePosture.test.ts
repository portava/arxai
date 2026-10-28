// Onboarding steps are the same static text for every account and cannot read
// the caller's account mode, so they must not state it. /onboarding showed
// "Confirm Live Trading Is Disabled", "The LIVE TRADING DISABLED badge is
// always shown", "This app is a paper-only practice environment" and a
// "Live trading is disabled." safety note on every step — to an armed
// LIVE_SHARED trader too, whose Trading Permission card says live trading is
// active. The text now says what onboarding itself does. Step ids and
// completion conditions are persisted state and are unchanged.
//
// Run: node --import tsx --test src/lib/onboarding/__qa__/onboardingStepsLivePosture.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { ONBOARDING_STEPS, REQUIRED_ACK_KEYS } from "../steps.js";

const ACCOUNT_CLAIM = /PAPER_ONLY|paper[- ]only|live trading (is|remains) disabled|LIVE TRADING DISABLED|cannot (enable|be enabled|be unlocked)|does not allow live/i;

test("onboarding step text makes no account-wide paper-only / live-disabled claim", () => {
  for (const s of ONBOARDING_STEPS) {
    for (const field of ["title", "description", "help_text", "safety_note"] as const) {
      assert.doesNotMatch(s[field], ACCOUNT_CLAIM, `${s.step_id} ${field}: ${s[field]}`);
    }
  }
});

test("persisted step ids, completion conditions and acknowledgement keys are unchanged", () => {
  const ack = ONBOARDING_STEPS.find((s) => s.step_id === "ack-live-disabled");
  assert.ok(ack, "the ack-live-disabled step id is kept");
  assert.equal(ack.completion_condition, "live_disabled_acknowledged = true");
  assert.ok((REQUIRED_ACK_KEYS as readonly string[]).includes("liveDisabledAcknowledged"));
  assert.deepEqual(
    ONBOARDING_STEPS.map((s) => s.step_id),
    ["welcome", "ack-live-disabled", "safety-header", "readiness-check", "preflight", "start-session", "risk-governor",
      "critical-alerts", "monitor-trades", "coach", "end-session", "replay", "strategy-lab", "data-import", "system-health", "complete"],
  );
});

test("the acknowledgement step points to the card that reads the account", () => {
  const ack = ONBOARDING_STEPS.find((s) => s.step_id === "ack-live-disabled")!;
  assert.match(ack.description, /Trading Permission card/);
  assert.match(ack.description, /admin approval/);
});
