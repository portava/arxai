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
// Round-3 safety review (s-exec): 59a05de6 then counted EACH CLOSE at the
// lower of its booked amount and the model and added those up. That takes
// every win at the smaller figure and every loss at the larger one, so the
// sum fell below BOTH totals and kept falling (80 US30 wins and 20 losses:
// booked equity 10,030, all-×100 equity 13,000, risk equity 9,040), and the
// refusals then misstated the account ("equity is unknown" once it passed 0,
// a drawdown from the booked peak with no word of the count).
//
// Risk inputs now take the LOWER OF TWO FULL TOTALS over the same closes
// (paperPnl.paperRiskTotals): the booked total and the ×100 model total. The
// governor values its caps on the booked equity lowered by
// min(0, model total − booked total). The booked figures stay the P&L and
// balance shown. This proves, against the real code:
//   - over any set of closes, the risk count is never above the booked total
//     nor the 16c8a1a0 total, and equals the lower of them (a sweep over
//     sized, placeholder and legacy rows), so it never drifts below both;
//   - the daily total, the week's P/L and the governor's equity read that
//     count, a daily loss that 16c8a1a0 blocked is blocked again (dbefac1c
//     let it through), and the losing streak still reads each close's sign;
//   - a risk-count equity at or below 0 is refused with the paper risk count
//     and the booked equity named, never as "equity is unknown"; the drawdown
//     and daily-loss refusals say they read the risk count, with the booked
//     figures;
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
const { paperLedgerModelPnl, paperRiskTotals } = await import("../../paperExecution/paperPnl.js");
const { buildRiskContext, enforcePreTradeRisk, loadTradingActivity } = await import("../../riskGovernor/enforce.js");
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
const ACCOUNT = { id: 3, userId: 7, accountName: "Practice", startingBalance: 10_000, currentBalance: 10_095, equity: 10_095, marginUsed: 0, isActive: 1, createdAt: minsAgo(600), updatedAt: minsAgo(1) };
const intent = {
  userId: 7, venue: "PAPER" as const, origin: "manual" as const, action: "OPEN" as const,
  symbol: "EURUSD", side: "BUY" as const, lots: 0.01, entryPrice: null, stopLoss: 1.0995, takeProfit: 1.102,
};
const quote = { bid: 1.1, ask: 1.1, at: NOW, source: "paper_simulator_price" };

test("over any set of closes: the risk count is the lower of the booked total and the 16c8a1a0 total, never above either (sweep)", () => {
  const dirs = ["BUY", "SELL"];
  const lots = [0.01, 0.1, 1, 5];
  const moves = [-0.5, -0.01, -0.0001, 0, 0.0001, 0.01, 0.5];
  // Booked amount as a multiple of the model: contract 1 (0.01×), 100 (1×), 100,000 (1000×), and the 0 placeholder.
  const scales = [0.01, 1, 1000, 0];
  const rows: Array<{ direction: string; lotSize: number; entryPrice: number; exitPrice: number; profitLoss: number }> = [];
  for (const direction of dirs) for (const lotSize of lots) for (const mv of moves) for (const k of scales) {
    const entryPrice = 100;
    const exitPrice = entryPrice + mv;
    const model = at16c8a1a0({ direction, lotSize, entryPrice, exitPrice });
    rows.push({ direction, lotSize, entryPrice, exitPrice, profitLoss: Number((model * k).toFixed(2)) });
  }
  assert.equal(rows.length, 2 * 4 * 7 * 4);
  // Every close alone (a total over one close), every pair, and running prefixes of the whole sweep.
  const sets: Array<typeof rows> = [
    ...rows.map((r) => [r]),
    ...rows.flatMap((a, i) => rows.slice(i + 1, i + 9).map((b) => [a, b])),
    ...rows.map((_r, i) => rows.slice(0, i + 1)),
  ];
  for (const set of sets) {
    const booked = set.reduce((t, o) => t + bookedRealizedOf(o), 0);
    const model = set.reduce((t, o) => t + at16c8a1a0(o), 0);
    const risk = paperRiskTotals(set).risk;
    assert.ok(risk <= booked + 1e-9, `risk ${risk} above the booked total ${booked}`);
    assert.ok(risk <= model + 1e-9, `risk ${risk} above the 16c8a1a0 total ${model}`);
    assert.ok(Math.abs(risk - Math.min(booked, model)) < 1e-9, `risk ${risk} is not the lower total (${booked}, ${model}): it drifted below both`);
  }
  for (const row of rows) {
    // One close's count is the same rule over one close; its sign is the sign of
    // the move, so a losing streak reads the same as before.
    const risk = realizedOf(row);
    assert.ok(Math.abs(risk - paperRiskTotals([row]).risk) < 1e-12);
    if (row.profitLoss !== 0) assert.equal(Math.sign(risk), Math.sign(row.profitLoss));
  }
  // A row with no exit price keeps its stored figure on both bases (16c8a1a0 read the same).
  assert.equal(realizedOf({ direction: "BUY", lotSize: 1, entryPrice: 1, exitPrice: null, profitLoss: -3 }), -3);
  assert.deepEqual(paperRiskTotals([{ direction: "BUY", lotSize: 1, entryPrice: 1, exitPrice: null, profitLoss: -3 }]), { booked: -3, model: -3, risk: -3 });
});

