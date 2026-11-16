// Forward Testing truth: the RUNNING flag must describe what actually happened.
//
//  - A test that reached its endsAt is not RUNNING; a 0-minute (or non-numeric)
//    duration is refused instead of starting a test that has already ended.
//
// Run: node --import tsx --test --test-force-exit src/lib/shadow/__qa__/forwardTestTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  startForwardTest,
  stopForwardTest,
  forwardStatus,
  stopShadowMode,
} from "../../shadowMode.js";

test("a 0-minute or non-numeric duration is refused, never a RUNNING test that already ended", () => {
  assert.throws(() => startForwardTest({ durationMin: 0 }), RangeError);
  assert.throws(() => startForwardTest({ durationMin: Number.NaN }), RangeError);
  assert.throws(() => startForwardTest({ durationMin: "abc" as unknown as number }), RangeError);
  assert.equal(forwardStatus().running, false);
});

test("a test whose duration elapsed reads as ended, not RUNNING", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    startForwardTest({ durationMin: 1 });
    assert.equal(forwardStatus().running, true);
    mock.timers.tick(61_000);
    const s = forwardStatus();
    assert.equal(s.running, false);
    assert.equal(s.endReason, "duration_elapsed");
    assert.equal(s.endedAt, s.endsAt);
    assert.ok(Date.parse(String(s.endsAt)) <= Date.now());
  } finally {
    mock.timers.reset();
    stopShadowMode();
  }
});

test("Stop ends the test with its reason and time", () => {
  startForwardTest({ durationMin: 60 });
  stopForwardTest();
  const s = forwardStatus();
  assert.equal(s.running, false);
  assert.equal(s.endReason, "stopped");
  assert.ok(s.endedAt && Date.parse(s.endedAt) <= Date.now());
  stopShadowMode();
});
