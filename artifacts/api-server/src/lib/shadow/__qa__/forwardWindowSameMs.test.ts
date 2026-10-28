// Forward Testing window: a decision made after Start counts, and one made
// after Stop never does — even within the same millisecond.
//
// Before: the window was [startedAt, endedAt] by timestamp, so a decision made
// right after Stop in the same millisecond still fell inside it (and one made
// in the same millisecond just before Start did too). forwardResultsScope's
// "Stop freezes the results window" check failed intermittently on that race.
//
// Run: node --import tsx --test --test-force-exit src/lib/shadow/__qa__/forwardWindowSameMs.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createShadowDecision,
  startForwardTest,
  stopForwardTest,
  forwardStatus,
  forwardResults,
  stopShadowMode,
} from "../../shadowMode.js";

function decide(symbol: string): void {
  assert.ok(createShadowDecision(symbol, "M15"), `simulator produced no decision for ${symbol}`);
}

test("with the clock frozen, decisions before Start and after Stop stay outside the window", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-01T10:00:00Z") });
  try {
    decide("EURUSD"); // before Start, same millisecond
    startForwardTest({ durationMin: 60 });
    decide("EURUSD");
    decide("XAUUSD");
    assert.equal(forwardResults().totalShadowDecisions, 2);
    stopForwardTest();
    const observedAtStop = forwardStatus().observedSinceStart;
    assert.equal(observedAtStop, 2);
    decide("GBPUSD"); // after Stop, same millisecond
    decide("USDJPY");
    assert.equal(forwardResults().totalShadowDecisions, 2);
    assert.equal(forwardStatus().observedSinceStart, observedAtStop);
  } finally {
    stopShadowMode();
    mock.timers.reset();
  }
});
