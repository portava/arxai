// Prop Firm Mode status is a read model of the paper book. It used to score
// rules it had not measured:
//   - with no active paper account, equity is unknown, yet profit read $0,
//     the daily and total drawdown rules were listed as passed and the
//     challenge read ACTIVE.
//   - profit was paper equity minus the configured $100k challenge size, with
//     no challenge start: a default $10k paper account read −$90,000 and
//     FAILED, and P&L from before the challenge was counted.
//   - reaching the profit target read PASSED although minimum trading days,
//     consistency, news, weekend, lot and position rules are never evaluated.
//
// propFirmStatus / configurePropFirm run for real; their fact sources (the
// governor's context builder, the trader's settings row, the paper book
// reader, the platform halt) are mocked. No database, no broker, no network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/propFirmStatusTruth.test.ts

import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Ctx = Record<string, unknown>;
type Acct = { id: number; equity: number; currentBalance: number; startingBalance: number; updatedAt: Date };
const state: {
  ctx: Ctx; settings: Record<string, unknown>; acct: Acct | null; realized: number; realizedSince: Date[];
  written: Array<Record<string, unknown>>;
  limitsReadable: boolean;
} = { ctx: {}, settings: {}, acct: null, realized: 0, realizedSince: [], written: [], limitsReadable: true };

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
    db: {
      select: () => { throw new Error("not used"); },
      update: () => ({
        set: (v: Record<string, unknown>) => {
          state.written.push(v);
          return { where: () => ({ returning: async () => [{ userId: 1, ...v }] }) };
        },
      }),
    },
    userRiskSettingsTable: table(), userRiskEventsTable: table(),
  },
});
mock.module("../enforce.js", { namedExports: { buildRiskContext: async () => state.ctx } });
mock.module("../riskEvents.js", { namedExports: { getOrCreateRiskSettings: async () => state.settings } });
mock.module("../limitSettings.js", {
  namedExports: {
    loadEffectiveLimits: async () => { if (!state.limitsReadable) throw new Error("db down"); return LIMITS; },
  },
});
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    readActivePaperAccount: async () => state.acct,
    sumPaperRealizedSince: async (_scope: unknown, since: Date) => { state.realizedSince.push(since); return state.realized; },
  },
});
mock.module("../../safety/tradingHalt.js", {
  namedExports: { loadPlatformHalt: async () => ({ engaged: false, sources: [], reason: null }) },
});

const { propFirmStatus, configurePropFirm } = await import("../riskProfile.js");

const NOW = new Date("2026-10-28T12:00:00Z");
const MARKED = new Date("2026-10-28T11:59:00Z");
function paper(over: Partial<Acct> = {}): Acct {
  return { id: 3, equity: 10_000, currentBalance: 10_000, startingBalance: 10_000, updatedAt: MARKED, ...over };
}

test("no active paper account: nothing is measured, no rule is passed, the challenge is not ACTIVE", async () => {
  state.ctx = ctxWith({ account: null, daily: { realizedPnl: 0, floatingPnl: null } });
  state.acct = null;
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
  state.acct = null;
  state.settings = { riskPreset: null, propFirm: { enabled: false } };
  const s = await propFirmStatus(1);
  assert.equal(s.status, "OFF");
  assert.deepEqual(s.passed, []);
  assert.equal(s.profitUsd, null);
});

test("a default $10k paper account on the default $100k challenge is measured from its own start, not -$90,000 FAILED", async () => {
  state.acct = paper();
  state.realized = 0; state.realizedSince = [];
  const start = { at: "2026-10-27T09:00:00.000Z", paperAccountId: 3, equity: 10_000, equityAsOf: "2026-10-27T08:59:00.000Z" };
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 100_000, challengeStart: start } };
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.measured, true);
  assert.equal(s.profitUsd, 0);
  assert.equal(s.profitTargetProgress, 0);
  assert.equal(s.totalDrawdownRemainingUsd, 10_000);
  assert.equal(s.dailyDrawdownRemainingUsd, 5_000);
  assert.deepEqual(s.failed, []);
  assert.notEqual(s.status, "FAILED");
  assert.equal(s.startEquityUsd, 10_000);
  assert.equal(s.challengeStartedAt, start.at);
  assert.equal(s.equityAsOf, MARKED.toISOString(), "equity is the last stored mark, and says when");
  assert.ok(s.notes.some((n) => /\$100000.*\$10000/.test(n)), "the size mismatch is disclosed");
});

