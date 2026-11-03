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
  state.acct = paper({ equity: 10_400, currentBalance: 10_400 });
  state.realized = -100; state.realizedSince = [];
  const start = { at: "2026-10-28T10:00:00.000Z", paperAccountId: 3, equity: 10_300, equityAsOf: "2026-10-28T09:59:00.000Z" };
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
