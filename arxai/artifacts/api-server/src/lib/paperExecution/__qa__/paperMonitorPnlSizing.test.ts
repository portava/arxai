// Regression: the Build EE paper monitor sized every symbol's P&L as
// `direction × move × lots × 100`. A 1.00-lot, 100-pip EURUSD winner read
// 1.00 (real: 1,000) and the same wrong number was booked as realized P&L on
// SL/TP settlement, feeding the paper balance and risk-governor statistics.
// P&L must use the instrument's contract size, and when that size cannot be
// established the figure is withheld (null), never guessed.
import { beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });

type Order = {
  id: number; userId: number | null; decisionId: number | null; symbol: string; direction: string;
  lotSize: number; entryPrice: number; stopLoss: number; takeProfit: number; status: string;
};
let orders: Order[] = [];
let specs: Array<{ contractSize: number | null; profitCurrency: string | null }> = [];
const settled: Array<{ pnl: number; eventMessage: string }> = [];

function rows<T>(value: T[]) {
  const p = Promise.resolve(value) as Promise<T[]> & { limit: () => Promise<T[]> };
  p.limit = async () => value;
  return p;
}
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => (table === database.paperOrdersTable ? rows(orders) : rows(specs)),
    }),
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
mock.module("../../marketData/marketDataService.js", {
  namedExports: { getMarketData: async () => { throw new Error("tests force the price"); } },
});
mock.module("../../autoDebriefService.js", {
  namedExports: { runAutoDebrief: async () => ({ status: "skipped" }) },
});
mock.module("../../tradeEngine/pipeline.js", {
  namedExports: {
    settlePaperTrade: async (a: { pnl: number; eventMessage: string }) => { settled.push(a); },
    fillPaperTrade: async () => { throw new Error("not used"); },
  },
});

const { runPaperMonitor } = await import("../paperExecutionMonitor.js");

function order(over: Partial<Order>): Order {
  return {
    id: 1, userId: 7, decisionId: null, symbol: "EURUSD", direction: "BUY",
    lotSize: 1, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.1, status: "OPEN", ...over,
  };
}

beforeEach(() => { orders = []; specs = []; settled.length = 0; });

test("EURUSD 1.00 lot, +100 pips reads 1,000 unrealized, not 1.00", async () => {
  orders = [order({})];
  const s = await runPaperMonitor({ forcePrice: 1.095 });
  assert.equal(s.updates.length, 1);
  assert.equal(s.updates[0]!.unrealizedPnl, 1000);
});

test("EURUSD TP settlement books the contract-size-aware amount", async () => {
  orders = [order({})];
  const s = await runPaperMonitor({ forcePrice: 1.1005 });
  assert.equal(s.closed, 1);
  assert.equal(s.closures[0]!.pnl, 1500);
  assert.equal(settled[0]!.pnl, 1500);
});

test("USDJPY P&L is converted from JPY to the USD paper account", async () => {
  orders = [order({ symbol: "USDJPY", entryPrice: 150, stopLoss: 149, takeProfit: 152 })];
  const s = await runPaperMonitor({ forcePrice: 151 });
  assert.equal(s.updates[0]!.unrealizedPnl, Number(((1 * 100000) / 151).toFixed(2)));
});

test("gold with no broker contract spec is withheld, not sized with a guessed ×100", async () => {
  orders = [order({ symbol: "XAUUSD", entryPrice: 2400, stopLoss: 2380, takeProfit: 2450 })];
  const s = await runPaperMonitor({ forcePrice: 2410 });
  assert.equal(s.updates[0]!.unrealizedPnl, null);
  assert.match(String(s.updates[0]!.pnlUnavailableReason), /contract size/i);
});

test("gold with a broker-reported contract size of 100 is sized from it", async () => {
  orders = [order({ symbol: "XAUUSD", entryPrice: 2400, stopLoss: 2380, takeProfit: 2450 })];
  specs = [{ contractSize: 100, profitCurrency: "USD" }];
  const s = await runPaperMonitor({ forcePrice: 2410 });
  assert.equal(s.updates[0]!.unrealizedPnl, 1000);
});

test("an SL hit with unknown sizing still closes, says the P&L was not sized, and is a LOSS", async () => {
  orders = [order({ symbol: "XAUUSD", entryPrice: 2400, stopLoss: 2380, takeProfit: 2450 })];
  const s = await runPaperMonitor({ forcePrice: 2379 });
  assert.equal(s.closed, 1);
  assert.equal(s.closures[0]!.pnl, null);
  assert.equal(s.closures[0]!.outcome, "LOSS");
  assert.match(settled[0]!.eventMessage, /not sized/i);
  assert.doesNotMatch(settled[0]!.eventMessage, /P&L 0\.00/);
});
