// Execution safety (round-3 review, p2-exec): since the paper venue books
// contract-sized USD P&L, a paper close on a symbol whose broker contract is
// smaller than 100 units (an index at 1 unit per lot) books a smaller loss
// than the figure every paper close was counted at before (16c8a1a0: price
// move × lots × 100), and a currency-pair win books 1,000× more. The paper
// book's read side fed the booked figures straight into the Risk Governor's
// daily loss total and weekly P/L, the autopilot's daily stop, trader
// readiness and the equity every percent cap is valued on, so those checks
// tripped later than they did at 16c8a1a0.
//
// Risk inputs now count each close at the lower of its booked amount and the
// paper risk model (paperBookReader.realizedOf), and the governor values its
// caps on the booked equity lowered by the same difference. The booked
// figures stay the P&L and balance shown. This proves, against the real code:
//   - per close, the risk count is never above the booked amount nor the
//     16c8a1a0 figure (a sweep over sized, placeholder and legacy rows);
//   - the daily total, the losing streak and the governor's equity read the
//     conservative figure, and a daily loss that 16c8a1a0 blocked is blocked
//     again (dbefac1c let it through);
//   - the equity high-water mark still records the booked equity, so the
//     drawdown rule never reads a smaller drawdown than before;
//   - the risk overview says, with both figures, when the count differs.
//
// Offline: the REAL read side and governor run over an in-memory db fake.
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/tradeEngine/__qa__/paperRiskCountStrictness.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "../../../routes/__qa__/_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const { resolveEffectiveLimits, summarizeActivity } = await import("../../riskGovernor/preTrade.js");
const LIMITS = {
  ...resolveEffectiveLimits({ userSettings: null, adminLimits: null }),
  maxRiskPerTradePercent: 1, maxRiskPerTradeAmount: null,
  maxDailyLossPercent: 5, maxDailyLossAmount: null, maxDrawdownPercent: null,
};
const realLimitSettings = await import("../../riskGovernor/limitSettings.js");
mock.module("../../riskGovernor/limitSettings.js", {
  namedExports: { ...realLimitSettings, loadEffectiveLimits: async () => LIMITS },
});
const NO_HALT = { engaged: false, sources: [], reason: null };
const realHalt = await import("../../safety/tradingHalt.js");
mock.module("../../safety/tradingHalt.js", {
  namedExports: { ...realHalt, loadTradingHalt: async () => NO_HALT, loadBrokerControlHalt: async () => NO_HALT },
});
// The fake ignores WHERE, so the fixture's paper_orders are the settled
// orders only; the open-order reads return none.
const realBook = await import("../paperBookReader.js");
mock.module("../paperBookReader.js", {
  namedExports: {
    ...realBook,
    readOpenPaperOrders: async () => [],
    readPaperOrdersOpenedSince: async () => [],
    countPaperOpenedSinceStillOpen: async () => 0,
  },
});

const { realizedOf, bookedRealizedOf, sumPaperRealizedSince, readPaperCloses } = realBook;
const { paperLedgerModelPnl } = await import("../../paperExecution/paperPnl.js");
const { buildRiskContext, enforcePreTradeRisk } = await import("../../riskGovernor/enforce.js");
const { paperRiskCountNote } = await import("../../riskGovernor/riskProfile.js");

const NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
/** The figure 16c8a1a0 counted a paper close at: move × lots × 100 (the paper risk model). */
const at16c8a1a0 = (o: { direction: string; lotSize: number; entryPrice: number; exitPrice: number }) =>
  paperLedgerModelPnl(o.direction, o.lotSize, o.entryPrice, o.exitPrice);

const order = (over: Record<string, unknown>) => ({
  id: 1, userId: 7, paperAccountId: 3, orderType: "MARKET", status: "CLOSED_SL", strategyId: null,
  tradePlanId: null, decisionId: null, clientRequestKey: null, openedAt: minsAgo(30), closedAt: minsAgo(5),
  createdAt: minsAgo(30), updatedAt: minsAgo(5), stopLoss: 0, takeProfit: 0, ...over,
});
// US30 at a broker contract of 1 unit per lot: a 50-point loss on 0.1 lots books −5; the model counts −500.
const INDEX_LOSS = order({ id: 11, symbol: "US30", direction: "BUY", lotSize: 0.1, entryPrice: 40_000, exitPrice: 39_950, profitLoss: -5 });
// EURUSD at 100,000 units: a 10-pip win on 1 lot books +100; the model counts +0.1.
const FX_WIN = order({ id: 12, symbol: "EURUSD", direction: "BUY", lotSize: 1, entryPrice: 1.1, exitPrice: 1.101, profitLoss: 100, status: "CLOSED_TP", closedAt: minsAgo(4) });

