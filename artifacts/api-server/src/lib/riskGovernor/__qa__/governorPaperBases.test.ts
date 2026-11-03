// Risk Governor (PAPER) — round-3 review, group r2-governor: the paper facts
// the governor loads cover what their refusals say they cover.
//
//   - the week's P/L that rule 13's weekly loss cap reads covers every close
//     of the last 7 days, not only the newest 50 (the activity read that the
//     losing streak and the cooldown use), and so does today's trade count;
//   - the drawdown rule measures each full basis against a peak on the same
//     basis (the booked equity against the peak recorded from it; the equity
//     at the paper risk model, price move × lots × 100, against that model's
//     own peak read from the closes) and names the basis that breached. It
//     no longer compares the risk-count equity (which mixes the two) with the
//     booked peak: a profitable FX account read a 10.7% "drawdown" that
//     neither basis had and was blocked for good;
//   - the booked basis values open positions at the venue's current price
//     (round-3 safety review): the stored paper equity is only as new as its
//     last revaluation, so an open loss it has not stored still counts, and
//     the booked basis is never above the stored equity;
//
// The REAL governor and fact loader run; the paper book read side is stubbed
// with a store that honours the reads' `since` and `limit` (newest close
// first), and the database, limits and stop switches are stubbed.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/riskGovernor/__qa__/governorPaperBases.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "../../../routes/__qa__/_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const { resolveEffectiveLimits } = await import("../preTrade.js");
const BASE_LIMITS = resolveEffectiveLimits({ userSettings: null, adminLimits: null });
const LIMITS = {
  ...BASE_LIMITS,
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null,
  maxDailyLossPercent: null as number | null, maxDailyLossAmount: null as number | null,
  maxDrawdownPercent: null as number | null,
  discipline: { ...BASE_LIMITS.discipline, maxWeeklyLossAmount: null as number | null, maxTradesPerDay: null as number | null },
};
const realLimitSettings = await import("../limitSettings.js");
mock.module("../limitSettings.js", {
  namedExports: { ...realLimitSettings, loadEffectiveLimits: async () => LIMITS },
});
const NO_HALT = { engaged: false, sources: [], reason: null };
const realHalt = await import("../../safety/tradingHalt.js");
mock.module("../../safety/tradingHalt.js", {
  namedExports: { ...realHalt, loadTradingHalt: async () => NO_HALT, loadBrokerControlHalt: async () => NO_HALT },
});

type Row = Record<string, unknown> & { closedAt?: Date | null };
const state: { account: Row | null; open: Row[]; closes: Row[] } = { account: null, open: [], closes: [] };
const realBook = await import("../../tradeEngine/paperBookReader.js");
const { paperRiskTotals } = await import("../../paperExecution/paperPnl.js");
const settled = (since?: Date) => state.closes
  .filter((c) => !since || (c.closedAt as Date).getTime() >= since.getTime())
  .sort((a, b) => (b.closedAt as Date).getTime() - (a.closedAt as Date).getTime());
mock.module("../../tradeEngine/paperBookReader.js", {
  namedExports: {
    ...realBook,
    readActivePaperAccount: async () => state.account,
    readOpenPaperOrders: async () => state.open,
    readPaperOrdersOpenedSince: async () => [],
    countPaperOpenedSinceStillOpen: async () => 0,
    sumPaperRealizedSince: async (_s: unknown, since: Date) => paperRiskTotals(settled(since) as never).risk,
    readPaperCloses: async (_s: unknown, opts: { since?: Date; limit?: number } = {}) => {
      const rows = settled(opts.since);
      return (opts.limit != null ? rows.slice(0, opts.limit) : rows)
        .map((o) => ({ ...o, closedAt: o.closedAt, pnl: realBook.realizedOf(o as never) }));
    },
  },
});

