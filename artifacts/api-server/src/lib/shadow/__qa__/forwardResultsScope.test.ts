// Forward Testing results cover only the forward test's own window: nothing
// before any test started (shadow decisions from other surfaces are not forward
// results), and nothing observed after Stop / after the duration elapsed.
//
// Run: node --import tsx --test --test-force-exit src/lib/shadow/__qa__/forwardResultsScope.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createShadowDecision,
  startForwardTest,
  stopForwardTest,
  forwardStatus,
  forwardResults,
  forwardChartSeries,
  stopShadowMode,
} from "../../shadowMode.js";

function decide(symbol: string): void {
  assert.ok(createShadowDecision(symbol, "M15"), `simulator produced no decision for ${symbol}`);
}

test("no forward test started: results are empty, not every shadow decision since boot", () => {
  decide("EURUSD");
  const r = forwardResults();
  assert.equal(r.totalShadowDecisions, 0);
  assert.equal(r.testStartedAt, null);
  const series = forwardChartSeries();
  assert.equal(series.markers.length, 0);
  assert.equal(series.openTrackingCount, 0);
  assert.equal(forwardStatus().observedSinceStart, 0);
});

test("Stop freezes the results window: later shadow decisions do not accrue", () => {
  startForwardTest({ durationMin: 60 });
  try {
    decide("EURUSD");
    decide("XAUUSD");
    const during = forwardResults().totalShadowDecisions;
    assert.equal(during, 2);
    stopForwardTest();
    const s = forwardStatus();
    assert.equal(s.running, false);
    const observedAtStop = s.observedSinceStart;
    decide("GBPUSD");
    decide("USDJPY");
    assert.equal(forwardResults().totalShadowDecisions, during);
    assert.equal(forwardStatus().observedSinceStart, observedAtStop);
    assert.equal(forwardResults().testEndedAt, s.endedAt);
  } finally {
    stopShadowMode();
  }
});

test("decisions after the duration elapsed are outside the window", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 3_600_000 });
  try {
    startForwardTest({ durationMin: 1 });
    decide("EURUSD");
    mock.timers.tick(61_000);
    assert.equal(forwardStatus().running, false);
    const before = forwardResults().totalShadowDecisions;
    decide("XAUUSD");
    assert.equal(forwardResults().totalShadowDecisions, before);
  } finally {
    mock.timers.reset();
    stopShadowMode();
  }
});