test("profit counts only what happened after the challenge started", async () => {
  // Since the start (no floating P/L then): one trade closed at -100 and an
  // open one floats +200, so equity is 10,400 on a 10,200 balance. A start
  // records its balance (balance-less legacy starts have their own test).
  state.acct = paper({ equity: 10_400, currentBalance: 10_200 });
  state.realized = -100; state.realizedSince = [];
  const start = { at: "2026-10-28T10:00:00.000Z", paperAccountId: 3, equity: 10_300, equityAsOf: "2026-10-28T09:59:00.000Z", balance: 10_300 };
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_300, profitTarget: 1_000, challengeStart: start } };
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.profitUsd, 100, "equity 10,400 against 10,300 at the start");
  assert.equal(s.profitTargetProgress, 10);
  assert.equal(state.realizedSince.length, 1);
  assert.equal(state.realizedSince[0]!.toISOString(), start.at, "today's drawdown starts at the challenge start, not midnight");
  assert.equal(s.dailyDrawdownSince, start.at);
  assert.equal(s.dailyDrawdownRemainingUsd, 4_900);
  assert.deepEqual(s.notes, [], "no size note when the challenge size matches the starting equity");
});

test("a challenge saved before its start was recorded is NOT_MEASURED, not scored against the default size", async () => {
  state.acct = paper();
  state.settings = { riskPreset: null, propFirm: { enabled: true } };
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.status, "NOT_MEASURED");
  assert.equal(s.profitUsd, null);
  assert.deepEqual(s.failed, []);
  assert.deepEqual(s.passed, []);
  assert.match(s.notMeasuredReason ?? "", /start was not recorded/);
  assert.match(s.notMeasuredReason ?? "", /Reset/);
});

test("a challenge started on another paper account is NOT_MEASURED", async () => {
  state.acct = paper({ id: 9 });
  state.settings = { riskPreset: null, propFirm: { enabled: true,
    challengeStart: { at: "2026-10-27T09:00:00.000Z", paperAccountId: 3, equity: 10_000, equityAsOf: "2026-10-27T08:59:00.000Z" } } };
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.status, "NOT_MEASURED");
  assert.match(s.notMeasuredReason ?? "", /#3.*#9/);
});

test("turning the challenge on records its start from the active paper account; editing keeps it; Reset restarts it", async () => {
  state.acct = paper({ equity: 10_250 });
  state.settings = { riskPreset: null, propFirm: { enabled: false } };
  state.written = [];
  const on = await configurePropFirm(1, { enabled: true });
  const first = on.config.challengeStart!;
  assert.equal(first.paperAccountId, 3);
  assert.equal(first.equity, 10_250);
  assert.equal(first.equityAsOf, MARKED.toISOString());
  assert.deepEqual((state.written.at(-1)!["propFirm"] as Record<string, unknown>)["challengeStart"], first);

  state.settings = { riskPreset: null, propFirm: on.config };
  state.acct = paper({ equity: 10_900 });
  const edited = await configurePropFirm(1, { enabled: true, profitTarget: 500 });
  assert.deepEqual(edited.config.challengeStart, first, "changing a target does not wipe progress");

  const forged = await configurePropFirm(1, { enabled: true, challengeStart: { at: "x", paperAccountId: 1, equity: 1, equityAsOf: "x" } });
  assert.deepEqual(forged.config.challengeStart, first, "a client cannot set the start");

  const reset = await configurePropFirm(1, { enabled: true }, { restart: true });
  assert.equal(reset.config.challengeStart!.equity, 10_900);
});

