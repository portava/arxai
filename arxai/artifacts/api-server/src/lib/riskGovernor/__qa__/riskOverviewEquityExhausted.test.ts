// Risk overview on an equity at or below 0 (round-3 review, r2-views).
//
// The Risk Governor treats a read equity at or below 0 as "every percent cap
// is used up": its per-trade rule refuses every new order ("your 1%
// per-trade limit leaves no risk for a new trade"), and its daily and weekly
// percent caps read used up. riskOverview still valued each percent cap as
// equity × pct / 100, so on the paper risk count's equity of -5,000 the 3%
// daily cap read "Daily limit $-150" (a negative limit), and with the daily
// and weekly percent caps switched off the overview read status OK and
// permissions.trading true while the governor refused every order.
//
// A percent cap on such an equity is now valued at 0 (used up, never
// negative), blockedBy names equity_exhausted, the status is BLOCK and the
// reason gives the risk-count equity with the booked equity beside it.
//
// The Risk Governor's fact loader is stubbed; the real riskOverview runs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/riskOverviewEquityExhausted.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";

const state: { ctx: Record<string, unknown> } = { ctx: {} };

const LIMITS = {
  maxLotSize: 1, maxDailyLossPercent: 3 as number | null, maxDailyLossAmount: null as number | null,
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null, maxDrawdownPercent: null,
  discipline: { maxTradesPerDay: null, maxOpenTrades: 3, maxWeeklyLossAmount: null as number | null, maxWeeklyLossPercent: null as number | null,
    maxConsecutiveLosses: null, cooldownAfterLossMinutes: null },
};
const ACTIVITY = { tradesToday: 0, weekRealizedPnl: 0, consecutiveLosses: 0, closesInLastHour: 0, reentriesAfterLossInLastHour: 0 };

function ctxWith(over: Record<string, unknown>): Record<string, unknown> {
  return {
    now: new Date("2026-10-28T12:00:00Z"), limits: LIMITS,
    // The finding's example: booked equity 395, risk-count equity -5,000
    // (one open US30 BUY, booked floating -150, counted at x100 -15,000).
    account: { equity: -5_000, bookedEquity: 395, freeMargin: -5_000, leverage: 100, currency: "USD", source: "paper_account:3" },
    instruments: {}, quote: null, positions: [], inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: null, detail: "internal paper simulator" },
    daily: { realizedPnl: 0, floatingPnl: -15_000, bookedFloatingPnl: -150 },
    halt: { engaged: false, sources: [], reason: null }, activity: ACTIVITY,
    ...over,
  };
}

mock.module("../enforce.js", { namedExports: { buildRiskContext: async () => state.ctx } });
mock.module("../riskEvents.js", { namedExports: { getOrCreateRiskSettings: async () => ({ riskPreset: null, propFirm: null }) } });

const { riskOverview } = await import("../riskProfile.js");

test("a 3% daily cap on a risk-count equity of -5,000 is used up (0), never a negative limit", async () => {
  state.ctx = ctxWith({});
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimit, 0, "a percent of an equity at or below 0 allows no loss: never -150");
  assert.ok((ov.budget.dailyRiskLimit ?? 0) >= 0);
  assert.equal(ov.budget.riskStatus, "BLOCK");
  assert.equal(ov.permissions.trading, false);
  assert.ok(ov.permissions.blockedBy.includes("equity_exhausted" as never), `blockedBy ${JSON.stringify(ov.permissions.blockedBy)}`);
  const reason = String(ov.budget.riskStatusReason);
  assert.match(reason, /paper risk count puts account equity at -\$5,000\.00/);
  assert.match(reason, /\$395\.00/, "the booked equity is named beside the risk count");
  assert.match(reason, /1% per-trade limit leaves no risk for a new trade/);
  assert.match(reason, /3% daily loss cap/);
  assert.match(reason, /Risk Governor refuses new trades/);
});

test("daily and weekly percent caps switched off: still BLOCK and not trading, as the governor's per-trade rule refuses every order", async () => {
  state.ctx = ctxWith({ limits: { ...LIMITS, maxDailyLossPercent: null, maxDailyLossAmount: null } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimit, null, "no daily cap is set");
  assert.notEqual(ov.budget.riskStatus, "OK");
  assert.equal(ov.budget.riskStatus, "BLOCK");
  assert.equal(ov.permissions.trading, false);
  assert.deepEqual(ov.permissions.blockedBy, ["equity_exhausted"]);
  assert.doesNotMatch(String(ov.budget.riskStatusReason), /daily loss cap/, "no daily cap is named when none is set");
});

test("a weekly percent cap on such an equity is used up too (0), and is named", async () => {
  state.ctx = ctxWith({ limits: { ...LIMITS, discipline: { ...LIMITS.discipline, maxWeeklyLossPercent: 5 } } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.weeklyRiskLimit, 0);
  assert.match(String(ov.budget.riskStatusReason), /5% weekly loss cap/);
});

test("an amount cap next to the percent cap: the used-up percent cap (0) is the binding one", async () => {
  state.ctx = ctxWith({ limits: { ...LIMITS, maxDailyLossAmount: 200 } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimit, 0);
});

test("equity read as exactly 0 with no booked figure beside it: named as the account's equity", async () => {
  state.ctx = ctxWith({ account: { equity: 0, freeMargin: 0, leverage: 100, currency: "USD", source: "paper_account:3" },
    daily: { realizedPnl: 0, floatingPnl: 0 } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimit, 0);
  assert.equal(ov.budget.riskStatus, "BLOCK");
  assert.ok(ov.permissions.blockedBy.includes("equity_exhausted" as never));
  assert.match(String(ov.budget.riskStatusReason), /account equity is \$0\.00, at or below zero/i);
});

test("positive equity: percent caps are valued as before and nothing is exhausted", async () => {
  state.ctx = ctxWith({ account: { equity: 10_000, freeMargin: 10_000, leverage: 100, currency: "USD", source: "paper_account:3" },
    daily: { realizedPnl: 0, floatingPnl: 0 } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.dailyRiskLimit, 300);
  assert.equal(ov.budget.riskStatus, "OK");
  assert.deepEqual(ov.permissions.blockedBy, []);
  assert.equal(ov.budget.riskStatusReason, null);
});

test("no account read: equity is unknown, not exhausted", async () => {
  state.ctx = ctxWith({ account: null, daily: { realizedPnl: 0, floatingPnl: null } });
  const ov = await riskOverview(1, "PAPER");
  assert.ok(!ov.permissions.blockedBy.includes("equity_exhausted" as never));
  assert.equal(ov.budget.dailyRiskLimitUnvalued, true);
});
