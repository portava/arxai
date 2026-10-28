// Strategy Promotion truth: the gates list the strategies that actually make
// shadow decisions, the demotion scan checks those same strategies, and a gate
// nobody acted on has no "updated" time or reason.
//
// Before: promotionStatus listed four placeholder names that never trade
// ("Conservative Pullback", "Breakout Confirmation", "Gold Scalping Test",
// "Custom Strategy") at TESTING with n=0; demotionScan iterated only that
// placeholder list, so e.g. "Break of Structure" with 10+ losses was never
// checked and the page said "No demotions suggested." updatedAt/lastReason
// ("init") were the time of the first page read, not an event.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/shadow/__qa__/shadowPromotionTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

let scan: Record<string, unknown> = {};
let px = 100;

const realEngine = await import("../../strategyEngine.js");
mock.module("../../strategyEngine.js", { namedExports: { ...realEngine, runStrategyScan: () => ({ ...scan }) } });
const realOms = await import("../../oms.js");
mock.module("../../oms.js", { namedExports: { ...realOms, previewSimulatorEntry: () => ({ decision: "ALLOW", blockedBy: [], rules: [] }) } });
const realSim = await import("../../marketSimulator.js");
mock.module("../../marketSimulator.js", { namedExports: { ...realSim, marketSimulator: {
  candlesFor: (_s: string, n = 60) => Array.from({ length: Math.min(n, 40) }, (_, i) => ({
    tsIso: new Date(Date.UTC(2026, 9, 1, 0, i * 15)).toISOString(), o: 100, h: 101, l: 99, c: 100, v: 1,
  })),
  quote: () => ({ bid: px, ask: px, mid: px }),
} } });
mock.module("../../shadowPersistence.js", { namedExports: {
  persistShadowDecision: async () => {}, updateShadowOutcome: async () => {},
  SYNTHETIC_SIMULATOR_SOURCE: "SYNTHETIC_SIMULATOR",
} });

const sm = await import("../../shadowMode.js");

test("gates list the strategies that trade; demotion scan checks them", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-01T10:00:00Z") });
  try {
    sm.startShadowMode({ symbols: ["EURUSD"], intervalSec: 3600 });
    scan = { direction: "BUY", confidence: 75, entryPrice: 100, stopLoss: 99, takeProfit: 102,
      strategy: "Break of Structure", reason: "r", riskWarning: "" };
    px = 100;
    for (let i = 0; i < 10; i++) assert.ok(sm.createShadowDecision("EURUSD"));
    px = 98; // all ten hit the stop
    mock.timers.tick(1000);
    scan = { direction: "WAIT", confidence: 0, entryPrice: 100, stopLoss: 0, takeProfit: 0,
      strategy: "No Trade Filter", reason: "No actionable signal from any strategy", riskWarning: "" };
    assert.ok(sm.createShadowDecision("EURUSD"));

    const scanned = sm.demotionScan();
    const bos = scanned.find((d) => d.strategy === "Break of Structure");
    assert.ok(bos, "a strategy that trades is checked");
    assert.ok(bos.reasons.includes("WIN_RATE_LOW"));
    assert.ok(bos.reasons.includes("NEGATIVE_R"));
    assert.equal(bos.suggested, "PAUSED");
    assert.equal(bos.tracked, 10);
    assert.ok(!scanned.some((d) => d.strategy === "No Trade Filter"), "a scan placeholder is not a strategy");

    // A failed promote must not create a gate record either.
    assert.equal(sm.promote("Custom Strategy", "ADMIN").ok, false);

    const gates = sm.promotionStatus();
    const names = gates.map((g) => g.strategy);
    for (const placeholder of ["Conservative Pullback", "Breakout Confirmation", "Gold Scalping Test", "Custom Strategy", "No Trade Filter"]) {
      assert.ok(!names.includes(placeholder), `${placeholder} never made a decision`);
    }
    const g = gates.find((x) => x.strategy === "Break of Structure");
    assert.ok(g);
    assert.equal(g.level, "TESTING");
    assert.equal(g.updatedAt, null, "no promotion or demotion happened");
    assert.equal(g.lastReason, null);

    // An explicit action is an event with a time and reason.
    sm.demote("Break of Structure", "PAUSED", "manual", "ADMIN");
    const after = sm.promotionStatus().find((x) => x.strategy === "Break of Structure");
    assert.ok(after?.updatedAt);
    assert.match(String(after?.lastReason), /Demoted to PAUSED by ADMIN: manual/);
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});
