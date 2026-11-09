// Prop status daily drawdown against the Risk Governor's paper risk count
// (round-3 review, r2-views).
//
// propFirmStatus took today's settled P/L from the paper risk count (the
// lower of the booked and price move × lots × 100 totals) but the floating
// P/L from the stored, contract-sized figure (equity − balance). Since
// 682cce47 the governor's daily loss rule counts each open position at the
// lower of its sized and ×100 value, and prop mode writes the challenge's
// daily drawdown in as the daily loss cap. The finding's example ($250 cap):
// nothing closed today, one open US30 BUY at 1 unit per lot, 0.01 lot, 300
// points down. The governor counts -300 and refuses every order ("Daily loss
// 300 reached the 250 cap"); the prop status counted 3, passed
// DAILY_DD_TODAY, showed $247 left and read ACTIVE, with no word on which
// basis each part used.
//
// Today's drawdown is now taken on both bases over the same closes and open
// positions (the booked figures, and the governor's paper risk count via the
// read-only open-position valuation), DAILY_DD fails on either, and a note
// names the basis with both figures.
//
// The REAL governor, prop status, mark and sizing run; the database, the
// paper book read side, the broker contract specs, the trader's settings,
// limits and stop switches are stubbed. No network, no writes.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/propFirmStatusRiskCount.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "../../../routes/__qa__/_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({});
const writes: string[] = [];
const dbProxy = new Proxy({}, {
  get: (_t, p) => {
    if (p === "update" || p === "insert") return (...a: unknown[]) => { writes.push(String(p)); return (fake.db[p] as (...x: unknown[]) => unknown)(...a); };
    return (fake.db as Record<string | symbol, unknown>)[p];
  },
});
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

// US30 at 1 unit per lot (the broker contract the finding uses).
const realContract = await import("../../mt5/contractSize.js");
mock.module("../../mt5/contractSize.js", {
  namedExports: {
    ...realContract,
    resolveContractSize: async (_userId: number, symbol: string) => realContract.decideContractSize({
      symbol, brokerContractSize: symbol === "US30" ? 1 : null, brokerProfitCurrency: symbol === "US30" ? "USD" : null,
    }),
  },
});

// Prop mode writes the challenge's daily drawdown in as the daily loss cap.
const { resolveEffectiveLimits } = await import("../preTrade.js");
const LIMITS = {
  ...resolveEffectiveLimits({ userSettings: null, adminLimits: null }),
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null,
  maxDailyLossPercent: null, maxDailyLossAmount: 250, maxDrawdownPercent: null,
};
const realLimitSettings = await import("../limitSettings.js");
mock.module("../limitSettings.js", { namedExports: { ...realLimitSettings, loadEffectiveLimits: async () => LIMITS } });
const NO_HALT = { engaged: false, sources: [], reason: null };
const realHalt = await import("../../safety/tradingHalt.js");
mock.module("../../safety/tradingHalt.js", {
  namedExports: { ...realHalt, loadTradingHalt: async () => NO_HALT, loadBrokerControlHalt: async () => NO_HALT, loadPlatformHalt: async () => NO_HALT },
});

type Row = Record<string, unknown>;
const state: { account: Row; open: Row[]; closes: Row[]; settings: Row } = { account: {}, open: [], closes: [], settings: {} };
const { paperRiskTotals } = await import("../../paperExecution/paperRiskCount.js");
const realBook = await import("../../tradeEngine/paperBookReader.js");
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    ...realBook,
    readActivePaperAccount: async () => state.account,
    readOpenPaperOrders: async () => state.open,
    readPaperOrdersOpenedSince: async () => [],
    sumPaperRealizedSince: async () => paperRiskTotals(state.closes as never).risk,
    readPaperCloses: async () => state.closes,
    countPaperOpenedSinceStillOpen: async () => 0,
  },
});
const realRiskEvents = await import("../riskEvents.js");
mock.module("../riskEvents.js", { namedExports: { ...realRiskEvents, getOrCreateRiskSettings: async () => state.settings } });

