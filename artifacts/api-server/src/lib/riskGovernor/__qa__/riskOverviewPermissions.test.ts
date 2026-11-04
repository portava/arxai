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
  namedExports: { db: { select: () => { throw new Error("not used"); } }, userRiskSettingsTable: table(), userRiskEventsTable: table(), arxSymbolSpecsTable: table() },
});
mock.module("../enforce.js", { namedExports: { buildRiskContext: async () => state.ctx } });
mock.module("../riskEvents.js", { namedExports: { getOrCreateRiskSettings: async () => ({ riskPreset: null }) } });
mock.module("../limitSettings.js", { namedExports: { loadEffectiveLimits: async () => LIMITS } });
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: { readActivePaperAccount: async () => null, sumPaperRealizedSince: async () => 0, readPaperCloses: async () => [], readOpenPaperOrders: async () => [] },
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

// With a weekly cap set and the trading activity unreadable (no paper
// account, or the closes read failed), weekly use was read as 0, so the
// limit read "not reached", trading stayed true and the Rules tab said "not
// blocked by ... loss limit". The Risk Governor hard-blocks every new order
// in exactly this case (evaluateDiscipline: activity null with an activity
// cap set). Unmeasured use is now null, and blockedBy names the block.
test("activity unreadable with a weekly cap: weekly use is not 0, and new trades are blocked as the governor blocks them", async () => {
  state.ctx = ctxWith({ activity: null });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.weeklyRiskUsed, null, "not measured, not 0");
  assert.equal(ov.budget.weeklyRiskRemaining, null);
  assert.equal(ov.budget.weeklyRiskLimit, 300, "the cap itself is known");
  assert.equal(ov.budget.weeklyRiskUsedUnmeasured, true);
  assert.equal(ov.permissions.trading, false);
  assert.deepEqual(ov.permissions.blockedBy, ["activity_unread"]);
  assert.notEqual(ov.budget.riskStatus, "OK");
  assert.match(String(ov.budget.riskStatusReason), /weekly risk used is unknown/);
});

test("activity unreadable with no activity cap set: not blocked on it (the governor does not block either)", async () => {
  state.ctx = ctxWith({
    activity: null,
    limits: { ...LIMITS, discipline: { ...LIMITS.discipline, maxWeeklyLossAmount: null, maxConsecutiveLosses: null, cooldownAfterLossMinutes: null } },
  });
  const ov = await riskOverview(1, "PAPER");
  assert.deepEqual(ov.permissions.blockedBy, []);
  assert.equal(ov.budget.weeklyRiskUsedUnmeasured, false, "no weekly cap, so nothing unmeasured against one");
});

test("measured activity: weekly use is the measured figure", async () => {
  state.ctx = ctxWith({ activity: { ...ACTIVITY, weekRealizedPnl: -50 } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.weeklyRiskUsed, 50);
  assert.equal(ov.budget.weeklyRiskRemaining, 250);
  assert.equal(ov.budget.weeklyRiskUsedUnmeasured, false);
  assert.equal(ov.permissions.trading, true);
});

test("no active paper account: today's loss is not measured as 0", async () => {
  state.ctx = ctxWith({ account: null, daily: { realizedPnl: 0, floatingPnl: null } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskUsed, null);
  assert.equal(ov.budget.dailyRiskRemaining, null);
  assert.equal(ov.budget.dailyRiskUsedUnmeasured, true);
  assert.notEqual(ov.budget.riskStatus, "OK");
  assert.match(String(ov.budget.riskStatusReason), /no active paper account/i);
});

// With only a trade-count (or loss-streak / cooldown) cap set and no weekly
// cap, unreadable activity made blockedBy ["activity_unread"] and trading
// false — the governor refuses every order — yet riskStatus read "OK"
// (unknowns was empty because no weekly cap was set). Limits showed
// "Status OK" beside "New trades: blocked". riskStatus is now BLOCK, and
// riskStatusReason says what could not be read and which limits it stops.
test("activity unreadable with only a trade-count cap: riskStatus is BLOCK, never OK, and the reason says why", async () => {
  for (const discipline of [
    { maxTradesPerDay: 5 },
    { maxConsecutiveLosses: 3 },
    { cooldownAfterLossMinutes: 30 },
  ]) {
    state.ctx = ctxWith({
      activity: null,
      limits: { ...LIMITS, discipline: { ...LIMITS.discipline, maxWeeklyLossAmount: null, maxWeeklyLossPercent: null,
        maxTradesPerDay: null, maxConsecutiveLosses: null, cooldownAfterLossMinutes: null, ...discipline } },
    });
    const ov = await riskOverview(1, "PAPER");
    assert.deepEqual(ov.permissions.blockedBy, ["activity_unread"]);
    assert.equal(ov.permissions.trading, false);
    assert.notEqual(ov.budget.riskStatus, "OK", `${Object.keys(discipline)[0]}: not OK while new trades are blocked`);
    assert.equal(ov.budget.riskStatus, "BLOCK");
    assert.match(String(ov.budget.riskStatusReason), /trading activity could not be read/);
    assert.match(String(ov.budget.riskStatusReason), /refuses new orders/);
  }

  // With a weekly cap as well, BLOCK too (it read UNKNOWN before).
  state.ctx = ctxWith({ activity: null, limits: { ...LIMITS, discipline: { ...LIMITS.discipline, maxTradesPerDay: 5 } } });
  const both = await riskOverview(1, "PAPER");
  assert.equal(both.budget.riskStatus, "BLOCK");
  assert.match(String(both.budget.riskStatusReason), /weekly risk used is unknown/);
});
