// riskOverview's permissions.trading reflected only the stop switches. With
// the daily loss limit reached and no halt engaged, the budget read BLOCK
// while permissions said trading: true, and Risk Command Center's Rules tab
// ("Whether your account can open new trades right now") showed
// "trading: true". The Risk Governor refuses new risk at that point.
//
// permissions.trading is now false whenever a stop switch is engaged or a
// loss limit the overview measures is reached (a downgrade only), and
// blockedBy names what stops new trades. No gate reads these fields.
//
// riskOverview runs for real; the governor's context builder, the trader's
// settings row and the platform halt are mocked. No database, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/riskOverviewPermissions.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const state: { ctx: Record<string, unknown> } = { ctx: {} };

const LIMITS = {
  maxLotSize: 1, maxDailyLossPercent: null, maxDailyLossAmount: 100, maxRiskPerTradePercent: 1,
  maxRiskPerTradeAmount: null, maxDrawdownPercent: null,
  discipline: { maxTradesPerDay: null, maxOpenTrades: 3, maxWeeklyLossAmount: 300, maxWeeklyLossPercent: null },
};
const ACTIVITY = { tradesToday: 2, weekRealizedPnl: 0, consecutiveLosses: 0, closesInLastHour: 0, reentriesAfterLossInLastHour: 0 };

function ctxWith(over: Record<string, unknown>): Record<string, unknown> {
  return {
    now: new Date("2026-10-28T12:00:00Z"), limits: LIMITS,
    account: { equity: 10_000, freeMargin: 10_000, leverage: 100, currency: "USD", source: "paper_account:3" },
    instruments: {}, quote: null, positions: [], inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: null, detail: "internal paper simulator" },
    daily: { realizedPnl: 0, floatingPnl: 0 }, halt: { engaged: false, sources: [], reason: null }, activity: ACTIVITY,
    ...over,
  };
}

const table = () => ({ id: {}, userId: {}, createdAt: {} });
mock.module("@workspace/db", {
  namedExports: { db: { select: () => { throw new Error("not used"); } }, userRiskSettingsTable: table(), userRiskEventsTable: table() },
});
mock.module("../enforce.js", { namedExports: { buildRiskContext: async () => state.ctx } });
mock.module("../riskEvents.js", { namedExports: { getOrCreateRiskSettings: async () => ({ riskPreset: null }) } });
mock.module("../limitSettings.js", { namedExports: { loadEffectiveLimits: async () => LIMITS } });
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: { readActivePaperAccount: async () => null, sumPaperRealizedSince: async () => 0 },
});
mock.module("../../safety/tradingHalt.js", {
  namedExports: { loadPlatformHalt: async () => ({ engaged: false, sources: [], reason: null }) },
});

const { riskOverview } = await import("../riskProfile.js");

test("daily loss limit reached with no halt: BLOCK, and permissions do not say trading", async () => {
  state.ctx = ctxWith({ daily: { realizedPnl: -120, floatingPnl: 0 } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.riskStatus, "BLOCK");
  assert.equal(ov.halt.engaged, false);
  assert.equal(ov.permissions.trading, false, "BLOCK and trading:true contradict each other");
  assert.deepEqual(ov.permissions.blockedBy, ["daily_loss_limit"]);
  assert.equal(ov.permissions.stopSwitchEngaged, false);
});

test("weekly loss limit reached: blockedBy names it", async () => {
  state.ctx = ctxWith({ activity: { ...ACTIVITY, weekRealizedPnl: -400 } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.riskStatus, "BLOCK");
  assert.equal(ov.permissions.trading, false);
  assert.deepEqual(ov.permissions.blockedBy, ["weekly_loss_limit"]);
});

test("an engaged stop switch: trading false, blockedBy stop_switch, reason kept", async () => {
  state.ctx = ctxWith({ halt: { engaged: true, sources: ["user_kill_switch"], reason: "Paused by you" } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.permissions.trading, false);
  assert.equal(ov.permissions.stopSwitchEngaged, true);
  assert.deepEqual(ov.permissions.blockedBy, ["stop_switch"]);
  assert.equal(ov.permissions.pauseReason, "Paused by you");
});

test("nothing reached and no halt: trading true, blockedBy empty", async () => {
  state.ctx = ctxWith({ daily: { realizedPnl: -10, floatingPnl: 0 } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.riskStatus, "OK");
  assert.equal(ov.permissions.trading, true);
  assert.deepEqual(ov.permissions.blockedBy, []);
});
