// Shadow Mode truth: a WAIT decision carries no invented entry/stop/target, and
// the risk governor is not "checked" against levels nobody proposed.
//
// Before: a WAIT scan (stopLoss 0, takeProfit 0) was stored with
// sl = entry * 0.997 and tp = entry * 1.005 — prices no strategy proposed —
// and the risk governor previewed a made-up BUY at those levels; a block on
// that made-up trade counted as a risk violation for the strategy.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/shadow/__qa__/shadowWaitLevelsTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

let scan: Record<string, unknown> = {};
let previewCalls = 0;
let verdict: "ALLOW" | "BLOCK" = "ALLOW";

const realEngine = await import("../../strategyEngine.js");
mock.module("../../strategyEngine.js", { namedExports: { ...realEngine, runStrategyScan: () => ({ ...scan }) } });
const realOms = await import("../../oms.js");
mock.module("../../oms.js", { namedExports: { ...realOms, previewSimulatorEntry: () => {
  previewCalls++;
  return verdict === "ALLOW"
    ? { decision: "ALLOW", blockedBy: [], rules: [] }
    : { decision: "BLOCK", blockedBy: ["AI_CONFIDENCE"], rules: [] };
} } });
const realSim = await import("../../marketSimulator.js");
mock.module("../../marketSimulator.js", { namedExports: { ...realSim, marketSimulator: {
  candlesFor: (_s: string, n = 60) => Array.from({ length: Math.min(n, 40) }, (_, i) => ({
    tsIso: new Date(Date.UTC(2026, 9, 1, 0, i * 15)).toISOString(), o: 1.085, h: 1.086, l: 1.084, c: 1.085, v: 1,
  })),
  quote: () => ({ bid: 1.085, ask: 1.085, mid: 1.085 }),
} } });
mock.module("../../shadowPersistence.js", { namedExports: {
  persistShadowDecision: async () => {}, updateShadowOutcome: async () => {},
  SYNTHETIC_SIMULATOR_SOURCE: "SYNTHETIC_SIMULATOR",
} });

const sm = await import("../../shadowMode.js");

test("a WAIT with no proposed levels stores no stop or target, not entry * 0.997 / 1.005", () => {
  scan = { direction: "WAIT", confidence: 0, entryPrice: 1.085, stopLoss: 0, takeProfit: 0,
    strategy: "No Trade Filter", reason: "No actionable signal from any strategy", riskWarning: "" };
  const d = sm.createShadowDecision("EURUSD");
  assert.ok(d);
  assert.equal(d.action, "WAIT");
  assert.equal(d.status, "SHADOW_WAIT");
  assert.equal(d.entry, 1.085);
  assert.equal(d.sl, null);
  assert.equal(d.tp, null);
});

test("a WAIT keeps only the levels its strategy actually proposed before the filter said wait", () => {
  scan = { direction: "WAIT", confidence: 55, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095,
    strategy: "Mean Reversion", reason: "Confidence 55 below minimum 65", riskWarning: "" };
  const d = sm.createShadowDecision("EURUSD");
  assert.ok(d);
  assert.equal(d.sl, 1.08);
  assert.equal(d.tp, 1.095);
});

test("the risk governor is not run on a WAIT, and a WAIT never counts as a risk block", () => {
  previewCalls = 0;
  verdict = "BLOCK";
  scan = { direction: "WAIT", confidence: 20, entryPrice: 1.085, stopLoss: 0, takeProfit: 0,
    strategy: "Session Breakout", reason: "inside Asia range", riskWarning: "" };
  const d = sm.createShadowDecision("EURUSD");
  assert.ok(d);
  assert.equal(previewCalls, 0, "no trade was proposed, so nothing was risk-checked");
  assert.equal(d.riskGovernor.level, "NOT_CHECKED");
  assert.deepEqual(d.riskGovernor.hardBlocks, []);
  const gate = sm.promotionStatus().find((g) => g.strategy === "Session Breakout");
  assert.ok(gate);
  assert.equal(gate.stats.rgViolations, 0);
  verdict = "ALLOW";
});

test("a BUY is still risk-checked with its own levels", () => {
  previewCalls = 0;
  verdict = "ALLOW";
  scan = { direction: "BUY", confidence: 80, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095,
    strategy: "Trend Continuation", reason: "r", riskWarning: "" };
  const d = sm.createShadowDecision("EURUSD");
  assert.ok(d);
  assert.equal(previewCalls, 1);
  assert.equal(d.sl, 1.08);
  assert.equal(d.tp, 1.095);
  assert.equal(d.riskGovernor.approved, true);
});

test("status says the prices come from the synthetic simulator", () => {
  assert.equal(sm.shadowStatus().priceSource, "SYNTHETIC_SIMULATOR");
});
