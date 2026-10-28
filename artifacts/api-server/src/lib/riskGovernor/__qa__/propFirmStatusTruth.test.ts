// Prop Firm Mode status is a read model of the paper book. It used to score
// rules it had not measured:
//   - with no active paper account, equity is unknown, yet profit read $0,
//     the daily and total drawdown rules were listed as passed and the
//     challenge read ACTIVE.
//
// propFirmStatus runs for real; its fact sources (the governor's context
// builder, the trader's settings row, the platform halt) are mocked. No
// database, no broker, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/propFirmStatusTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Ctx = Record<string, unknown>;
const state: { ctx: Ctx; settings: Record<string, unknown> } = { ctx: {}, settings: {} };

const LIMITS = {
  maxLotSize: 1, maxDailyLossPercent: null, maxDailyLossAmount: 5000, maxRiskPerTradePercent: 1,
  maxRiskPerTradeAmount: null, maxDrawdownPercent: 10,
  discipline: { maxTradesPerDay: null, maxOpenTrades: 3, maxWeeklyLossAmount: null, maxWeeklyLossPercent: null },
};

function ctxWith(over: Ctx): Ctx {
  return {
    now: new Date("2026-10-28T12:00:00Z"), limits: LIMITS, account: null, instruments: {}, quote: null,
    positions: [], inFlight: [], broker: { status: "DISCONNECTED", lastSeenAt: null, detail: "no active paper account" },
    daily: { realizedPnl: 0, floatingPnl: null }, halt: { engaged: false, sources: [], reason: null }, activity: null,
    ...over,
  };
}

const table = () => ({ id: {}, userId: {}, createdAt: {} });
mock.module("@workspace/db", {
  namedExports: {
    db: { select: () => { throw new Error("not used"); }, update: () => { throw new Error("not used"); } },
    userRiskSettingsTable: table(), userRiskEventsTable: table(),
  },
});
mock.module("../enforce.js", { namedExports: { buildRiskContext: async () => state.ctx } });
mock.module("../riskEvents.js", { namedExports: { getOrCreateRiskSettings: async () => state.settings } });
mock.module("../../safety/tradingHalt.js", {
  namedExports: { loadPlatformHalt: async () => ({ engaged: false, sources: [], reason: null }) },
});

const { propFirmStatus } = await import("../riskProfile.js");

test("no active paper account: nothing is measured, no rule is passed, the challenge is not ACTIVE", async () => {
  state.ctx = ctxWith({ account: null, daily: { realizedPnl: 0, floatingPnl: null } });
  state.settings = { riskPreset: null, propFirm: { enabled: true } };
  const s = await propFirmStatus(1);
  assert.equal(s.config.enabled, true);
  assert.notEqual(s.status, "ACTIVE");
  assert.equal(s.status, "NOT_MEASURED");
  assert.deepEqual(s.passed, []);
  assert.deepEqual(s.failed, []);
  assert.equal(s.measured, false);
  assert.match(s.notMeasuredReason ?? "", /no active paper account/i);
  assert.equal(s.profitUsd, null, "unknown equity is not $0 profit");
  assert.equal(s.profitTargetProgress, null);
  assert.equal(s.dailyDrawdownRemainingUsd, null);
  assert.equal(s.totalDrawdownRemainingUsd, null);
  const unchecked = s.notChecked.map((r) => r.rule);
  for (const rule of ["PROFIT_TARGET", "DAILY_DD", "TOTAL_DD"]) assert.ok(unchecked.includes(rule), `${rule} is listed as not checked`);
});

test("mode off with no paper account reads OFF, still with nothing scored", async () => {
  state.ctx = ctxWith({ account: null });
  state.settings = { riskPreset: null, propFirm: { enabled: false } };
  const s = await propFirmStatus(1);
  assert.equal(s.status, "OFF");
  assert.deepEqual(s.passed, []);
  assert.equal(s.profitUsd, null);
});
