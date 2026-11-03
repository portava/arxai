// Truth: risk_settings.liveLocked is a stored preference. The permission
// engine lists it as a blocker (so trade-plan and Pre-Trade Confirmation
// checks fail while it is on), but no live order path reads it. The
// permission status, its coach copy and the trade-decision warning said
// "Live trading is locked" — the belief that live is locked when it is not.
// The copy changes; the reason code, severity and verdict do not.
//
// Run: node --import tsx --test --test-force-exit \
//        src/lib/aiLearning/__qa__/liveLockPreferenceCopy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { evaluatePermission, LIVE_LOCK_PREFERENCE_NOTE } from "@workspace/domain/safety-permission";
import { explainPermission } from "../permissionCoach.js";

const LOCKED_CLAIM = /live trading is locked|locked live trading/i;

function verdictWith(liveLocked: boolean) {
  return evaluatePermission({
    operationalMode: "PAPER_TRADING",
    killSwitchEngaged: false,
    mt5LinkHealth: "OK",
    liveAllowed: true,
    maxDailyLossPct: 5,
    maxTradesPerDay: 10,
    stopAfterLosingStreak: 3,
    maxLotSize: 1,
    cooldownAfterLossMinutes: 15,
    liveLocked,
    todaysTradesCount: 0,
    todaysLossPct: 0,
    consecutiveLosses: 0,
    activeLocks: [],
    brokerCredentialsConfigured: true,
  });
}

test("permission verdict: the live mode lock is a preference, not 'live trading is locked'", () => {
  const v = verdictWith(true);
  const r = v.reasons.find((x) => x.code === "LIVE_LOCKED_USER");
  assert.ok(r, "the reason is still emitted");
  assert.equal(r.severity, "BLOCK", "severity unchanged");
  assert.equal(v.status, "LOCKED", "verdict unchanged");
  assert.ok(v.blockers.includes(r.message), "still listed as a blocker");
  assert.doesNotMatch(r.message, LOCKED_CLAIM);
  assert.equal(r.message, LIVE_LOCK_PREFERENCE_NOTE);
  assert.match(r.message, /live mode lock preference is on/);
  assert.match(r.message, /live orders are not checked against it/);
  assert.equal(verdictWith(false).reasons.some((x) => x.code === "LIVE_LOCKED_USER"), false);
});

test("permission coach: no 'You manually locked live trading'", () => {
  const e = explainPermission(verdictWith(true));
  assert.doesNotMatch(e.headline, LOCKED_CLAIM);
  assert.doesNotMatch(e.recommendation, LOCKED_CLAIM);
  assert.doesNotMatch(e.detail, LOCKED_CLAIM);
  assert.match(e.headline, /live mode lock preference is on/i);
  assert.match(e.recommendation, /live orders are not checked against it/);
});

test("trade decision: the live-lock warning uses the same preference copy", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(HERE, "../../../routes/tradeDecision.ts"), "utf8");
  assert.doesNotMatch(src, /Live trading is locked in risk settings/);
  assert.match(src, /if \(risk\?\.liveLocked\) warnings\.push\(LIVE_LOCK_PREFERENCE_NOTE\);/);
});