test("an index close with a small booked loss still counts at the 16c8a1a0 total in the daily-loss total; the booked figure is unchanged", async () => {
  assert.equal(bookedRealizedOf(INDEX_LOSS as never), -5, "the P&L shown and the balance stay the booked −5");
  assert.equal(realizedOf(INDEX_LOSS as never), at16c8a1a0(INDEX_LOSS as never), "alone it counts −500, as at 16c8a1a0");
  assert.equal(realizedOf(FX_WIN as never), at16c8a1a0(FX_WIN as never), "a win booked above the model counts only at the model");
  fake = createFakeDb({ paper_orders: [INDEX_LOSS, FX_WIN] });
  const total = await sumPaperRealizedSince({ account: 3 }, minsAgo(60));
  const booked = -5 + 100;
  const model16 = at16c8a1a0(INDEX_LOSS as never) + at16c8a1a0(FX_WIN as never);
  assert.ok(Math.abs(total - Math.min(booked, model16)) < 1e-9, `daily total ${total} is the lower total`);
  assert.ok(Math.abs(total - (-500 + (1.101 - 1.1) * 100)) < 1e-9, `daily total ${total}`);
  assert.ok(total <= booked, "never above the booked total (dbefac1c)");
  assert.ok(total <= model16 + 1e-9, "never above the 16c8a1a0 total");
});

test("the losing streak reads each close's sign; the governor's week P/L is the lower total, with the booked total beside it", async () => {
  fake = createFakeDb({ paper_orders: [INDEX_LOSS, { ...INDEX_LOSS, id: 13, closedAt: minsAgo(10) }] });
  const closes = await readPaperCloses({ account: 3 }, { limit: 20 });
  const act = summarizeActivity(closes.map((c) => ({ closedAt: c.closedAt, pnl: c.pnl })), 0, NOW, "paper_orders:account:3");
  assert.equal(act.consecutiveLosses, 2);
  assert.equal(act.lastClosedWasLoss, true);
  // The governor's own activity facts (rule 13's weekly cap).
  fake = createFakeDb({ paper_accounts: [ACCOUNT], paper_orders: [INDEX_LOSS, { ...INDEX_LOSS, id: 13, closedAt: minsAgo(10) }] });
  const gov = await loadTradingActivity(7, "PAPER", { paperAccountId: 3, now: NOW });
  assert.ok(gov);
  assert.equal(gov.consecutiveLosses, 2);
  assert.equal(gov.weekRealizedPnl, -1000, "was −10 booked: the week's 16c8a1a0 total (−1,000) is the lower total");
  assert.equal(gov.bookedWeekRealizedPnl, -10, "the booked week rides along");
});

test("no drift: 80 small index wins and 20 losses count at the lower total, not below both (was 9,040)", async () => {
  // US30 at a broker contract of 1 unit per lot, 0.01 lot, 50-point stop and
  // target: each win books +0.50 (model +50), each loss −0.50 (model −50).
  const closes = Array.from({ length: 100 }, (_v, i) => order({
    id: 100 + i, symbol: "US30", direction: "BUY", lotSize: 0.01, entryPrice: 40_000,
    exitPrice: i < 80 ? 40_050 : 39_950, profitLoss: i < 80 ? 0.5 : -0.5,
    status: i < 80 ? "CLOSED_TP" : "CLOSED_SL", closedAt: minsAgo(5 + i / 10),
  }));
  const booked = { ...ACCOUNT, currentBalance: 10_030, equity: 10_030 };
  fake = createFakeDb({ paper_accounts: [booked], paper_orders: closes });
  const ctx = await buildRiskContext({ ...intent, symbol: "US30", stopLoss: 39_900, takeProfit: 40_100 },
    { paperAccountId: 3, facts: { quote: { bid: 40_000, ask: 40_000, at: NOW, source: "paper_simulator_price" }, now: NOW } });
  const equity16 = 10_000 + closes.reduce((t, c) => t + at16c8a1a0(c as never), 0);
  assert.ok(Math.abs(equity16 - 13_000) < 1e-6);
  assert.ok(Math.abs(ctx.account!.equity! - 10_030) < 1e-6, `risk equity ${ctx.account!.equity} (was 9,040: below both)`);
  assert.ok(ctx.account!.equity! <= 10_030 && ctx.account!.equity! <= equity16, "never above either basis");
  assert.equal(ctx.account!.bookedEquity, undefined, "no difference from the booked equity to disclose");
  assert.ok(Math.abs(ctx.daily.realizedPnl! - 30) < 1e-6, `today's count ${ctx.daily.realizedPnl} (was −960)`);
});

