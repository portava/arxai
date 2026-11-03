// Shadow Mode truth: "Tracking" counts only decisions something is tracking.
//
// Before: Stop cleared the 1 s outcome tracker (the only code that resolves or
// expires a decision), yet open decisions kept SHADOW_TRACKING_OUTCOME and the
// "Tracking" stat forever; a decision forced while shadow mode was stopped was
// also labelled SHADOW_TRACKING_OUTCOME although nothing ever tracked it.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/shadow/__qa__/shadowTrackingStoppedTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const synced: Array<{ id: string; status: string; pnlR?: number }> = [];

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
  quote: () => ({ bid: 1.1, ask: 1.1, mid: 1.1 }),
} } });
mock.module("../../shadowPersistence.js", { namedExports: {
  persistShadowDecision: async () => {},
  updateShadowOutcome: async (d: { id: string; status: string; pnlR?: number }) => { synced.push({ id: d.id, status: d.status, pnlR: d.pnlR }); },
  SYNTHETIC_SIMULATOR_SOURCE: "SYNTHETIC_SIMULATOR",
} });

const sm = await import("../../shadowMode.js");

test("Stop closes every open decision as not tracked; 'Tracking' drops to 0", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-01T10:00:00Z") });
  try {
    sm.startShadowMode({ symbols: ["EURUSD"], intervalSec: 3600 });
    const d = sm.createShadowDecision("EURUSD");
    assert.ok(d);
    assert.equal(d.status, "SHADOW_TRACKING_OUTCOME", "tracked while the tracker runs");
    assert.equal(sm.shadowStatus().tracking, 1);

    sm.stopShadowMode();
    mock.timers.tick(10 * 60_000);

    const s = sm.shadowStatus();
    assert.equal(s.tracking, 0);
    const after = sm.listDecisions(10).find((x) => x.id === d.id);
    assert.ok(after);
    assert.equal(after.status, "SHADOW_EXPIRED");
    assert.equal(after.untrackedReason, "TRACKING_STOPPED");
    assert.equal(after.pnlR, undefined, "no R was measured");
    assert.ok(after.outcomeAt);
    assert.ok(s.untracked >= 1);
    assert.ok(synced.some((x) => x.id === d.id && x.status === "SHADOW_EXPIRED"), "the durable row is closed too");
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});

test("a decision forced while shadow mode is stopped is never labelled as tracking", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-02T10:00:00Z") });
  try {
    sm.stopShadowMode();
    const d = sm.createShadowDecision("EURUSD");
    assert.ok(d);
    assert.notEqual(d.status, "SHADOW_TRACKING_OUTCOME");
    assert.equal(d.status, "SHADOW_TRADE_IDEA");
    assert.equal(d.untrackedReason, "TRACKER_NOT_RUNNING");
    mock.timers.tick(10 * 60_000);
    assert.equal(sm.shadowStatus().tracking, 0);
  } finally {
    mock.timers.reset();
  }
});