const { buildRiskContext, enforcePreTradeRisk, loadTradingActivity } = await import("../enforce.js");
const { getMockPrice } = await import("../../tradeEngine/paperVenue.js");

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const ACCOUNT = { id: 3, userId: 7, accountName: "Practice", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000, marginUsed: 0, isActive: 1 };
let nextId = 100;
/** A settled US30 0.1-lot order booked at the paper risk model (move × lots × 100 = the stored figure). */
const close = (points: number, closedAt: Date, over: Row = {}): Row => ({
  id: nextId++, userId: 7, paperAccountId: 3, symbol: "US30", direction: "BUY", lotSize: 0.1, orderType: "MARKET",
  status: points < 0 ? "CLOSED_SL" : "CLOSED_TP", strategyId: null, entryPrice: 40_000, exitPrice: 40_000 + points,
  profitLoss: points * 0.1 * 100, stopLoss: 39_000, takeProfit: 41_000, openedAt: new Date(closedAt.getTime() - 600_000), closedAt, ...over,
});
const intent = {
  userId: 7, venue: "PAPER" as const, origin: "manual" as const, action: "OPEN" as const,
  symbol: "EURUSD", side: "BUY" as const, lots: 0.01, entryPrice: null, stopLoss: 1.0995, takeProfit: 1.102,
};
const fxQuote = { bid: 1.1, ask: 1.1, at: NOW, source: "paper_simulator_price" };
const rule = (r: { rules: Array<{ rule: string; outcome: string; reason: string | null }> }, id: string) => r.rules.find((x) => x.rule === id)!;

// ── Finding 3: the week's P/L covers the whole week ─────────────────────────
test("the weekly loss cap reads every close of the last 7 days: 10 older −100 losses and 50 newer closes that net 0 read −1,000, not 0", async () => {
  // Oldest first: ten −100 losses six days ago, then 50 closes over the last
  // five days alternating +100 / −100 (net 0), the newest a win.
  state.closes = [
    ...Array.from({ length: 10 }, (_v, i) => close(-10, hoursAgo(6 * 24 - i))),
    ...Array.from({ length: 50 }, (_v, i) => close(i % 2 ? 10 : -10, hoursAgo(1 + 2 * (49 - i)))),
  ];
  state.account = { ...ACCOUNT, currentBalance: 9_000, equity: 9_000 };
  state.open = [];
  const act = await loadTradingActivity(7, "PAPER", { paperAccountId: 3, now: NOW });
  assert.ok(act);
  assert.equal(act.weekRealizedPnl, -1_000, `the week's P/L read only the newest 50 closes (${act.weekRealizedPnl})`);
  assert.equal(act.consecutiveLosses, 0, "the losing streak still reads the newest closes");
  assert.equal(act.lastClosedWasLoss, false);
  LIMITS.discipline.maxWeeklyLossAmount = 500;
  try {
    const res = await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW }, preview: true });
    const d = rule(res, "trading_discipline");
    assert.equal(d.outcome, "BLOCK", "a $500 weekly cap passed on a −1,000 week");
    assert.match(d.reason!, /this week's loss 1000 reached your weekly cap of 500/);
  } finally {
    LIMITS.discipline.maxWeeklyLossAmount = null;
  }
});

test("today's trade count covers every close today, not only the newest 50", async () => {
  const dayStart = new Date(NOW); dayStart.setUTCHours(0, 0, 0, 0);
  const span = NOW.getTime() - dayStart.getTime();
  state.closes = Array.from({ length: 60 }, (_v, i) => close(i % 2 ? -1 : 1, new Date(dayStart.getTime() + (span * (i + 1)) / 61)));
  state.account = { ...ACCOUNT };
  state.open = [];
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW } });
  assert.equal(ctx.activity?.tradesToday, 60, `today's trades read only the newest 50 closes (${ctx.activity?.tradesToday})`);
});

