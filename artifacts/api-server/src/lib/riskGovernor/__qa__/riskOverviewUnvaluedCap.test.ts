// Regression: with a percent daily-loss cap (the default 3%), no amount cap
// and unknown equity (no account read), riskOverview dropped the percent cap,
// so dailyRiskLimit, dailyRiskRemaining and equity were all null and
// riskStatus fell through to "OK". The Risk Command Center then showed
// "none set" for the limit, the risk left and the equity, under a green OK.
// A cap that is set but cannot be valued, and unknown equity, are now
// reported as such, and the status is not OK.
//
// The Risk Governor's fact loader is stubbed; the real riskOverview runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/riskOverviewUnvaluedCap.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";

type Facts = {
  maxDailyLossPercent: number | null; maxDailyLossAmount: number | null;
  maxWeeklyLossPercent?: number | null; maxWeeklyLossAmount?: number | null;
  equity: number | null; realizedPnl?: number | null;
  activity?: { weekRealizedPnl: number } | null;
};
let facts: Facts = { maxDailyLossPercent: 3, maxDailyLossAmount: null, equity: null };

mock.module("../enforce.js", {
  namedExports: {
    buildRiskContext: async () => ({
      limits: {
        maxDailyLossPercent: facts.maxDailyLossPercent, maxDailyLossAmount: facts.maxDailyLossAmount,
        discipline: { maxWeeklyLossAmount: facts.maxWeeklyLossAmount ?? null, maxWeeklyLossPercent: facts.maxWeeklyLossPercent ?? null },
      },
      account: facts.equity == null ? null : { equity: facts.equity },
      daily: { realizedPnl: facts.realizedPnl === undefined ? 0 : facts.realizedPnl, floatingPnl: null },
      activity: facts.activity ?? null, positions: [], instruments: {},
      halt: { engaged: false, sources: [], reason: null },
    }),
  },
});
mock.module("../riskEvents.js", { namedExports: { getOrCreateRiskSettings: async () => ({ riskPreset: null, propFirm: null }) } });

const { riskOverview } = await import("../riskProfile.js");

test("a 3% daily cap with unknown equity is 'set but not valued', equity is unknown, and status is not OK", async () => {
  facts = { maxDailyLossPercent: 3, maxDailyLossAmount: null, equity: null };
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimit, null);
  assert.equal(ov.budget.dailyRiskLimitUnvalued, true);
  assert.equal(ov.budget.equityKnown, false);
  assert.notEqual(ov.budget.riskStatus, "OK");
  assert.equal(ov.budget.riskStatus, "UNKNOWN");
  assert.match(String(ov.budget.riskStatusReason), /equity is unknown/i);
  assert.match(String(ov.budget.riskStatusReason), /3%/);
});

test("an amount cap plus an unvalued percent cap: the amount is shown, but it may not be the binding cap", async () => {
  facts = { maxDailyLossPercent: 3, maxDailyLossAmount: 200, equity: null };
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimit, 200);
  assert.equal(ov.budget.dailyRiskLimitUnvalued, true);
  assert.equal(ov.budget.riskStatus, "UNKNOWN");
});

test("unknown realized P/L with a cap set is not OK", async () => {
  facts = { maxDailyLossPercent: null, maxDailyLossAmount: 200, equity: 10_000, realizedPnl: null };
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.riskStatus, "UNKNOWN");
  assert.match(String(ov.budget.riskStatusReason), /realized P\/L/i);
});

test("with equity known the percent cap is valued and status is OK", async () => {
  facts = { maxDailyLossPercent: 3, maxDailyLossAmount: null, equity: 10_000 };
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimit, 300);
  assert.equal(ov.budget.dailyRiskLimitUnvalued, false);
  assert.equal(ov.budget.equityKnown, true);
  assert.equal(ov.budget.riskStatus, "OK");
  assert.equal(ov.budget.riskStatusReason, null);
});

test("no daily or weekly cap configured at all is not 'unvalued'", async () => {
  facts = { maxDailyLossPercent: null, maxDailyLossAmount: null, equity: null };
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimitUnvalued, false);
  assert.equal(ov.budget.weeklyRiskLimitUnvalued, false);
  assert.equal(ov.budget.equityKnown, false);
});

// Truth: with a weekly cap set (every preset sets one) and no activity facts,
// the reason said weekly risk used was unknown, yet the budget still sent
// weeklyRiskUsed 0 and weeklyRiskRemaining = the full cap, so the page showed
// "Weekly used $0" and "Weekly risk left $500" under that reason. With no
// active paper account the reason also said the activity "could not be read",
// although nothing failed: there is no paper book. The budget now says which
// "used" figures are measured, and why not.
test("weekly activity that could not be read: weekly used is flagged unknown with that reason", async () => {
  facts = { maxDailyLossPercent: null, maxDailyLossAmount: 150, maxWeeklyLossAmount: 500, equity: 10_000, activity: null };
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.weeklyRiskUsedKnown, false);
  assert.equal(ov.budget.weeklyRiskUsedUnknownReason, "this week's trading activity could not be read");
  assert.equal(ov.budget.dailyRiskUsedKnown, true);
  assert.equal(ov.budget.dailyRiskUsedUnknownReason, null);
  assert.equal(ov.budget.riskStatus, "UNKNOWN");
  assert.match(String(ov.budget.riskStatusReason), /this week's trading activity could not be read/i);
});

test("no active paper account: daily and weekly used are not measured, and the reason says there is no account", async () => {
  facts = { maxDailyLossPercent: null, maxDailyLossAmount: 150, maxWeeklyLossAmount: 500, equity: null, activity: null };
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.weeklyRiskUsedKnown, false);
  assert.equal(ov.budget.dailyRiskUsedKnown, false);
  assert.equal(ov.budget.weeklyRiskUsedUnknownReason, "there is no active paper account");
  assert.equal(ov.budget.dailyRiskUsedUnknownReason, "there is no active paper account");
  assert.doesNotMatch(String(ov.budget.riskStatusReason), /could not be read/);
  assert.match(String(ov.budget.riskStatusReason), /no active paper account/i);
  assert.equal(ov.budget.riskStatus, "UNKNOWN");
});

test("measured weekly activity: weekly used is known and counted", async () => {
  facts = { maxDailyLossPercent: null, maxDailyLossAmount: 150, maxWeeklyLossAmount: 500, equity: 10_000, activity: { weekRealizedPnl: -120 } };
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.weeklyRiskUsedKnown, true);
  assert.equal(ov.budget.weeklyRiskUsed, 120);
  assert.equal(ov.budget.weeklyRiskRemaining, 380);
  assert.equal(ov.budget.riskStatus, "OK");
});
