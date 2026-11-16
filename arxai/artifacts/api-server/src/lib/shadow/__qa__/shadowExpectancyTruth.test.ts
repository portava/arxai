// Strategy Tournament / Promotion truth: expectancy is the average R per
// tracked trade, and a profit factor with no losses is "not measurable", not
// the win count.
//
// Before: expectancy = winRate * max(0, avgR) - (1 - winRate), which marked a
// 50% win-rate strategy averaging +0.33R as -0.33R, ranked it last, named it
// "toRetire" and kept the DEMO_APPROVED gate (expectancy > 0) shut. With zero
// losses the profit factor was the number of wins.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/shadow/__qa__/shadowExpectancyTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// Controlled scan + price so outcomes resolve deterministically.
let scan: Record<string, unknown> = {};
let px = 1.1;

const realEngine = await import("../../strategyEngine.js");
mock.module("../../strategyEngine.js", { namedExports: { ...realEngine, runStrategyScan: () => ({ ...scan }) } });
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

function buyScan(strategy: string) {
  // entry 1.1, stop 0.015 below (1R), target 0.025 above (+1.67R).
  return { direction: "BUY", confidence: 80, entryPrice: 1.1, stopLoss: 1.085, takeProfit: 1.125,
    strategy, reason: "r", riskWarning: "" };
}

/** Create `n` decisions, then move the price to `exitPx` and let the tracker resolve them. */
function resolve(strategy: string, n: number, exitPx: number) {
  scan = buyScan(strategy);
  px = 1.1;
  for (let i = 0; i < n; i++) assert.ok(sm.createShadowDecision("EURUSD"));
  px = exitPx;
  mock.timers.tick(1000);
}

test("a +0.33R-per-trade strategy reads expectancy +0.33R, is not ranked to retire, and PF is gross win / gross loss", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-01T10:00:00Z") });
  try {
    sm.startShadowMode({ symbols: ["EURUSD"], intervalSec: 3600 });
    resolve("Trend Continuation", 10, 1.13); // 10 wins at +1.67R
    resolve("Trend Continuation", 10, 1.08); // 10 losses at -1R

    const t = sm.tournamentResults();
    const row = t.ranked.find((r) => r.strategy === "Trend Continuation");
    assert.ok(row, "the strategy is ranked");
    assert.equal(row.sample, 20);
    assert.equal(row.winRate, 50);
    assert.equal(row.avgR, 0.33);
    assert.equal(row.expectancy, 0.33, "expectancy per trade is the average R");
    assert.equal(row.profitFactor, 1.67, "16.67R won / 10R lost");
    assert.notEqual(t.leaderboard.toRetire, "Trend Continuation");

    const gate = sm.promotionStatus().find((g) => g.strategy === "Trend Continuation");
    assert.ok(gate);
    assert.ok(Math.abs(gate.stats.expectancy - 1 / 3) < 0.01, `promotion expectancy ${gate.stats.expectancy}`);
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});

test("profit factor with wins and no losses is not measurable (null), never the win count", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-02T10:00:00Z") });
  try {
    sm.startShadowMode({ symbols: ["EURUSD"], intervalSec: 3600 });
    resolve("Break of Structure", 3, 1.13); // 3 wins, 0 losses
    const row = sm.tournamentResults().ranked.find((r) => r.strategy === "Break of Structure");
    assert.ok(row);
    assert.equal(row.sample, 3);
    assert.notEqual(row.profitFactor, 3);
    assert.equal(row.profitFactor, null);
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});
