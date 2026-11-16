// Help topics are the same static text for every account and cannot read the
// caller's account mode, so they must not state it. They used to say "This
// app is PAPER_ONLY. Live trading is disabled and cannot be enabled here." on
// every topic, while the dashboard's Trading Permission card showed an armed
// LIVE_SHARED trader "Live trading is active". The topics now say what the
// help itself does and point to the card that reads the account.
//
// Run: node --import tsx --test src/lib/onboarding/__qa__/helpTopicsLivePosture.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_TOPICS } from "../help.js";

const PAPER_ONLY_CLAIM = /PAPER_ONLY|paper[- ]only|live trading (is|remains) disabled|cannot be (enabled|unlocked)|does not allow live/i;

test("static help topics make no account-wide paper-only / live-disabled claim", () => {
  // Help topics are the same text for every account and cannot read the
  // caller's mode, so they must not state it.
  for (const h of HELP_TOPICS) {
    assert.doesNotMatch(h.content, PAPER_ONLY_CLAIM, `${h.help_key} content`);
    assert.doesNotMatch(h.safety_note, PAPER_ONLY_CLAIM, `${h.help_key} safety_note`);
    assert.doesNotMatch(h.title, PAPER_ONLY_CLAIM, `${h.help_key} title`);
    assert.doesNotMatch(h.content, /live positions \(which are disabled here anyway\)/i, h.help_key);
  }
});
