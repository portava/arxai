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
      activity: null, positions: [], instruments: {},
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