test("turning the challenge on with no paper account records no start, so it reads NOT_MEASURED", async () => {
  state.acct = null;
  state.settings = { riskPreset: null, propFirm: { enabled: false } };
  const on = await configurePropFirm(1, { enabled: true });
  assert.equal(on.config.challengeStart, null);
});

test("reaching the profit target on day one is TARGET_REACHED, not PASSED: the other rules are listed as not checked", async () => {
  state.limitsReadable = true;
  state.acct = paper({ equity: 10_900, currentBalance: 10_900 });
  state.realized = 900;
  const start = { at: "2026-10-28T08:00:00.000Z", paperAccountId: 3, equity: 10_000, equityAsOf: "2026-10-28T07:59:00.000Z" };
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, profitTarget: 800, challengeStart: start } };
  const s = await propFirmStatus(1, NOW);
  assert.ok(s.passed.includes("PROFIT_TARGET"));
  assert.notEqual(s.status, "PASSED");
  assert.equal(s.status, "TARGET_REACHED");
  const byRule = new Map(s.notChecked.map((r) => [r.rule, r.reason]));
  for (const rule of ["MIN_TRADING_DAYS", "CONSISTENCY", "NEWS_TRADING", "WEEKEND_HOLDING", "MAX_LOT_SIZE", "MAX_POSITIONS", "TOTAL_DD_LOWEST_EQUITY"]) {
    assert.ok(byRule.has(rule), `${rule} is listed as not checked`);
  }
  assert.ok(!byRule.has("DAILY_DD_EARLIER_DAYS"), "a challenge started today has no earlier days");
  assert.match(byRule.get("MIN_TRADING_DAYS")!, /5 days is not checked/);
  assert.match(byRule.get("MAX_LOT_SIZE")!, /Risk Governor refuses new orders above 1 lots/);
  assert.match(byRule.get("MAX_POSITIONS")!, /when 3 trades are open/);
});

test("a challenge started before today says earlier days' losses are not checked", async () => {
  state.acct = paper();
  state.realized = 0;
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000,
    challengeStart: { at: "2026-10-25T08:00:00.000Z", paperAccountId: 3, equity: 10_000, equityAsOf: "2026-10-25T07:59:00.000Z" } } };
  const s = await propFirmStatus(1, NOW);
  assert.ok(s.notChecked.some((r) => r.rule === "DAILY_DD_EARLIER_DAYS"));
});

test("allowed news / weekend trading is not listed; unreadable limits are said to be unreadable", async () => {
  state.limitsReadable = false;
  state.acct = paper();
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, newsTradingAllowed: true, weekendHoldingAllowed: true,
    challengeStart: { at: "2026-10-28T08:00:00.000Z", paperAccountId: 3, equity: 10_000, equityAsOf: "2026-10-28T07:59:00.000Z" } } };
  const s = await propFirmStatus(1, NOW);
  const rules = s.notChecked.map((r) => r.rule);
  assert.ok(!rules.includes("NEWS_TRADING"));
  assert.ok(!rules.includes("WEEKEND_HOLDING"));
  assert.match(s.notChecked.find((r) => r.rule === "MAX_LOT_SIZE")!.reason, /could not be read/);
  state.limitsReadable = true;
});

// DAILY_DD was pushed to passed ("✓ DAILY_DD", counted in "Passed rules")
// from today's loss alone, and TOTAL_DD from current equity alone, so a
// $6,000 loss on an earlier day of a $5,000-cap challenge, or a deeper dip
// earlier, still read as a passed rule. A rule partly measured is not passed:
// the part that was measured passes under its own name, the rule itself stays
// unconfirmed (its caveat in notChecked), and a breach of the measured part
// still fails the rule.
test("a challenge that spans earlier days never lists DAILY_DD or TOTAL_DD as passed", async () => {
  state.limitsReadable = true;
  state.acct = paper();
  state.realized = 0;
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000,
    challengeStart: { at: "2026-10-25T08:00:00.000Z", paperAccountId: 3, equity: 10_000, equityAsOf: "2026-10-25T07:59:00.000Z" } } };
  const s = await propFirmStatus(1, NOW);
  assert.ok(!s.passed.includes("DAILY_DD"), "only today's loss was measured");
  assert.ok(!s.passed.includes("TOTAL_DD"), "only current equity was measured");
  assert.deepEqual(s.passed, ["DAILY_DD_TODAY", "TOTAL_DD_CURRENT"]);
  const rules = s.notChecked.map((r) => r.rule);
  assert.ok(rules.includes("DAILY_DD_EARLIER_DAYS"));
  assert.ok(rules.includes("TOTAL_DD_LOWEST_EQUITY"));
  assert.match(s.notChecked.find((r) => r.rule === "DAILY_DD_EARLIER_DAYS")!.reason, /DAILY_DD is not confirmed/);
  assert.match(s.notChecked.find((r) => r.rule === "TOTAL_DD_LOWEST_EQUITY")!.reason, /TOTAL_DD is not confirmed/);
});

