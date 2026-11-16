// Shadow Journal truth: an outcome whose R was never measured never reads
// "R=0", and a finished idea is never "PENDING".
//
// Before: whatHappened was `${status} (R=${pnlR ?? 0})`, so an expired idea
// (no R measured) read "SHADOW_EXPIRED (R=0)" — breakeven — and wins showed
// unrounded R such as 1.6666666666666667. Every status other than WIN/LOSS,
// including terminal REJECTED, WAIT, EXPIRED and BREAKEVEN, read "PENDING",
// and an expired idea's lesson named a cause ("entry timing too late or
// chop") nobody checked.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/shadow/__qa__/shadowJournalTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

let scan: Record<string, unknown> = {};
let px = 1.1;
let verdict: "ALLOW" | "BLOCK" = "ALLOW";

const realEngine = await import("../../strategyEngine.js");
mock.module("../../strategyEngine.js", { namedExports: { ...realEngine, runStrategyScan: () => ({ ...scan }) } });
const realOms = await import("../../oms.js");
mock.module("../../oms.js", { namedExports: { ...realOms, previewSimulatorEntry: () => (verdict === "ALLOW"
  ? { decision: "ALLOW", blockedBy: [], rules: [] }
  : { decision: "BLOCK", blockedBy: ["AI_CONFIDENCE"], rules: [] }) } });
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

const BUY = { direction: "BUY", confidence: 70, entryPrice: 1.1, stopLoss: 1.085, takeProfit: 1.125,
  strategy: "Trend Continuation", reason: "r", riskWarning: "" };

function entryFor(id: string) {
  const e = sm.shadowJournal(500).find((x) => x.id === id);
  assert.ok(e, `journal entry ${id}`);
  return e;
}

test("journal outcomes say what was measured", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-01T10:00:00Z") });
  try {
    sm.startShadowMode({ symbols: ["EURUSD"], intervalSec: 3600 });

    // Expired with drift >= 0.1R: no R was measured.
    scan = BUY; px = 1.1;
    const expired = sm.createShadowDecision("EURUSD")!;
    px = 1.105; // +0.33R, neither stop nor target
    mock.timers.tick(6 * 60_000);
    assert.equal(sm.listDecisions(500).find((d) => d.id === expired.id)!.status, "SHADOW_EXPIRED");
    const ex = entryFor(expired.id);
    assert.doesNotMatch(ex.whatHappened, /R=0\b/);
    assert.match(ex.whatHappened, /not measured/i);
    assert.notEqual(ex.rightOrWrong, "PENDING");
    assert.doesNotMatch(ex.lesson, /too late|chop/i, "no cause was checked");

    // Breakeven: expired within 0.1R of entry — measured, terminal.
    px = 1.1;
    const be = sm.createShadowDecision("EURUSD")!;
    mock.timers.tick(6 * 60_000);
    assert.equal(sm.listDecisions(500).find((d) => d.id === be.id)!.status, "SHADOW_BREAKEVEN");
    assert.notEqual(entryFor(be.id).rightOrWrong, "PENDING");

    // Win at +1.67R is rounded.
    px = 1.1;
    const win = sm.createShadowDecision("EURUSD")!;
    px = 1.13;
    mock.timers.tick(1000);
    const w = entryFor(win.id);
    assert.equal(w.rightOrWrong, "RIGHT");
    assert.match(w.whatHappened, /R=\+?1\.67\b/);
    assert.doesNotMatch(w.whatHappened, /1\.666/);

    // Still open: pending.
    px = 1.1;
    const open = sm.createShadowDecision("EURUSD")!;
    assert.equal(entryFor(open.id).rightOrWrong, "PENDING");

    // Rejected by the risk governor and WAIT: terminal, not pending.
    verdict = "BLOCK";
    const rej = sm.createShadowDecision("EURUSD")!;
    verdict = "ALLOW";
    assert.equal(rej.status, "SHADOW_REJECTED");
    assert.notEqual(entryFor(rej.id).rightOrWrong, "PENDING");

    scan = { ...BUY, direction: "WAIT", stopLoss: 0, takeProfit: 0, strategy: "No Trade Filter" };
    const wait = sm.createShadowDecision("EURUSD")!;
    assert.equal(wait.status, "SHADOW_WAIT");
    assert.notEqual(entryFor(wait.id).rightOrWrong, "PENDING");
    assert.doesNotMatch(entryFor(wait.id).whatHappened, /R=/);
  } finally {
    sm.stopShadowMode();
    mock.timers.reset();
  }
});
