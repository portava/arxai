// Safety: a paper stop-out whose amount the venue could not size (no broker
// contract spec and not a fiat pair, e.g. NAS100 / V75 / XAUUSD for an
// ownerless Build EE order) is settled with profit_loss 0, because the column
// cannot be empty. The paper book's read side took that 0 as a measured
// result, so:
//   - sumPaperRealizedSince left the loss out of the daily total (the
//     autopilot's maxDailyPaperLoss check and the Risk Governor's daily loss
//     rule never saw it), and
//   - readPaperCloses fed pnl 0 into summarizeActivity, which treats 0 as a
//     non-loss: the losing streak reset and lastClosedWasLoss read false.
// Before contract sizing the book held move × lots × 100 for the same order,
// so the loss was counted. A loss of unknown size must still count as a loss,
// at least at the size the governor priced the order at (its paper ledger
// model, contract 100) — never as 0.
//
// Offline: the REAL monitor and read side run over in-memory db fakes.
import { beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "../../../routes/__qa__/_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });
mock.module("../../marketData/marketDataService.js", {
  namedExports: { getMarketData: async () => { throw new Error("tests force the price"); } },
});
mock.module("../../autoDebriefService.js", {
  namedExports: { runAutoDebrief: async () => ({ status: "skipped" }) },
});
const settled: Array<{ status: string; exitPrice: number; pnl: number }> = [];
mock.module("../pipeline.js", {
  namedExports: {
    settlePaperTrade: async (a: { status: string; exitPrice: number; pnl: number }) => { settled.push(a); },
    fillPaperTrade: async () => { throw new Error("not used"); },
  },
});

const { runPaperMonitor } = await import("../../paperExecution/paperExecutionMonitor.js");
const { realizedOf, readPaperCloses, sumPaperRealizedSince } = await import("../paperBookReader.js");
const { summarizeActivity } = await import("../../riskGovernor/preTrade.js");
const { PAPER_LEDGER_INSTRUMENT } = await import("../../riskGovernor/enforce.js");

const NOW = new Date();
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const BASE = {
  id: 51, userId: null as number | null, paperAccountId: 1, decisionId: null as number | null, symbol: "NAS100", direction: "BUY",
  orderType: "MARKET", lotSize: 0.5, entryPrice: 18000, stopLoss: 17950, takeProfit: 18100,
  status: "OPEN", strategyId: "build_ee_paper_execution", openedAt: minsAgo(30),
  closedAt: null as Date | null, exitPrice: null as number | null, profitLoss: 0,
};
type Order = typeof BASE;
function openOrder(over: Partial<Order> = {}): Order {
  return { ...BASE, ...over };
}

/** Run the real monitor on one order at `price` and return the row it settles. */
async function settleThroughMonitor(order: Order, price: number): Promise<Order> {
  fake = createFakeDb({ paper_orders: [order], arx_symbol_specs: [] });
  settled.length = 0;
  const s = await runPaperMonitor({ forcePrice: price });
  assert.equal(s.closed, 1);
  const w = settled[0]!;
  return { ...order, status: w.status, exitPrice: w.exitPrice, profitLoss: w.pnl, closedAt: minsAgo(1) };
}

beforeEach(() => { fake = createFakeDb({}); });

test("the monitor stores 0 for an unsized NAS100 stop-out (the placeholder this read side must see through)", async () => {
  const row = await settleThroughMonitor(openOrder(), 17940);
  assert.equal(row.status, "CLOSED_SL");
  assert.equal(row.profitLoss, 0);
});

test("realizedOf: an unsized stop-out counts as a loss at the governor's paper model size, never 0", async () => {
  const row = await settleThroughMonitor(openOrder(), 17940);
  const r = realizedOf(row);
  assert.ok(r < 0, `an unsized SL must read as a loss, got ${r}`);
  // (17950 − 18000) × 0.5 lots × the governor's paper ledger contract size.
  assert.equal(r, (17950 - 18000) * 0.5 * PAPER_LEDGER_INSTRUMENT.contractSize!);
});

test("realizedOf: an unsized target hit adds nothing (a win of unknown size never counts as money); a stored figure and a flat exit are kept as they are", async () => {
  const tp = await settleThroughMonitor(openOrder({ id: 52 }), 18110);
  // Was +5,000 ((18100 − 18000) × 0.5 × 100): an estimated win added to the risk total.
  assert.equal(realizedOf(tp), 0);
  assert.equal(realizedOf({ ...tp, profitLoss: 12.5 }), 12.5, "a sized amount is the stored amount");
  assert.equal(realizedOf({ ...tp, exitPrice: 18000, profitLoss: 0 }), 0, "a flat exit is a real breakeven");
});

test("sumPaperRealizedSince: an unsized target hit cannot cancel measured losses in the daily total (governor daily_loss_limit, autopilot maxDailyPaperLoss)", async () => {
  // Sized losses of −800 today, then an ownerless NAS100 0.5-lot target hit 200 points above entry whose amount was not sized.
  const tp = await settleThroughMonitor(openOrder({ id: 55, takeProfit: 18200 }), 18210);
  assert.equal(tp.status, "CLOSED_TP");
  assert.equal(tp.profitLoss, 0, "stored as the not-sized placeholder");
  fake = createFakeDb({ paper_orders: [tp, { ...tp, id: 56, status: "CLOSED_SL", exitPrice: 17990, profitLoss: -500 }, { ...tp, id: 57, status: "CLOSED_SL", exitPrice: 17990, profitLoss: -300 }] });
  const total = await sumPaperRealizedSince({ owner: null, strategyId: "build_ee_paper_execution" }, minsAgo(60));
  // Was −800 + 10,000 = +9,200: neither daily-loss stop could trip. The two
  // sized losses now count at no less than the paper risk model (each close at
  // the lower of its booked amount and move × lots × 100): the −300 booked at
  // 17,990 counts (17990 − 18000) × 0.5 × 100 = −500, so the total is −1,000.
  assert.equal(total, -500 + (17990 - 18000) * 0.5 * 100);
});

test("readPaperCloses → summarizeActivity: an unsized target hit ends a losing streak by its sign but adds no money to the week's P/L", async () => {
  const tp = await settleThroughMonitor(openOrder({ id: 58 }), 18110);
  fake = createFakeDb({ paper_orders: [tp, { ...tp, id: 59, status: "CLOSED_SL", exitPrice: 17990, profitLoss: -5, closedAt: minsAgo(10) }] });
  const closes = await readPaperCloses({ account: 1 }, { limit: 20 });
  // The −5 booked at 17,990 counts at the paper risk model, (17990 − 18000) × 0.5 × 100 = −500.
  assert.deepEqual(closes.map((c) => c.pnl), [0, (17990 - 18000) * 0.5 * 100]);
  const act = summarizeActivity(closes.map((c) => ({ closedAt: c.closedAt, pnl: c.pnl })), 0, NOW, "paper_orders:account:1");
  assert.equal(act.consecutiveLosses, 0, "the newest close was a win");
  assert.equal(act.lastClosedWasLoss, false);
  assert.equal(act.weekRealizedPnl, -500, "was +4,995: the estimated win offset the measured loss");
});

test("sumPaperRealizedSince: the daily total includes the unsized stop-out", async () => {
  const sl = await settleThroughMonitor(openOrder(), 17940);
  fake = createFakeDb({ paper_orders: [sl, { ...sl, id: 53, profitLoss: -40 }] });
  const total = await sumPaperRealizedSince({ owner: null, strategyId: "build_ee_paper_execution" }, minsAgo(60));
  // The −40 booked at the 17,950 stop counts at the paper risk model too (the lower figure).
  assert.equal(total, 2 * (17950 - 18000) * 0.5 * 100, "was -40: the unsized loss was dropped from the daily total");
});

test("readPaperCloses → summarizeActivity: an unsized stop-out keeps the losing streak and reads as the last loss", async () => {
  const sl = await settleThroughMonitor(openOrder(), 17940);
  // Newest first, as the read side orders them: the unsized SL, then a sized loss.
  fake = createFakeDb({ paper_orders: [sl, { ...sl, id: 54, profitLoss: -5, closedAt: minsAgo(10) }] });
  const closes = await readPaperCloses({ account: 1 }, { limit: 20 });
  const act = summarizeActivity(closes.map((c) => ({ closedAt: c.closedAt, pnl: c.pnl })), 0, NOW, "paper_orders:account:1");
  assert.equal(act.consecutiveLosses, 2, "was 0: the placeholder 0 broke the streak");
  assert.equal(act.lastClosedWasLoss, true, "was false: the post-loss cooldown never started");
});