// ── Finding 1: the drawdown rule reads each basis against its own peak ──────
/** A settled EURUSD order (100,000 units per lot): `pips` × 10 × lots booked, pips × 0.01 × lots at the model. */
const fxClose = (pips: number, lots: number, closedAt: Date): Row => close(0, closedAt, {
  symbol: "EURUSD", lotSize: lots, entryPrice: 1.1, exitPrice: 1.1 + pips / 10_000,
  profitLoss: pips * 10 * lots, stopLoss: 1.09, takeProfit: 1.11,
});
/** A settled US30 order at 1 unit per lot: `points` × lots booked, points × lots × 100 at the model. */
const indexClose = (points: number, lots: number, closedAt: Date): Row => close(points, closedAt, {
  lotSize: lots, profitLoss: points * lots,
});
const peakRow = (peakEquity: number) => ({ id: 4, userId: 7, venue: "PAPER", accountKey: "paper_account:3", peakEquity, firstSeenAt: hoursAgo(300), peakAt: hoursAgo(1) });
const withDrawdownLimit = async <T>(pct: number, fn: () => Promise<T>): Promise<T> => {
  const saved = LIMITS.maxDrawdownPercent;
  LIMITS.maxDrawdownPercent = pct;
  try { return await fn(); } finally { LIMITS.maxDrawdownPercent = saved; }
};
const ddRule = async (opts: { preview?: boolean } = {}) =>
  rule(await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote: fxQuote, now: NOW }, preview: opts.preview ?? true }), "daily_loss_limit") as
    { outcome: string; reason: string | null; measured?: Record<string, unknown> };

test("the finding's case: twelve 1-lot EURUSD 10-pip wins on a $10,000 prop account (10% limit) read no drawdown on either basis, not 10.7%", async () => {
  // Booked +1,200 (equity and recorded peak 11,200); +1.2 at the model.
  state.closes = Array.from({ length: 12 }, (_v, i) => fxClose(10, 1, hoursAgo(30 - i)));
  state.account = { ...ACCOUNT, currentBalance: 11_200, equity: 11_200 };
  state.open = [];
  fake = createFakeDb({ user_equity_peaks: [peakRow(11_200)] });
  const r = await withDrawdownLimit(10, () => ddRule());
  assert.equal(r.outcome, "PASS", `blocked on a cross-basis figure: ${r.reason}`);
  assert.equal(r.measured?.["bookedDrawdownPercent"], 0);
  assert.equal(r.measured?.["modelDrawdownPercent"], 0);
  assert.equal(r.measured?.["modelEquity"], 10_001.2);
  assert.equal(r.measured?.["modelPeakEquity"], 10_001.2, "the model equity has never been higher");
  assert.equal(r.measured?.["bookedPeakEquity"], 11_200);
  assert.equal(r.measured?.["drawdownBasis"], null);
});

test("an open 1-lot EURUSD position 60 pips in profit reads no drawdown (was 5.7% against the booked peak)", async () => {
  const px = getMockPrice("EURUSD", NOW.getTime());
  state.closes = [];
  state.account = { ...ACCOUNT, currentBalance: 10_000, equity: 10_600 }; // markToMarket stored +600 floating
  state.open = [{ id: 51, userId: 7, paperAccountId: 3, status: "OPEN", orderType: "MARKET", strategyId: null, closedAt: null,
    exitPrice: null, profitLoss: 0, openedAt: hoursAgo(2), symbol: "EURUSD", direction: "BUY", lotSize: 1,
    entryPrice: px - 0.006, stopLoss: px - 0.02, takeProfit: px + 0.02 }];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_600)] });
  const r = await withDrawdownLimit(5, () => ddRule());
  assert.equal(r.outcome, "PASS", `a position only in profit blocked: ${r.reason}`);
  assert.ok(Math.abs((r.measured?.["modelEquity"] as number) - 10_000.6) < 0.01, `model equity ${r.measured?.["modelEquity"]}`);
  assert.equal(r.measured?.["modelDrawdownPercent"], 0);
  assert.equal(r.measured?.["bookedDrawdownPercent"], 0);
});

