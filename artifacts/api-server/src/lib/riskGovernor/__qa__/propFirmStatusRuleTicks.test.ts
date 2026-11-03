// GET /prop-firm/status listed "DAILY_DD" and "TOTAL_DD" as passed while the
// mode was OFF (nothing was being checked), and with no readable paper equity
// it took profit as 0, so TOTAL_DD was "passed" without a measurement. Rules
// are now listed only while the mode is on, and a rule that cannot be
// measured is listed under notEvaluated.
//
// Since the merge with round-3 fix-2, the challenge is measured from the
// active paper account's equity when it started (config.challengeStart), not
// from the governor's equity against the configured size: the paper book
// reader is stubbed here too, and "with equity" means a recorded start on
// the active paper account.
//
// The governor facts, settings, limits and paper book are stubbed; the real
// propFirmStatus runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/propFirmStatusRuleTicks.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";

let propFirm: Record<string, unknown> | null = null;
let equity: number | null = null;
mock.module("../riskEvents.js", {
  namedExports: { getOrCreateRiskSettings: async () => ({ userId: 1, riskPreset: null, propFirm }) },
});
mock.module("../enforce.js", {
  namedExports: {
    buildRiskContext: async () => ({
      limits: { maxDailyLossAmount: null, maxDailyLossPercent: null, discipline: { maxWeeklyLossAmount: null, maxWeeklyLossPercent: null } },
      account: equity == null ? null : { equity },
      daily: { realizedPnl: 0, floatingPnl: 0 },
      activity: null, positions: [], instruments: {}, halt: null,
    }),
  },
});
mock.module("../../safety/tradingHalt.js", {
  namedExports: { loadPlatformHalt: async () => ({ engaged: false, sources: [], reason: null }) },
});
mock.module("@workspace/db", { namedExports: { db: {}, userRiskEventsTable: {}, userRiskSettingsTable: {} } });
// The active paper account carries the equity (null equity = no account).
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    readActivePaperAccount: async () => (equity == null ? null
      : { id: 3, equity, currentBalance: equity, startingBalance: 100_000, updatedAt: new Date("2026-10-28T11:59:00Z") }),
    sumPaperRealizedSince: async () => 0,
  },
});
mock.module("../limitSettings.js", {
  namedExports: {
    loadEffectiveLimits: async () => ({
      maxLotSize: 1, discipline: { maxOpenTrades: 3, maxTradesPerDay: null, maxWeeklyLossAmount: null, maxWeeklyLossPercent: null },
    }),
  },
});

const { propFirmStatus } = await import("../riskProfile.js");

// A challenge started on the active paper account (#3) with $100k equity.
const START = { at: "2026-10-27T09:00:00.000Z", paperAccountId: 3, equity: 100_000, equityAsOf: "2026-10-27T08:59:00.000Z" };
const NOW = new Date("2026-10-28T12:00:00Z");

test("while the mode is OFF no rule is listed as passed or failed", async () => {
  propFirm = { enabled: false };
  equity = 100_000;
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.status, "OFF");
  assert.deepEqual(s.passed, []);
  assert.deepEqual(s.failed, []);
  assert.equal(s.rulesEvaluated, false);
});

test("while the mode is OFF with a recorded start, still no rule is listed as passed or failed", async () => {
  propFirm = { enabled: false, challengeStart: START };
  equity = 101_000;
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.status, "OFF");
  assert.deepEqual(s.passed, []);
  assert.deepEqual(s.failed, []);
  assert.equal(s.rulesEvaluated, false);
});

test("with no readable paper equity, TOTAL_DD and PROFIT_TARGET are not evaluated, never passed", async () => {
  propFirm = { enabled: true };
  equity = null;
  const s = await propFirmStatus(1, NOW);
  assert.ok(!s.passed.includes("TOTAL_DD"), `passed: ${s.passed.join(",")}`);
  assert.ok(!s.passed.includes("PROFIT_TARGET"));
  // Merged with fix-2: with no paper account nothing is measured, so today's
  // drawdown (DAILY_DD) is not evaluated either.
  assert.deepEqual([...s.notEvaluated].sort(), ["DAILY_DD", "PROFIT_TARGET", "TOTAL_DD"]);
  assert.equal(s.equityMeasured, false);
});

test("while the mode is on with equity, the drawdown rules are checked as before", async () => {
  propFirm = { enabled: true, challengeStart: START };
  equity = 101_000;
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.status, "ACTIVE");
  assert.deepEqual(s.passed, ["DAILY_DD", "TOTAL_DD"]);
  assert.deepEqual(s.failed, []);
  assert.deepEqual(s.notEvaluated, []);
  assert.equal(s.rulesEvaluated, true);
});