const { enforcePreTradeRisk } = await import("../enforce.js");
const { propFirmStatus } = await import("../riskProfile.js");
const { tradingDayStart } = await import("../preTrade.js");
const { getMockPrice } = await import("../../tradeEngine/paperVenue.js");

const NOW = new Date();
const account = (equity: number, balance = 10_000) => ({
  id: 3, userId: 7, accountName: "Practice", startingBalance: 10_000, currentBalance: balance, equity, marginUsed: 0, isActive: 1,
  updatedAt: new Date(NOW.getTime() - 60_000),
});
const openOrder = (over: Row): Row => ({
  id: 41, userId: 7, paperAccountId: 3, status: "OPEN", orderType: "MARKET", strategyId: null, closedAt: null,
  exitPrice: null, profitLoss: 0, openedAt: new Date(NOW.getTime() - 3_600_000), ...over,
});
// A challenge started before today, on this account, with $10,000.
const startAt = new Date(tradingDayStart(NOW).getTime() - 12 * 3_600_000).toISOString();
const settings = (over: Row = {}) => ({
  riskPreset: "PROP_FIRM_CHALLENGE",
  propFirm: { enabled: true, startingBalance: 10_000, profitTarget: 800, maxDailyDrawdownUsd: 250, maxTotalDrawdownUsd: 1_000,
    challengeStart: { at: startAt, paperAccountId: 3, equity: 10_000, equityAsOf: startAt, balance: 10_000 }, ...over },
});
const intent = {
  userId: 7, venue: "PAPER" as const, origin: "manual" as const, action: "OPEN" as const,
  symbol: "EURUSD", side: "BUY" as const, lots: 0.01, entryPrice: null, stopLoss: 1.0995, takeProfit: 1.102,
};
const fxQuote = { bid: 1.1, ask: 1.1, at: NOW, source: "paper_simulator_price" };

// A simulator-priced US30 BUY 0.01 lot, 300 points down at the simulator's price now.
const usPx = getMockPrice("US30", NOW.getTime());
const US30_DOWN_300 = openOrder({ symbol: "US30", direction: "BUY", lotSize: 0.01, entryPrice: usPx + 300, stopLoss: usPx - 500, takeProfit: usPx + 1_000 });

test("the finding's case: the governor refuses on the $250 daily cap, and the prop status fails DAILY_DD on the same count, naming the basis", async () => {
  state.account = account(10_000 - 3); // markToMarket stored the sized -3
  state.open = [US30_DOWN_300];
  state.closes = [];
  state.settings = settings();
  writes.length = 0;

  const res = await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW }, preview: true });
  const daily = res.rules.find((r) => r.rule === "daily_loss_limit")!;
  assert.equal(daily.outcome, "BLOCK");
  assert.match(daily.reason!, /^Daily loss 300 reached the 250 cap\./);

  const s = await propFirmStatus(7, NOW);
  assert.ok(s.failed.includes("DAILY_DD"), `failed ${JSON.stringify(s.failed)}; passed ${JSON.stringify(s.passed)}`);
  assert.ok(!s.passed.includes("DAILY_DD_TODAY"), "never passed while the governor refuses on the same cap");
  assert.equal(s.status, "FAILED");
  assert.notEqual(s.status, "ACTIVE");
  assert.equal(s.dailyDrawdownRemainingUsd, -50, "250 - 300, never $247");
  assert.equal(s.dailyDrawdownUsd, 300);
  assert.equal(s.dailyDrawdownBookedUsd, 3);
  assert.equal(s.dailyDrawdownRiskCountUsd, 300);
  assert.equal(s.dailyDrawdownBasis, "paper_risk_count");
  const note = s.notes.find((n) => /paper risk count/.test(n));
  assert.ok(note, `a note names the basis: ${JSON.stringify(s.notes)}`);
  assert.match(note!, /Today's drawdown is \$300\.00 on the paper risk count, the figure the Risk Governor's daily loss cap reads, and \$3\.00 on the paper account's booked figures/);
  assert.match(note!, /open positions count -\$300\.00 \(the paper account shows -\$3\.00 floating\)/);
  assert.equal(s.equityUsd, 9_997, "the shown equity stays the booked figure");
  assert.deepEqual(writes, [], "read-only: nothing is written");
});