test("a drawdown on the paper risk model blocks and names that basis, with the booked equity beside it", async () => {
  // A US30 0.1-lot 50-point loss at 1 unit per lot: booked −5, −500 at the model.
  state.closes = [indexClose(-50, 0.1, hoursAgo(3))];
  state.account = { ...ACCOUNT, currentBalance: 9_995, equity: 9_995 };
  state.open = [];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_000)] });
  const r = await withDrawdownLimit(5, () => ddRule());
  assert.equal(r.outcome, "BLOCK");
  assert.equal(r.reason, "At the paper risk model (price move × lots × 100), the account's equity 9500 is 5% below its peak of 10000 on the same basis (drawdown limit 5%); the paper account shows 9995 booked. "
    + "That equity is the starting balance plus every closed paper trade and each open position at that model; its peak is the highest of the starting balance, the equity after each closed trade, and now. "
    + "New trades are blocked; closing is allowed.");
  assert.equal(r.measured?.["drawdownBasis"], "paper_risk_model");
  assert.equal(r.measured?.["bookedDrawdownPercent"], 0.05);
});

test("the booked basis still blocks on its own (never more lenient than the booked rule), and names the booked basis", async () => {
  // EURUSD 1 lot −110 pips: booked −1,100 (11% below the recorded 10,000), −1.1 at the model.
  state.closes = [fxClose(-110, 1, hoursAgo(3))];
  state.account = { ...ACCOUNT, currentBalance: 8_900, equity: 8_900 };
  state.open = [];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_000)] });
  const r = await withDrawdownLimit(10, () => ddRule());
  assert.equal(r.outcome, "BLOCK");
  assert.equal(r.reason, "The paper account's booked equity 8900 is 11% below its recorded peak of 10000 (drawdown limit 10%). New trades are blocked; closing is allowed.");
  assert.equal(r.measured?.["drawdownBasis"], "booked");
  assert.equal(r.measured?.["modelDrawdownPercent"], 0.01);
});

// ── Round-3 safety review: the booked basis values open positions at the
// venue's current price. Nothing revalues the stored paper equity before the
// governor runs (markToMarket runs after an order, on a close and on a paper
// page read), so the stored floating P&L can be older than the price.
/** An open simulator-priced EURUSD order (100,000 units per lot, 1 lot unless set). */
const fxOpen = (over: Row): Row => ({
  id: 61, userId: 7, paperAccountId: 3, status: "OPEN", orderType: "MARKET", strategyId: null, closedAt: null,
  exitPrice: null, profitLoss: 0, openedAt: hoursAgo(2), symbol: "EURUSD", direction: "BUY", lotSize: 1, ...over,
});

test("the reviewer's case: stored 9,200 against a 10,000 peak and an open 1-lot EURUSD BUY at −300 at the mark blocks on the booked basis (8,900, 11%)", async () => {
  const px = getMockPrice("EURUSD", NOW.getTime());
  // A 1-lot EURUSD −80-pip close two days ago: booked −800, −0.8 at the model.
  state.closes = [fxClose(-80, 1, hoursAgo(48))];
  // The account was last revalued before the open position moved: no floating P&L stored.
  state.account = { ...ACCOUNT, currentBalance: 9_200, equity: 9_200, updatedAt: hoursAgo(3) };
  state.open = [fxOpen({ entryPrice: px + 0.003, stopLoss: px - 0.01, takeProfit: px + 0.02 })];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_000)] });
  const r = await withDrawdownLimit(10, () => ddRule());
  assert.equal(r.outcome, "BLOCK", `an account 11% below its peak at the current price was allowed: ${JSON.stringify(r.measured)}`);
  assert.equal(r.measured?.["drawdownBasis"], "booked");
  assert.equal(r.measured?.["bookedEquity"], 8_900);
  assert.equal(r.measured?.["storedEquity"], 9_200);
  assert.equal(r.measured?.["bookedDrawdownPercent"], 11);
  assert.ok((r.measured?.["modelDrawdownPercent"] as number) < 0.02, "the model basis alone cannot see an FX loss of this size");
  assert.equal(r.reason, "The paper account's booked equity is 8900 with its open positions valued at the paper venue's current price "
    + `(booked balance 9200, open positions -300); the account stores 9200 from its last revaluation at ${hoursAgo(3).toISOString()}. `
    + "That is 11% below its recorded peak of 10000 (drawdown limit 10%). New trades are blocked; closing is allowed.");
  // The recorded peak keeps recording the stored (booked) equity, as before.
  await withDrawdownLimit(10, () => ddRule({ preview: false }));
  const peaks = fake.inserts.filter((i) => i.table === "user_equity_peaks");
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0]!.values.peakEquity, 9_200, "the recorded peak is written from the stored equity, unchanged");
});

