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

// With no active paper account the daily drawdown is a placeholder 0 too
// (realized P/L is never read, floating P/L is unknown), so DAILY_DD is not
// evaluated either; it was listed as passed ("✓ DAILY_DD") beside
// "TOTAL_DD: not checked".
test("with no active paper account, PROFIT_TARGET, DAILY_DD and TOTAL_DD are not evaluated, never passed", async () => {
  propFirm = { enabled: true };
  equity = null;
  const s = await propFirmStatus(1);
  assert.deepEqual(s.passed, [], `passed: ${s.passed.join(",")}`);
  assert.deepEqual(s.failed, []);
  assert.deepEqual([...s.notEvaluated].sort(), ["DAILY_DD", "PROFIT_TARGET", "TOTAL_DD"]);
  assert.equal(s.equityMeasured, false);
  assert.equal(s.dailyDrawdownMeasured, false);
  assert.equal(s.notEvaluatedReasons["DAILY_DD"], "there is no active paper account");
  assert.equal(s.notEvaluatedReasons["TOTAL_DD"], "there is no active paper account");
  assert.equal(s.status, "ACTIVE");
});

// The placeholder profit (0) met a profit target of 0 (the schema allows it),
// so the status was a green PASSED while PROFIT_TARGET was "not checked".
test("a placeholder profit never turns the status PASSED, even with a profit target of 0", async () => {
  propFirm = { enabled: true, profitTarget: 0 };
  equity = null;
  const s = await propFirmStatus(1);
  assert.notEqual(s.status, "PASSED");
  assert.equal(s.status, "ACTIVE");
  // With equity measured, a target of 0 is met.
  equity = 100_000;
  assert.equal((await propFirmStatus(1)).status, "PASSED");
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
  assert.equal(s.dailyDrawdownMeasured, true);
  assert.deepEqual(s.notEvaluatedReasons, {});
});