test("no drift the other way: currency-pair wins and losses of the same size net to the lower total (0), not −999", async () => {
  // EURUSD at 100,000 units, 1 lot, 10 pips: each win books +100 (model +0.1), each loss −100 (model −0.1).
  const closes = Array.from({ length: 20 }, (_v, i) => order({
    id: 300 + i, symbol: "EURUSD", direction: "BUY", lotSize: 1, entryPrice: 1.1,
    exitPrice: i % 2 ? 1.101 : 1.099, profitLoss: i % 2 ? 100 : -100, closedAt: minsAgo(5 + i / 10),
  }));
  assert.ok(Math.abs(closes.reduce((t, c) => t + realizedOf(c as never), 0) - -999) < 1e-6, "the per-close sum this replaces");
  fake = createFakeDb({ paper_accounts: [{ ...ACCOUNT, currentBalance: 10_000, equity: 10_000 }], paper_orders: closes });
  const ctx = await buildRiskContext(intent, { paperAccountId: 3, facts: { quote, now: NOW } });
  assert.ok(Math.abs(ctx.daily.realizedPnl!) < 1e-6, `today's count ${ctx.daily.realizedPnl}`);
  assert.ok(Math.abs(ctx.account!.equity! - 10_000) < 1e-6, `risk equity ${ctx.account!.equity}`);
});

test("a risk-count equity at or below 0 is refused with the paper risk count and the booked equity named, never 'equity is unknown'", async () => {
  // A 395 account whose −5 index loss counts −500 at the model: risk equity 395 − 495 = −100.
  fake = createFakeDb({ paper_accounts: [{ ...ACCOUNT, startingBalance: 400, currentBalance: 395, equity: 395 }], paper_orders: [INDEX_LOSS] });
  const res = await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote, now: NOW } });
  assert.equal(res.allowed, false);
  const reasons = res.rules.filter((r) => r.outcome === "BLOCK").map((r) => r.reason ?? "");
  for (const r of reasons) assert.doesNotMatch(r, /equity is unknown/i, r);
  assert.match(res.primaryReason!, /paper risk count puts account equity at -100, at or below zero \(the paper account shows 395 booked/);
  const perTrade = res.rules.find((r) => r.rule === "per_trade_loss_limit")!;
  assert.equal(perTrade.outcome, "BLOCK");
  assert.match(perTrade.reason!, /paper risk count .*-100.*395 booked.*per-trade limit leaves no risk/);
  const daily = res.rules.find((r) => r.rule === "daily_loss_limit")!;
  assert.equal(daily.outcome, "BLOCK", "the 5% daily cap of a non-positive equity is used up, not unchecked");
  assert.match(daily.reason!, /daily loss cap is used up/);
  for (const id of ["max_portfolio_exposure", "leverage", "concentration"]) {
    assert.match(res.rules.find((r) => r.rule === id)!.reason!, /paper risk count puts account equity at -100/, id);
  }
});

test("the drawdown refusal says it compares the risk-count equity with the peak recorded from the booked equity, and shows the booked equity", async () => {
  const saved = { daily: LIMITS.maxDailyLossPercent, dd: LIMITS.maxDrawdownPercent };
  LIMITS.maxDailyLossPercent = null as never;
  LIMITS.maxDrawdownPercent = 5 as never;
  try {
    fake = createFakeDb({
      paper_accounts: [ACCOUNT], paper_orders: [INDEX_LOSS, FX_WIN],
      user_equity_peaks: [{ id: 4, peakEquity: 10_095, firstSeenAt: minsAgo(600) }],
    });
    const res = await enforcePreTradeRisk(intent, { paperAccountId: 3, facts: { quote, now: NOW } });
    const dd = res.rules.find((r) => r.rule === "daily_loss_limit")!;
    assert.equal(dd.outcome, "BLOCK");
    // 9,500.10 is 5.89% below 10,095.
    assert.match(dd.reason!, /^Paper risk-count equity 9500\.1 is 5\.89% below its peak equity of 10095 \(drawdown limit 5%\)/);
    assert.match(dd.reason!, /peak is recorded from the booked equity, and the paper account shows 10095 booked/);
    assert.equal(dd.measured?.["bookedEquity"], 10_095);
  } finally {
    LIMITS.maxDailyLossPercent = saved.daily;
    LIMITS.maxDrawdownPercent = saved.dd;
  }
});


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
  // The refusal says it is the paper risk count and names the booked figures.
  const daily = res.rules.find((r) => r.rule === "daily_loss_limit")!.reason!;
  assert.match(daily, /^Daily loss 5\.26% reached the 5% cap\./);
  assert.match(daily, /This is the paper risk count: today's closed trades count -499\.9 \(booked 95\), and equity counts 9500\.1 \(the paper account shows 10095 booked\)/);
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
  assert.match(note, /lower of two totals over the same trades, their booked P&L and the paper risk model \(price move × lots × 100\)/);
  assert.doesNotMatch(note, /each closed paper trade at the lower/, "the per-close rule this replaced");
});