test("a close settled today at a lower risk count than booked counts too", async () => {
  // One US30 close today: booked -3 (1 unit per lot), ×100 -300.
  state.account = account(10_000 - 3, 10_000 - 3);
  state.open = [];
  state.closes = [{ id: 40, userId: 7, paperAccountId: 3, symbol: "US30", direction: "BUY", lotSize: 0.01, entryPrice: 40_300, exitPrice: 40_000,
    profitLoss: -3, status: "CLOSED_SL", closedAt: new Date(NOW.getTime() - 60_000), pnl: -300 }];
  state.settings = settings();
  const s = await propFirmStatus(7, NOW);
  assert.ok(s.failed.includes("DAILY_DD"));
  assert.equal(s.dailyDrawdownBasis, "paper_risk_count");
  assert.match(s.notes.join(" "), /the paper trades closed since then count -\$300\.00 \(booked -\$3\.00\)/);
});

test("both bases agree: booked basis, no basis note, and DAILY_DD_TODAY passes under the cap", async () => {
  state.account = account(10_000 - 100, 10_000 - 100);
  state.open = [];
  // Booked at the ×100 model (a 100-unit contract): both totals are -100.
  state.closes = [{ id: 39, userId: 7, paperAccountId: 3, symbol: "XAUUSD", direction: "BUY", lotSize: 0.1, entryPrice: 2_010, exitPrice: 2_000,
    profitLoss: -100, status: "CLOSED_SL", closedAt: new Date(NOW.getTime() - 60_000), pnl: -100 }];
  state.settings = settings();
  const s = await propFirmStatus(7, NOW);
  assert.equal(s.dailyDrawdownBasis, "booked");
  assert.equal(s.dailyDrawdownUsd, 100);
  assert.equal(s.dailyDrawdownRemainingUsd, 150);
  assert.ok(s.passed.includes("DAILY_DD_TODAY"));
  assert.ok(!s.notes.some((n) => /paper risk count/.test(n)));
});

// On the challenge's start day the loss counts from the start. With nothing
// open at the start the risk count since the start is measured exactly.
const startToday = new Date(Math.max(tradingDayStart(NOW).getTime(), NOW.getTime() - 60_000)).toISOString();
test("start day, nothing open at the start: a position opened since counts on the risk count and fails DAILY_DD", async () => {
  state.account = account(10_000 - 3);
  state.open = [US30_DOWN_300];
  state.closes = [];
  state.settings = settings({ challengeStart: { at: startToday, paperAccountId: 3, equity: 10_000, equityAsOf: startToday, balance: 10_000 } });
  const s = await propFirmStatus(7, NOW);
  assert.equal(s.dailyDrawdownSince, startToday);
  assert.ok(s.failed.includes("DAILY_DD"));
  assert.equal(s.dailyDrawdownUsd, 300);
  assert.equal(s.dailyDrawdownBasis, "paper_risk_count");
  assert.equal(s.dailyDrawdownMeasured, true);
});