test("per close: the risk count is never above the booked amount nor the 16c8a1a0 figure (sweep)", () => {
  const dirs = ["BUY", "SELL"];
  const lots = [0.01, 0.1, 1, 5];
  const moves = [-0.5, -0.01, -0.0001, 0, 0.0001, 0.01, 0.5];
  // Booked amount as a multiple of the model: contract 1 (0.01×), 100 (1×), 100,000 (1000×), and the 0 placeholder.
  const scales = [0.01, 1, 1000, 0];
  let n = 0;
  for (const direction of dirs) for (const lotSize of lots) for (const mv of moves) for (const k of scales) {
    const entryPrice = 100;
    const exitPrice = entryPrice + mv;
    const model = at16c8a1a0({ direction, lotSize, entryPrice, exitPrice });
    const row = { direction, lotSize, entryPrice, exitPrice, profitLoss: Number((model * k).toFixed(2)) };
    const risk = realizedOf(row);
    assert.ok(risk <= bookedRealizedOf(row) + 1e-9, `risk ${risk} above booked ${bookedRealizedOf(row)} (${JSON.stringify(row)})`);
    assert.ok(risk <= model + 1e-9, `risk ${risk} above the 16c8a1a0 figure ${model} (${JSON.stringify(row)})`);
    // The sign of a sized close is the sign of its move, so a streak reads the same as before.
    if (row.profitLoss !== 0) assert.equal(Math.sign(risk), Math.sign(row.profitLoss));
    n++;
  }
  assert.equal(n, 2 * 4 * 7 * 4);
  // A row with no exit price keeps its stored figure (16c8a1a0 read the same).
  assert.equal(realizedOf({ direction: "BUY", lotSize: 1, entryPrice: 1, exitPrice: null, profitLoss: -3 }), -3);
});

test("an index close with a small booked loss still counts at the 16c8a1a0 figure in the daily-loss total; the booked figure is unchanged", async () => {
  assert.equal(bookedRealizedOf(INDEX_LOSS as never), -5, "the P&L shown and the balance stay the booked −5");
  assert.equal(realizedOf(INDEX_LOSS as never), at16c8a1a0(INDEX_LOSS as never), "counts −500, as at 16c8a1a0");
  assert.equal(realizedOf(FX_WIN as never), at16c8a1a0(FX_WIN as never), "a win booked above the model counts only at the model");
  fake = createFakeDb({ paper_orders: [INDEX_LOSS, FX_WIN] });
  const total = await sumPaperRealizedSince({ account: 3 }, minsAgo(60));
  assert.ok(Math.abs(total - (-500 + (1.101 - 1.1) * 100)) < 1e-9, `daily total ${total}`);
  assert.ok(total <= -5 + 100, "never above the booked total (dbefac1c)");
  assert.ok(total <= at16c8a1a0(INDEX_LOSS as never) + at16c8a1a0(FX_WIN as never) + 1e-9, "never above the 16c8a1a0 total");
});

test("the losing streak and the week's P/L read the risk count (streak by sign, unchanged)", async () => {
  fake = createFakeDb({ paper_orders: [INDEX_LOSS, { ...INDEX_LOSS, id: 13, closedAt: minsAgo(10) }] });
  const closes = await readPaperCloses({ account: 3 }, { limit: 20 });
  const act = summarizeActivity(closes.map((c) => ({ closedAt: c.closedAt, pnl: c.pnl })), 0, NOW, "paper_orders:account:3");
  assert.equal(act.consecutiveLosses, 2);
  assert.equal(act.lastClosedWasLoss, true);
  assert.equal(act.weekRealizedPnl, -1000, "was −10 booked: each close counts at the −500 model");
});