test("an open position past its stop and not settled yet counts at its stop on the booked basis", async () => {
  const px = getMockPrice("EURUSD", NOW.getTime());
  state.closes = [fxClose(-80, 1, hoursAgo(48))];
  state.account = { ...ACCOUNT, currentBalance: 9_200, equity: 9_200 };
  // BUY 1 lot at px + 0.006 with its stop at px + 0.003: the price is past the
  // stop, so the venue settles it at the stop (−300), not at the price (−600).
  state.open = [fxOpen({ entryPrice: px + 0.006, stopLoss: px + 0.003, takeProfit: px + 0.02 })];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_000)] });
  const r = await withDrawdownLimit(10, () => ddRule());
  assert.equal(r.outcome, "BLOCK", `a crossed stop the account has not settled was dropped: ${JSON.stringify(r.measured)}`);
  assert.equal(r.measured?.["drawdownBasis"], "booked");
  assert.equal(r.measured?.["bookedEquity"], 8_900);
  assert.equal(r.reason, "The paper account's booked equity is 8900 with its open positions valued at the paper venue's current price "
    + "(booked balance 9200, open positions -300); the account stores 9200 from its last revaluation. "
    + "That is 11% below its recorded peak of 10000 (drawdown limit 10%). New trades are blocked; closing is allowed.");
});

test("the booked basis at the current price is never above the stored equity: a stored open loss stays when the price has since recovered", async () => {
  const px = getMockPrice("EURUSD", NOW.getTime());
  state.closes = [];
  // Stored floating −1,100; the position is 30 pips in profit at the mark now.
  state.account = { ...ACCOUNT, currentBalance: 10_000, equity: 8_900 };
  state.open = [fxOpen({ entryPrice: px - 0.003, stopLoss: px - 0.02, takeProfit: px + 0.02 })];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_000)] });
  const r = await withDrawdownLimit(10, () => ddRule());
  assert.equal(r.outcome, "BLOCK");
  assert.equal(r.measured?.["bookedEquity"], 8_900);
  assert.equal(r.measured?.["storedEquity"], undefined, "no stored figure is disclosed when it is the one counted");
  assert.equal(r.reason, "The paper account's booked equity 8900 is 11% below its recorded peak of 10000 (drawdown limit 10%). New trades are blocked; closing is allowed.");
});

test("the model peak is read from the closes (a past high is kept); nothing new is written and the recorded peak stays booked", async () => {
  // US30 at 1 unit per lot: +100 points on 0.1 lot (+10 booked, +1,000 model),
  // then −60 points (−6 booked, −600 model). Model: 10,000 → 11,000 → 10,400.
  const first = hoursAgo(5);
  state.closes = [indexClose(100, 0.1, first), indexClose(-60, 0.1, hoursAgo(2))];
  state.account = { ...ACCOUNT, currentBalance: 10_004, equity: 10_004 };
  state.open = [];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_010)] });
  const r = await withDrawdownLimit(5, () => ddRule());
  assert.equal(r.outcome, "BLOCK");
  assert.match(r.reason!, /^At the paper risk model \(price move × lots × 100\), the account's equity 10400 is 5\.45% below its peak of 11000 on the same basis \(drawdown limit 5%\); the paper account shows 10004 booked\./);
  assert.equal(r.measured?.["modelPeakAt"], first.toISOString());
  assert.equal(fake.inserts.filter((i) => i.table === "user_equity_peaks").length, 0, "a preview writes nothing");
  await withDrawdownLimit(5, () => ddRule({ preview: false }));
  const peaks = fake.inserts.filter((i) => i.table === "user_equity_peaks");
  assert.equal(peaks.length, 1, "no model-basis peak row is written");
  assert.equal(peaks[0]!.values.peakEquity, 10_004, "the recorded peak keeps the booked equity");
  assert.equal(peaks[0]!.values.accountKey, "paper_account:3");
});

