// AI Readiness Score truth: only measured factors earn points, and with no
// tracked outcomes the score can never read "ready".
//
// Before: overtradingBehavior (100), learningLoopStability (80) and
// safetyCompliance (100) were constants nothing checked;
// opportunityScoreAccuracy was the average confidence (opportunity was set
// equal to confidence), entrySniperAvg was confidence - 5 and tradeGradeAvg
// confidence / 10; drawdown read 100 because nothing had resolved and
// sampleSize counted unresolved decisions. ~100 BUY ideas at confidence 80
// with ZERO resolved outcomes scored about 77/100 → PAPER_READY.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/shadow/__qa__/shadowReadinessTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

let px = 1.1;

const realEngine = await import("../../strategyEngine.js");
mock.module("../../strategyEngine.js", { namedExports: { ...realEngine, runStrategyScan: () => ({
  direction: "BUY", confidence: 80, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
  strategy: "Trend Continuation", reason: "r", riskWarning: "",
}) } });
const realOms = await import("../../oms.js");
mock.module("../../oms.js", { namedExports: { ...realOms, previewSimulatorEntry: () => ({ decision: "ALLOW", blockedBy: [], rules: [] }) } });
const realSim = await import("../../marketSimulator.js");
mock.module("../../marketSimulator.js", { namedExports: { ...realSim, marketSimulator: {
  candlesFor: (_s: string, n = 60) => Array.from({ length: Math.min(n, 40) }, (_, i) => ({
    tsIso: new Date(Date.UTC(2026, 9, 1, 0, i * 15)).toISOString(), o: 1.1, h: 1.101, l: 1.099, c: 1.1, v: 1,
  })),
  quote: () => ({ bid: px, ask: px, mid: px }),
} } });
mock.module("../../shadowPersistence.js", { namedExports: {
  persistShadowDecision: async () => {}, updateShadowOutcome: async () => {},
  SYNTHETIC_SIMULATOR_SOURCE: "SYNTHETIC_SIMULATOR",
} });

const sm = await import("../../shadowMode.js");

const NEVER_MEASURED = [
  "overtradingBehavior", "learningLoopStability", "safetyCompliance",
  "opportunityScoreAccuracy", "entrySniperAvg", "tradeGradeAvg",
];
const READY = ["PAPER_READY", "DEMO_READY", "LIVE_INTENT_READY"];

function assertNoPointsForUnmeasured(r: ReturnType<typeof sm.readinessScore>) {
  for (const f of NEVER_MEASURED) {
    assert.ok(!(f in r.factors), `${f} is not measured, so it earns no points`);
    assert.ok(r.notMeasured.some((x) => x.factor === f && x.why.length > 0), `${f} is listed as not measured, with why`);
  }
}

test("100 ideas with zero tracked outcomes: not ready, and constants / confidence stand-ins earn no points", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-01T10:00:00Z") });
  try {
    sm.startShadowMode({ symbols: ["EURUSD"], intervalSec: 3600 });
    px = 1.1;
    for (let i = 0; i < 100; i++) assert.ok(sm.createShadowDecision("EURUSD"));
    assert.equal(sm.shadowStatus().tracking, 100);

    const r = sm.readinessScore();
    assert.equal(r.trackedOutcomes, 0);
    assert.ok(!READY.includes(r.label), `label ${r.label} with no tracked outcome`);
    assertNoPointsForUnmeasured(r);
    for (const f of ["strategyPerformance", "drawdownBehavior", "confidenceCalibration"]) {
      assert.ok(!(f in r.factors), `${f} has nothing resolved to measure`);
      assert.ok(r.notMeasured.some((x) => x.factor === f));
    }
    assert.equal(r.factors.sampleSize, 0, "sample size counts tracked outcomes, not open ideas");
    assert.equal(r.factors.riskDiscipline, 100, "the risk governor allowed every proposed trade (measured)");
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});

test("tracked outcomes are measured, but fewer than the minimum still cannot read ready", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-02T10:00:00Z") });
  try {
    sm.startShadowMode({ symbols: ["EURUSD"], intervalSec: 3600 });
    px = 1.1;
    for (let i = 0; i < 10; i++) assert.ok(sm.createShadowDecision("EURUSD"));
    px = 1.13; // all ten win at +2R
    mock.timers.tick(1000);
    const r = sm.readinessScore();
    assert.equal(r.trackedOutcomes, 10);
    assert.equal(r.factors.strategyPerformance, 100);
    assert.equal(r.factors.drawdownBehavior, 100);
    assert.equal(r.factors.sampleSize, 10);
    assert.ok(r.trackedOutcomes < r.minTrackedOutcomes);
    assert.ok(!READY.includes(r.label), `label ${r.label} with only ${r.trackedOutcomes} tracked outcomes`);
    assertNoPointsForUnmeasured(r);
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});
