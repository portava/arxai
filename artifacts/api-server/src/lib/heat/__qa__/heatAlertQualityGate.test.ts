// Heat Alert Emitter — data-quality honesty gate + honest danger-alert copy.
//
// BEFORE
//   emitHeatAlerts skipped only `dataQuality.label === "unavailable"`, a label
//   resolveDataQuality NEVER emits (it emits basic_timing_estimate | real |
//   partial). The "honest absence" guard was dead code, so a session-clock-only
//   read (no candles AND no quotes) could push a critical heat_danger_window
//   alert whose copy asserted "spread, trap risk, or structural breakdown
//   active" — three measurements the read never made.
//
// AFTER
//   - isAlertBlockedQuality blocks BOTH "unavailable" and
//     "basic_timing_estimate": no market data ⇒ no market-condition alert.
//   - The danger alert names only the drivers actually present in the read,
//     falling back to an honest "composite danger score is elevated".
//
// Deterministic + DB-free: buildDescriptors and isAlertBlockedQuality are pure.
// DATABASE_URL is stubbed to a closed port ONLY so the @workspace/db module
// import (a transitive dependency of the emitter) does not throw; nothing here
// touches the pool.
//
// Run: node --import tsx --test src/lib/heat/__qa__/heatAlertQualityGate.test.ts

process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarketTimingRead } from "@workspace/domain/timing-brain";

// Dynamic import: static ESM imports hoist above the DATABASE_URL stub and the
// @workspace/db module (a transitive dependency) throws at load without it.
const { isAlertBlockedQuality, buildDescriptors } =
  await import("../heatAlertEmitter.js");

function baseRead(partial: Partial<MarketTimingRead> = {}): MarketTimingRead {
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    generatedAt: new Date(0).toISOString(),
    heatScore: 50,
    tradeabilityScore: 50,
    edgeScore: 50,
    dangerScore: 30,
    trapProbability: 20,
    roomToMove: 50,
    buyPressure: 50,
    sellPressure: 50,
    pressureBias: "NEUTRAL",
    timingGrade: "C",
    entryPermission: "WAIT_FOR_ENTRY",
    heatState: "COMPRESSION",
    moveStage: "EARLY",
    heatSource: {
      primary: "unknown",
      primaryConfidence: 40,
      backup: null,
      backupConfidence: null,
      explanation: "test",
    },
    session: {
      sessionName: "London",
      killZone: "OFF_KILLZONE",
      isKillZoneActive: false,
      utcHour: 10,
      sessionHeatBonus: 0,
      fakeoutRisk: 30,
      tradeabilityBonus: 0,
      bestSymbols: [],
      dangerSymbols: [],
      sessionDescription: "test",
      userLocalTime: null,
    },
    newsOverlay: {
      phase: "NONE",
      eventName: null,
      minutesUntil: null,
      minutesSince: null,
      eventType: "none",
      surpriseScore: null,
      heatAdjustment: 0,
      blocksTrade: false,
    },
    broadFlow: {
      verdict: "NEUTRAL",
      institutionalFlowScore: 50,
      competingCatalyst: false,
      description: "test",
      correlatedAssets: [],
      dataQuality: "real",
    },
    bestAction: "WAIT_BETTER_TIMING",
    actionReason: "test",
    dataQuality: {
      label: "real",
      hasCandleData: true,
      hasQuoteData: true,
      hasNewsData: true,
      hasBroadFlowData: true,
      note: "test",
    },
    ...partial,
  } as MarketTimingRead;
}

// ── 1. The quality gate blocks clock-only estimates, not just "unavailable" ──

test("basic_timing_estimate (session-clock only) is alert-blocked", () => {
  assert.equal(isAlertBlockedQuality("basic_timing_estimate"), true);
});

test("unavailable is alert-blocked", () => {
  assert.equal(isAlertBlockedQuality("unavailable"), true);
});

test("real and partial reads may emit alerts", () => {
  assert.equal(isAlertBlockedQuality("real"), false);
  assert.equal(isAlertBlockedQuality("partial"), false);
});

// ── 2. Danger-alert copy names only measured drivers ─────────────────────────

test("danger alert with an AT_EVENT + trap read names those drivers, not a blanket claim", () => {
  const read = baseRead({
    dangerScore: 80,
    trapProbability: 70,
    newsOverlay: {
      phase: "AT_EVENT",
      eventName: "NFP",
      minutesUntil: 0,
      minutesSince: null,
      eventType: "high_impact",
      surpriseScore: null,
      heatAdjustment: 40,
      blocksTrade: false,
    },
  });
  const danger = buildDescriptors(read, false).find((d) => d.alertType === "heat_danger_window");
  assert.ok(danger, "danger descriptor expected at dangerScore 80");
  assert.match(danger.message, /high-impact news window/);
  assert.match(danger.message, /trap probability 70%/);
  // The old blanket assertion may never come back.
  assert.doesNotMatch(danger.message, /spread, trap risk, or structural breakdown/);
});

test("danger alert with no identifiable driver falls back to an honest composite-score line", () => {
  // Reachable with zero candles/quotes: base 20 + fakeout*0.4-style session
  // inputs push the composite over 70 without any single named driver.
  const read = baseRead({ dangerScore: 72 });
  const danger = buildDescriptors(read, false).find((d) => d.alertType === "heat_danger_window");
  assert.ok(danger, "danger descriptor expected at dangerScore 72");
  assert.match(danger.message, /Composite danger score is elevated/);
  assert.doesNotMatch(danger.message, /spread, trap risk, or structural breakdown/);
  assert.doesNotMatch(danger.message, /Drivers:/);
});

test("danger alert names structure + session fakeout drivers when present", () => {
  const read = baseRead({
    dangerScore: 75,
    heatState: "TRAP_HEAT",
    session: { ...baseRead().session, fakeoutRisk: 80 },
  });
  const danger = buildDescriptors(read, false).find((d) => d.alertType === "heat_danger_window");
  assert.ok(danger, "danger descriptor expected");
  assert.match(danger.message, /trap heat structure/);
  assert.match(danger.message, /elevated session fakeout risk/);
});