test("an equity at or below 0 on either basis uses the limit up and says which", async () => {
  // A $400 account: a US30 1-lot 5-point loss books −5 and counts −500 at the model.
  state.closes = [indexClose(-5, 1, hoursAgo(3))];
  state.account = { ...ACCOUNT, startingBalance: 400, currentBalance: 395, equity: 395 };
  state.open = [];
  fake = createFakeDb({ user_equity_peaks: [] });
  const r = await withDrawdownLimit(50, () => ddRule());
  assert.equal(r.outcome, "BLOCK");
  assert.match(r.reason!, /^At the paper risk model \(price move × lots × 100\), the account's equity is -100, at or below zero, so your 50% drawdown limit is used up; the paper account shows 395 booked\./);
});

test("an open position with no market quote read is counted at its stop on the model basis, and the refusal says so", async () => {
  // A market-priced (Build EE) US30 BUY 0.01 lot, entry 40,300, stop 39,800:
  // −500 at the model at its stop; the order is checked with a EURUSD quote.
  state.closes = [];
  state.account = { ...ACCOUNT, currentBalance: 10_000, equity: 9_997 };
  state.open = [{ id: 52, userId: 7, paperAccountId: 3, status: "OPEN", orderType: "MARKET", strategyId: "build_ee_paper_execution",
    closedAt: null, exitPrice: null, profitLoss: 0, openedAt: hoursAgo(2), symbol: "US30", direction: "BUY", lotSize: 0.01,
    entryPrice: 40_300, stopLoss: 39_800, takeProfit: 41_000 }];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_000)] });
  const r = await withDrawdownLimit(5, () => ddRule());
  assert.equal(r.outcome, "BLOCK");
  // US30 has no contract size here, so the position counts on the booked
  // basis as markToMarket stores an unsized loss (at the model): the booked
  // equity at the current price is 9,500 too (round-3 safety review), and
  // both bases name the position counted at its stop.
  assert.equal(r.measured?.["drawdownBasis"], "booked_and_paper_risk_model");
  assert.match(r.reason!, /^The paper account's booked equity is 9500 with its open positions valued at the paper venue's current price \(booked balance 10000, open positions -500; the open US30 position is counted at its stop because no market quote for it was read with this order\); the account stores 9997 from its last revaluation\. That is 5% below its recorded peak of 10000 \(drawdown limit 5%\)\./);
  assert.match(r.reason!, /the account's equity 9500 is 5% below its peak of 10000 on the same basis \(drawdown limit 5%\)\./);
  assert.match(r.reason!, /each open position at that model; the open US30 position is counted at its stop because no market quote for it was read with this order; its peak is/);
});

test("a model-basis refusal shows the booked equity at the current price beside the stored figure when they differ", async () => {
  // A US30 0.1-lot 50-point close (booked −5, −500 at the model), and an
  // open 1-lot EURUSD BUY at −30 at the mark that the account has not stored.
  const px = getMockPrice("EURUSD", NOW.getTime());
  state.closes = [indexClose(-50, 0.1, hoursAgo(3))];
  state.account = { ...ACCOUNT, currentBalance: 9_995, equity: 9_995 };
  state.open = [fxOpen({ entryPrice: px + 0.0003, stopLoss: px - 0.01, takeProfit: px + 0.02 })];
  fake = createFakeDb({ user_equity_peaks: [peakRow(10_000)] });
  const r = await withDrawdownLimit(5, () => ddRule());
  assert.equal(r.outcome, "BLOCK");
  assert.equal(r.measured?.["drawdownBasis"], "paper_risk_model");
  assert.equal(r.measured?.["bookedEquity"], 9_965);
  assert.match(r.reason!, /^At the paper risk model \(price move × lots × 100\), the account's equity 9499\.97 is 5% below its peak of 10000 on the same basis \(drawdown limit 5%\); the paper account's booked equity is 9965 with its open positions at the current price \(it stores 9995\)\. /);
});