// With a position open at the start, the start recorded only its booked
// P&L, so the risk count's loss since the start is only bounded: never a
// FAILED on that bound alone, never a pass either.
test("start day, the position was already open at the start: the risk count is only bounded, so DAILY_DD is not confirmed (not failed, not passed)", async () => {
  state.account = account(10_000 - 3);
  state.open = [US30_DOWN_300];
  state.closes = [];
  state.settings = settings({ challengeStart: { at: startToday, paperAccountId: 3, equity: 10_000 - 3, equityAsOf: startToday, balance: 10_000 } });
  const s = await propFirmStatus(7, NOW);
  assert.ok(!s.failed.includes("DAILY_DD"), "a bound is not a measured breach");
  assert.ok(!s.passed.includes("DAILY_DD"));
  assert.notEqual(s.status, "FAILED");
  assert.deepEqual(s.notEvaluated, ["DAILY_DD"]);
  assert.equal(s.dailyDrawdownMeasured, false);
  assert.equal(s.dailyDrawdownRemainingUsd, null);
  assert.equal(s.dailyDrawdownUsd, null);
  assert.equal(s.dailyDrawdownBookedUsd, 0);
  assert.match(s.notEvaluatedReasons["DAILY_DD"]!, /at most \$297\.00 there, and \$0\.00 on the paper account's booked figures, against the \$250\.00 cap/);
  assert.ok(s.notChecked.some((r) => r.rule === "DAILY_DD"));
});

test("not measured: the basis fields are null, not a figure", async () => {
  state.account = account(10_000);
  state.settings = settings({ challengeStart: null });
  const s = await propFirmStatus(7, NOW);
  assert.equal(s.measured, false);
  assert.equal(s.dailyDrawdownUsd, null);
  assert.equal(s.dailyDrawdownBasis, null);
});

// Round-3 safety review (s3-views): the bound above is the most the risk
// count's drop since the start can be (the start recorded booked floating
// P&L, which is never below the risk count's). DAILY_DD stayed "not
// confirmed" (notEvaluated, notChecked, Daily DD left NOT MEASURED) even when
// that bound was under the cap, which proves the rule passes on both bases;
// the reason printed "at most $X ... against the $Y cap. DAILY_DD is not
// confirmed." with X far under Y. A bound under the cap now passes DAILY_DD,
// says so, and reports the remaining room as a lower bound.
test("start day, the position was already open at the start, the bound is under the cap: DAILY_DD passes, the remaining room is at least cap - bound", async () => {
  state.account = account(10_000 - 3);
  state.open = [US30_DOWN_300];
  state.closes = [];
  state.settings = settings({
    maxDailyDrawdownUsd: 1_000,
    challengeStart: { at: startToday, paperAccountId: 3, equity: 10_000 - 3, equityAsOf: startToday, balance: 10_000 },
  });
  const s = await propFirmStatus(7, NOW);
  assert.ok(s.passed.includes("DAILY_DD"), `passed ${JSON.stringify(s.passed)}; not evaluated ${JSON.stringify(s.notEvaluated)}`);
  assert.ok(!s.failed.includes("DAILY_DD"));
  assert.deepEqual(s.notEvaluated, [], "was ['DAILY_DD'] although the bound is under the cap");
  assert.ok(!s.notChecked.some((r) => r.rule === "DAILY_DD"));
  assert.deepEqual(s.notEvaluatedReasons, {});
  // The exact figure is still only bounded: not reported as measured.
  assert.equal(s.dailyDrawdownMeasured, false);
  assert.equal(s.dailyDrawdownUsd, null);
  assert.equal(s.dailyDrawdownRemainingUsd, null);
  assert.equal(s.dailyDrawdownRemainingAtLeastUsd, 703, "1,000 - 297");
  assert.equal(s.status, "ACTIVE");
  const note = s.notes.find((n) => /at most/.test(n));
  assert.ok(note, JSON.stringify(s.notes));
  assert.match(note!, /it is at most \$297\.00 there, and \$0\.00 on the paper account's booked figures, against the \$1,000\.00 cap\. Both are under the cap, so DAILY_DD passes\./);
  assert.doesNotMatch(note!, /not confirmed/);
});

test("the bound reaching the cap still leaves DAILY_DD not confirmed, with no lower bound on the room left", async () => {
  state.account = account(10_000 - 3);
  state.open = [US30_DOWN_300];
  state.closes = [];
  state.settings = settings({ challengeStart: { at: startToday, paperAccountId: 3, equity: 10_000 - 3, equityAsOf: startToday, balance: 10_000 } });
  const s = await propFirmStatus(7, NOW);
  assert.deepEqual(s.notEvaluated, ["DAILY_DD"]);
  assert.equal(s.dailyDrawdownRemainingAtLeastUsd, null);
});
