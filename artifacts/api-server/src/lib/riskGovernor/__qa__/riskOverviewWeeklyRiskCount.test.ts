// Risk overview: the week's paper risk count is named beside the booked
// figure (round-3 review, r2-views).
//
// The Risk Governor's weekly P/L (activity.weekRealizedPnl) is the paper
// risk count: the lower of the week's booked total and its total at the
// paper risk model (price move × lots × 100), with the booked total carried
// as activity.bookedWeekRealizedPnl when it is higher. riskOverview showed
// the risk count as "Weekly used" and its riskCountNote read only today's
// realized, the open positions and the equity. Example (the finding's):
// earlier weeks hold three US30 (1 unit per lot) 0.1-lot wins, booked +5 and
// model +500 each; this week holds two losses, booked -5 and model -500 each.
// Over every close the model total is at or above the booked total, so the
// equity is not lowered; nothing closed today and nothing is open. With a
// $500 weekly amount cap the overview read "Weekly used $1000", BLOCK and
// "weekly loss limit is reached" with riskCountNote null, while the paper
// account showed a week of -$10. The governor's own weekly refusal names the
// booked -10; the overview now does too.
//
// The Risk Governor's fact loader is stubbed; the real riskOverview and
// paperRiskCountNote run.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/riskOverviewWeeklyRiskCount.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";

const state: { ctx: Record<string, unknown> } = { ctx: {} };

const LIMITS = {
  maxLotSize: 1, maxDailyLossPercent: null, maxDailyLossAmount: null, maxRiskPerTradePercent: 1,
  maxRiskPerTradeAmount: null, maxDrawdownPercent: null,
  discipline: { maxTradesPerDay: null, maxOpenTrades: 3, maxWeeklyLossAmount: 500, maxWeeklyLossPercent: null,
    maxConsecutiveLosses: null, cooldownAfterLossMinutes: null },
};
const ACTIVITY = { tradesToday: 0, weekRealizedPnl: -1_000, bookedWeekRealizedPnl: -10, consecutiveLosses: 2,
  closesInLastHour: 0, reentriesAfterLossInLastHour: 0 };

function ctxWith(over: Record<string, unknown>): Record<string, unknown> {
  return {
    now: new Date("2026-10-28T12:00:00Z"), limits: LIMITS,
    account: { equity: 10_005, freeMargin: 10_005, leverage: 100, currency: "USD", source: "paper_account:3" },
    instruments: {}, quote: null, positions: [], inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: null, detail: "internal paper simulator" },
    daily: { realizedPnl: 0, floatingPnl: 0 }, halt: { engaged: false, sources: [], reason: null }, activity: ACTIVITY,
    ...over,
  };
}

mock.module("../enforce.js", { namedExports: { buildRiskContext: async () => state.ctx } });
mock.module("../riskEvents.js", { namedExports: { getOrCreateRiskSettings: async () => ({ riskPreset: null, propFirm: null }) } });

const { riskOverview, paperRiskCountNote, riskCountNoteFor } = await import("../riskProfile.js");

test("the week's risk count used against the weekly cap is named beside the week's booked P&L", async () => {
  state.ctx = ctxWith({});
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.weeklyRiskUsed, 1_000);
  assert.equal(ov.budget.riskStatus, "BLOCK");
  assert.deepEqual(ov.permissions.blockedBy, ["weekly_loss_limit"]);
  const note = ov.budget.riskCountNote;
  assert.notEqual(note, null, "a weekly figure that differs from the booked one is never shown unlabelled");
  assert.match(String(note), /this week's \(the last 7 days'\) realized paper P&L is counted as -\$1,000\.00 \(booked -\$10\.00\)/);
  assert.match(String(note), /lower of two totals over the same trades/);
  assert.doesNotMatch(String(note), /today's realized/, "today's figures agree, so they are not restated");
});

test("no weekly difference: no weekly part in the note (null when nothing differs)", async () => {
  state.ctx = ctxWith({ activity: { ...ACTIVITY, weekRealizedPnl: -10, bookedWeekRealizedPnl: undefined } });
  const ov = await riskOverview(1, "PAPER");
  assert.equal(ov.budget.riskCountNote, null);
});

test("the note joins the week with today's figures when both differ", () => {
  const note = paperRiskCountNote({
    daily: { realizedPnl: -500, bookedRealizedPnl: -5, floatingPnl: 0 },
    account: { equity: 10_000, freeMargin: 10_000, leverage: 100, currency: "USD", source: "paper_account:3" },
    activity: ACTIVITY,
  } as never);
  assert.match(String(note), /today's realized paper P&L is counted as -\$500\.00 \(booked -\$5\.00\), and this week's \(the last 7 days'\) realized paper P&L is counted as -\$1,000\.00 \(booked -\$10\.00\)/);
});

test("callers that pass no activity are unchanged", () => {
  const note = paperRiskCountNote({
    daily: { realizedPnl: 0, floatingPnl: 0 },
    account: { equity: 10_000, freeMargin: 10_000, leverage: 100, currency: "USD", source: "paper_account:3" },
  } as never);
  assert.equal(note, null);
});

// Fourth safety review (s4-governor): when the newest closes within the week
// lost more than the whole week (activity.weekNewestCloses), the figure
// counted and its booked figure are the newest closes' own, not the last 7
// days'. The note says so for each figure.
test("when the newest closes are counted, the note labels both figures as theirs, never as the last 7 days'", () => {
  // 60 closes this week: the whole week booked +100 (risk count +50); the
  // newest 50 booked −900 and count −1,200 at the paper risk model.
  const activity = {
    ...ACTIVITY, weekRealizedPnl: -1_200, bookedWeekRealizedPnl: -900, allWeekRealizedPnl: 50,
    weekNewestCloses: { counted: 50, since: new Date("2026-10-23T08:00:00Z"), ofTotal: 60 },
  };
  const note = riskCountNoteFor({
    daily: { realizedPnl: 0, floatingPnl: 0 },
    account: { equity: 10_000, freeMargin: 10_000, leverage: 100, currency: "USD", source: "paper_account:3" },
    activity,
  } as never);
  assert.doesNotMatch(String(note), /the last 7 days'\) realized paper P&L is counted as -\$1,200\.00 \(booked -\$900\.00\)/,
    "the newest closes' booked −900 read as the last 7 days' booked P&L");
  assert.match(String(note), /your newest 50 of this week's 60 closes are counted as -\$1,200\.00 \(those closes booked -\$900\.00\)/);
  assert.match(String(note), /For your weekly loss caps this week's realized P&L is counted as -\$1,200\.00, from your newest 50 of this week's 60 closes \(since 2026-10-23T08:00:00\.000Z\), because they lost more than all of this week's closes, which net \$50\.00\./);
});