const ACCOUNT = { id: 3, userId: 7, accountName: "Practice", startingBalance: 10_000, currentBalance: 10_095, equity: 10_095, marginUsed: 0, isActive: 1, createdAt: minsAgo(600), updatedAt: minsAgo(1) };
const intent = {
  userId: 7, venue: "PAPER" as const, origin: "manual" as const, action: "OPEN" as const,
  symbol: "EURUSD", side: "BUY" as const, lots: 0.01, entryPrice: null, stopLoss: 1.0995, takeProfit: 1.102,
};
const quote = { bid: 1.1, ask: 1.1, at: NOW, source: "paper_simulator_price" };

test("governor: the daily total and the equity every cap is valued on use the risk count; booked figures ride along", async () => {
  fake = createFakeDb({ paper_accounts: [ACCOUNT], paper_orders: [INDEX_LOSS, FX_WIN] });
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote, now: NOW } });
  const shortfall = (-500 - -5) + ((1.101 - 1.1) * 100 - 100);
  assert.ok(Math.abs(ctx.daily.realizedPnl! - (-500 + (1.101 - 1.1) * 100)) < 1e-9);
  assert.ok(Math.abs(ctx.daily.bookedRealizedPnl! - 95) < 1e-9, "today's booked P/L is disclosed beside the count");
  assert.ok(Math.abs(ctx.account!.equity! - (10_095 + shortfall)) < 1e-9, `equity ${ctx.account!.equity}`);
  assert.equal(ctx.account!.bookedEquity, 10_095);
  assert.ok(Math.abs(ctx.account!.freeMargin! - (10_095 + shortfall)) < 1e-9);
  // 16c8a1a0's equity for the same closes: start + Σ move × lots × 100.
  const equity16 = 10_000 + at16c8a1a0(INDEX_LOSS as never) + at16c8a1a0(FX_WIN as never);
  assert.ok(ctx.account!.equity! <= equity16 + 1e-9, "never above the 16c8a1a0 equity");
  assert.ok(ctx.account!.equity! <= ACCOUNT.equity, "never above the booked equity (dbefac1c)");
  assert.equal(ctx.daily.floatingPnl, 0, "floating P/L stays the stored equity − balance");
});

test("governor: a day 16c8a1a0 blocked at the daily loss limit is blocked again (dbefac1c let it through); the peak records the booked equity", async () => {
  fake = createFakeDb({ paper_accounts: [ACCOUNT], paper_orders: [INDEX_LOSS, FX_WIN] });
  const res = await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote, now: NOW } });
  // 5% of the 9,500.10 risk-count equity is 475.01 against a 499.90 loss count;
  // the booked figures (+95 today, 10,095 equity) read no loss at all.
  assert.ok(res.blockedBy.includes("daily_loss_limit"), JSON.stringify(res.rules.filter((r) => r.outcome === "BLOCK")));
  assert.equal(res.allowed, false);
  const peaks = fake.inserts.filter((i) => i.table === "user_equity_peaks");
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0]!.values.peakEquity, 10_095, "the high-water mark keeps the booked equity, so the drawdown from it is never smaller");
});

test("governor: with no difference between booked and risk count, nothing extra is set", async () => {
  // Closes booked at the model (the pre-contract-sizing figures, or a 100-unit contract).
  const legacy = { ...INDEX_LOSS, profitLoss: -500 };
  fake = createFakeDb({ paper_accounts: [{ ...ACCOUNT, currentBalance: 9_500, equity: 9_500 }], paper_orders: [legacy] });
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote, now: NOW } });
  assert.equal(ctx.account!.equity, 9_500);
  assert.equal(ctx.account!.bookedEquity, undefined);
  assert.equal(ctx.daily.bookedRealizedPnl, undefined);
  assert.equal(paperRiskCountNote(ctx), null);
});

test("risk overview: the note says both figures in plain words when the count differs", async () => {
  fake = createFakeDb({ paper_accounts: [ACCOUNT], paper_orders: [INDEX_LOSS, FX_WIN] });
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote, now: NOW } });
  const note = paperRiskCountNote(ctx)!;
  assert.match(note, /today's realized paper P&L is counted as -\$499\.90 \(booked \$95\.00\)/);
  assert.match(note, /equity is counted as \$9,500\.10 \(the paper account shows \$10,095\.00\)/);
  assert.match(note, /lower of its booked P&L and the paper risk model \(price move × lots × 100\)/);
});