test("a breach of the measured part still fails the rule itself", async () => {
  state.acct = paper({ equity: 3_000, currentBalance: 3_000 });
  state.realized = -6_000;
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 6_000,
    challengeStart: { at: "2026-10-25T08:00:00.000Z", paperAccountId: 3, equity: 10_000, equityAsOf: "2026-10-25T07:59:00.000Z" } } };
  const s = await propFirmStatus(1, NOW);
  assert.deepEqual(s.failed, ["DAILY_DD", "TOTAL_DD"]);
  assert.deepEqual(s.passed, []);
  assert.equal(s.status, "FAILED");
});

test("a challenge started today: today's loss is all of DAILY_DD, so DAILY_DD can pass; TOTAL_DD still cannot", async () => {
  state.acct = paper();
  state.realized = 0;
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000,
    challengeStart: { at: "2026-10-28T08:00:00.000Z", paperAccountId: 3, equity: 10_000, equityAsOf: "2026-10-28T07:59:00.000Z" } } };
  const s = await propFirmStatus(1, NOW);
  assert.deepEqual(s.passed, ["DAILY_DD", "TOTAL_DD_CURRENT"]);
});

// A floating loss already open when the challenge starts (Reset with a losing
// paper position) is in the start equity. It was counted again as today's
// drawdown: -$4,000 floating at the start read "Daily DD left $1000" and
// WARNING with nothing lost since the start, and -$5,000 read FAILED at once.
// The start now records the balance next to the equity, and on the start day
// only floating loss beyond the floating loss at the start counts.
test("Reset records the paper balance next to the equity at the start", async () => {
  state.acct = paper({ equity: 6_000, currentBalance: 10_000 });
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, challengeStart: null } };
  state.written = [];
  const reset = await configurePropFirm(1, { enabled: true }, { restart: true });
  assert.equal(reset.config.challengeStart!.equity, 6_000);
  assert.equal(reset.config.challengeStart!.balance, 10_000);
  assert.deepEqual((state.written.at(-1)!["propFirm"] as Record<string, unknown>)["challengeStart"], reset.config.challengeStart);
});

test("a floating loss already open at the challenge start is not today's drawdown", async () => {
  state.limitsReadable = true;
  state.realized = 0;
  const startAt = { at: "2026-10-28T08:00:00.000Z", paperAccountId: 3, equityAsOf: "2026-10-28T07:59:00.000Z" };
  for (const floatingAtStart of [-4_000, -5_000]) {
    state.acct = paper({ equity: 10_000 + floatingAtStart, currentBalance: 10_000 });
    state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 10_000,
      challengeStart: { ...startAt, equity: 10_000 + floatingAtStart, balance: 10_000 } } };
    const s = await propFirmStatus(1, NOW);
    assert.equal(s.profitUsd, 0);
    assert.equal(s.dailyDrawdownRemainingUsd, 5_000, `floating ${floatingAtStart} at the start is not a loss since the start`);
    assert.equal(s.status, "ACTIVE");
    assert.deepEqual(s.failed, []);
  }
});

