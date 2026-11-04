// Confidence Calibration truth: an empty bucket has no win rate, and the
// calibration label needs observed high- AND low-confidence outcomes.
//
// Before: empty buckets reported winRate 0 and were averaged in, so 20
// outcomes all at confidence 60-69 produced highWR = avg(0, 0) = 0 and
// lowWR = avg(0, 60) = 30 → "UNDERCONFIDENT", although no high-confidence
// call had ever been observed. That label fed readiness and the DEMO gate.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/shadow/__qa__/shadowCalibrationTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

let confidence = 65;
let px = 1.1;

const realEngine = await import("../../strategyEngine.js");
mock.module("../../strategyEngine.js", { namedExports: { ...realEngine, runStrategyScan: () => ({
  direction: "BUY", confidence, entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
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

function outcomes(conf: number, wins: number, losses: number) {
  confidence = conf;
  px = 1.1;
  for (let i = 0; i < wins; i++) sm.createShadowDecision("EURUSD");
  px = 1.13; mock.timers.tick(1000);
  px = 1.1;
  for (let i = 0; i < losses; i++) sm.createShadowDecision("EURUSD");
  px = 1.08; mock.timers.tick(1000);
}

test("20 outcomes all at confidence 60-69: NEEDS_MORE_DATA, and empty buckets have no win rate", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-01T10:00:00Z") });
  try {
    sm.startShadowMode({ symbols: ["EURUSD"], intervalSec: 3600 });
    outcomes(65, 12, 8);
    const c = sm.confidenceCalibration();
    assert.equal(c.totalSample, 20);
    assert.equal(c.label, "NEEDS_MORE_DATA", "no high-confidence call was observed");
    for (const b of c.buckets) {
      if (b.sample === 0) {
        assert.equal(b.winRate, null, `${b.bucket} has no win rate`);
        assert.equal(b.avgR, null, `${b.bucket} has no avg R`);
      }
    }
    const b60 = c.buckets.find((b) => b.bucket === "60-70")!;
    assert.equal(b60.sample, 20);
    assert.equal(b60.winRate, 60);

    // Once both sides are observed the label is computed from them.
    outcomes(85, 8, 2);
    outcomes(55, 3, 7);
    const c2 = sm.confidenceCalibration();
    assert.equal(c2.label, "WELL_CALIBRATED", "high 80% vs low 50%");
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});
