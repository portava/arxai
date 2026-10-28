// GET /prop-firm/status listed "DAILY_DD" and "TOTAL_DD" as passed while the
// mode was OFF (nothing was being checked), and with no readable paper equity
// it took profit as 0, so TOTAL_DD was "passed" without a measurement. Rules
// are now listed only while the mode is on, and a rule that needs the equity
// is listed under notEvaluated when the equity is missing.
//
// The governor facts and settings are stubbed; the real propFirmStatus runs.
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

const { propFirmStatus } = await import("../riskProfile.js");

test("while the mode is OFF no rule is listed as passed or failed", async () => {
  propFirm = { enabled: false };
  equity = 100_000;
  const s = await propFirmStatus(1);
  assert.equal(s.status, "OFF");
  assert.deepEqual(s.passed, []);
  assert.deepEqual(s.failed, []);
  assert.equal(s.rulesEvaluated, false);
});

test("with no readable paper equity, TOTAL_DD and PROFIT_TARGET are not evaluated, never passed", async () => {
  propFirm = { enabled: true };
  equity = null;
  const s = await propFirmStatus(1);
  assert.ok(!s.passed.includes("TOTAL_DD"), `passed: ${s.passed.join(",")}`);
  assert.ok(!s.passed.includes("PROFIT_TARGET"));
  assert.deepEqual([...s.notEvaluated].sort(), ["PROFIT_TARGET", "TOTAL_DD"]);
  assert.equal(s.equityMeasured, false);
});

test("while the mode is on with equity, the drawdown rules are checked as before", async () => {
  propFirm = { enabled: true };
  equity = 101_000;
  const s = await propFirmStatus(1);
  assert.equal(s.status, "ACTIVE");
  assert.deepEqual(s.passed, ["DAILY_DD", "TOTAL_DD"]);
  assert.deepEqual(s.failed, []);
  assert.deepEqual(s.notEvaluated, []);
  assert.equal(s.rulesEvaluated, true);
});