test("on the start day, only loss beyond the start's floating loss counts; a close at the same loss is no new loss", async () => {
  const startAt = { at: "2026-10-28T08:00:00.000Z", paperAccountId: 3, equityAsOf: "2026-10-28T07:59:00.000Z" };
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 10_000,
    challengeStart: { ...startAt, equity: 6_000, balance: 10_000 } } };
  // Floating worsens from -4,000 to -5,500: 1,500 lost today.
  state.realized = 0;
  state.acct = paper({ equity: 4_500, currentBalance: 10_000 });
  let s = await propFirmStatus(1, NOW);
  assert.equal(s.dailyDrawdownRemainingUsd, 3_500);
  // The position closes at -4,000: settled, but nothing new was lost.
  state.realized = -4_000;
  state.acct = paper({ equity: 6_000, currentBalance: 6_000 });
  s = await propFirmStatus(1, NOW);
  assert.equal(s.dailyDrawdownRemainingUsd, 5_000);
  assert.equal(s.status, "ACTIVE");
});

test("a start recorded without its balance is measured from the start equity on the start day", async () => {
  state.realized = 0;
  state.acct = paper({ equity: 6_000, currentBalance: 10_000 });
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 10_000,
    challengeStart: { at: "2026-10-28T08:00:00.000Z", paperAccountId: 3, equity: 6_000, equityAsOf: "2026-10-28T07:59:00.000Z" } } };
  let s = await propFirmStatus(1, NOW);
  assert.equal(s.dailyDrawdownRemainingUsd, 5_000);
  assert.equal(s.status, "ACTIVE");
  state.acct = paper({ equity: 5_000, currentBalance: 10_000 });
  s = await propFirmStatus(1, NOW);
  assert.equal(s.dailyDrawdownRemainingUsd, 4_000);
});

test("on later days the current floating loss still counts toward today's drawdown", async () => {
  state.realized = 0;
  state.acct = paper({ equity: 6_000, currentBalance: 10_000 });
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 10_000,
    challengeStart: { at: "2026-10-25T08:00:00.000Z", paperAccountId: 3, equity: 6_000, equityAsOf: "2026-10-25T07:59:00.000Z", balance: 10_000 } } };
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.dailyDrawdownRemainingUsd, 1_000);
});

// Reset with a floating GAIN open (balance 10,000, equity 13,000). The same
// day the winner closes at +3,000 and another trade loses 6,000 settled:
// equity is 7,000, 6,000 below the start, above the 5,000 daily cap. The
// start-day formula only discounted a floating LOSS at the start, so the
// settled -3,000 net read as a 3,000 drawdown, "Daily DD left $2000", DAILY_DD
// passed and ACTIVE — next to "the loss since the challenge started".
test("on the start day a floating gain open at the start and given back counts: the drawdown is at least the fall in equity since the start", async () => {
  state.limitsReadable = true;
  const startAt = { at: "2026-10-28T08:00:00.000Z", paperAccountId: 3, equityAsOf: "2026-10-28T07:59:00.000Z" };
  state.settings = { riskPreset: null, propFirm: { enabled: true, startingBalance: 10_000, maxDailyDrawdownUsd: 5_000, maxTotalDrawdownUsd: 10_000,
    challengeStart: { ...startAt, equity: 13_000, balance: 10_000 } } };
  state.realized = 3_000 - 6_000;
  state.acct = paper({ equity: 7_000, currentBalance: 7_000 });
  const s = await propFirmStatus(1, NOW);
  assert.equal(s.dailyDrawdownSince, startAt.at, "measured from the start on the start day");
  assert.equal(s.dailyDrawdownRemainingUsd, -1_000, "6,000 lost since the start against a 5,000 cap");
  assert.ok(s.failed.includes("DAILY_DD"));
  assert.ok(!s.passed.includes("DAILY_DD"));
  assert.equal(s.status, "FAILED");

  // Gain still open but smaller: the 2,000 it gave back is today's drawdown.
  state.realized = 0;
  state.acct = paper({ equity: 11_000, currentBalance: 10_000 });
  const open = await propFirmStatus(1, NOW);
  assert.equal(open.dailyDrawdownRemainingUsd, 3_000);
});
