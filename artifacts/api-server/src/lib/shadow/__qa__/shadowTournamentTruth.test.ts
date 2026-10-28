// Strategy Tournament truth: RUNNING only while decisions are being produced;
// only strategies with tracked outcomes are ranked; scan placeholders are not
// strategies; best-per-market picks come from the market actually traded.
//
// Before: the badge stayed RUNNING after shadow mode stopped (nothing reset
// it); "No Trade Filter" (the scan's no-signal placeholder) was ranked with
// n=0, WR 0, Exp -1, Conf acc 0, Risk disc 100 and could be named "worst";
// bestGold/bestForex were picked by a regex on the strategy NAME.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/shadow/__qa__/shadowTournamentTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

let scan: Record<string, unknown> = {};
let px: Record<string, number> = {};

const realEngine = await import("../../strategyEngine.js");
mock.module("../../strategyEngine.js", { namedExports: { ...realEngine, runStrategyScan: () => ({ ...scan }) } });
const realOms = await import("../../oms.js");
mock.module("../../oms.js", { namedExports: { ...realOms, previewSimulatorEntry: () => ({ decision: "ALLOW", blockedBy: [], rules: [] }) } });
const realSim = await import("../../marketSimulator.js");
mock.module("../../marketSimulator.js", { namedExports: { ...realSim, marketSimulator: {
  candlesFor: (_s: string, n = 60) => Array.from({ length: Math.min(n, 40) }, (_, i) => ({
    tsIso: new Date(Date.UTC(2026, 9, 1, 0, i * 15)).toISOString(), o: 100, h: 101, l: 99, c: 100, v: 1,
  })),
  quote: (s: string) => ({ bid: px[s] ?? 100, ask: px[s] ?? 100, mid: px[s] ?? 100 }),
} } });
mock.module("../../shadowPersistence.js", { namedExports: {
  persistShadowDecision: async () => {}, updateShadowOutcome: async () => {},
  SYNTHETIC_SIMULATOR_SOURCE: "SYNTHETIC_SIMULATOR",
} });

const sm = await import("../../shadowMode.js");

const buy = (strategy: string) => ({ direction: "BUY", confidence: 75, entryPrice: 100, stopLoss: 99, takeProfit: 102,
  strategy, reason: "r", riskWarning: "" });

/** One tracked outcome for `strategy` on `symbol`: win (+2R) or loss (-1R). */
function outcome(strategy: string, symbol: string, win: boolean) {
  scan = buy(strategy);
  px[symbol] = 100;
  assert.ok(sm.createShadowDecision(symbol));
  px[symbol] = win ? 103 : 98;
  mock.timers.tick(1000);
  px[symbol] = 100;
}

test("tournament ranks only real strategies with tracked outcomes and goes idle when shadow mode stops", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-01T10:00:00Z") });
  try {
    sm.startTournament();
    assert.equal(sm.tournamentResults().running, true);

    // The scan's "no actionable signal" placeholder, and a strategy that only waited.
    scan = { direction: "WAIT", confidence: 0, entryPrice: 100, stopLoss: 0, takeProfit: 0,
      strategy: "No Trade Filter", reason: "No actionable signal from any strategy", riskWarning: "" };
    assert.ok(sm.createShadowDecision("EURUSD"));
    scan = { direction: "WAIT", confidence: 20, entryPrice: 100, stopLoss: 0, takeProfit: 0,
      strategy: "Session Breakout", reason: "inside range", riskWarning: "" };
    assert.ok(sm.createShadowDecision("EURUSD"));

    // "Break of Structure" wins on gold, loses on EURUSD; "Trend Continuation" wins on EURUSD.
    outcome("Break of Structure", "XAUUSD", true);
    outcome("Break of Structure", "XAUUSD", true);
    outcome("Break of Structure", "EURUSD", false);
    outcome("Trend Continuation", "EURUSD", true);

    const t = sm.tournamentResults();
    const names = t.ranked.map((r) => r.strategy);
    assert.ok(!names.includes("No Trade Filter"), "a scan placeholder is not a strategy");
    assert.ok(!names.includes("Session Breakout"), "no tracked outcome, so not ranked");
    assert.deepEqual([...names].sort(), ["Break of Structure", "Trend Continuation"]);
    for (const r of t.ranked) {
      assert.ok(r.sample > 0);
      assert.equal(typeof r.confidenceAccuracy, "number");
      assert.equal(typeof r.riskDiscipline, "number");
    }
    assert.ok(t.unranked.some((u) => u.strategy === "Session Breakout"));
    assert.ok(!t.unranked.some((u) => u.strategy === "No Trade Filter"));
    assert.notEqual(t.leaderboard.worst, "No Trade Filter");
    assert.notEqual(t.leaderboard.worst, "Session Breakout");
    assert.equal(t.leaderboard.bestGold, "Break of Structure", "best on the gold it actually traded");
    assert.equal(t.leaderboard.bestForex, "Trend Continuation", "best on the forex it actually traded");
    assert.equal(t.leaderboard.bestScalping, null, "no decision records a scalping style");

    sm.stopShadowMode();
    const idle = sm.tournamentResults();
    assert.equal(idle.running, false, "no decisions are being produced");
    assert.equal(idle.idleReason, "SHADOW_STOPPED");
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});

test("with no tracked outcomes nothing is named best or worst", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-02T10:00:00Z") });
  try {
    sm.startTournament(); // new window
    scan = { direction: "WAIT", confidence: 0, entryPrice: 100, stopLoss: 0, takeProfit: 0,
      strategy: "No Trade Filter", reason: "No actionable signal from any strategy", riskWarning: "" };
    assert.ok(sm.createShadowDecision("EURUSD"));
    const t = sm.tournamentResults();
    assert.deepEqual(t.ranked, []);
    assert.equal(t.leaderboard.bestOverall, null);
    assert.equal(t.leaderboard.worst, null);
    assert.equal(t.leaderboard.toRetire, null);
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});
