// Demo Trading Sandbox: the paper account's Equity, "P&L vs start" and Margin
// came from markToMarket with nothing saying how. An order opened from the
// ticket (no market quote) is valued at getMockPrice — a synthetic price from
// the deterministic candle generator — and its stop/target settle against it.
// P&L is price move × lots × 100 for every symbol and margin is lots × 1,000,
// neither the instrument's contract size nor a broker margin. The only label
// was "Simulated", which reads as simulated orders, not simulated prices.
// markToMarket now returns, with the account, where its prices came from and
// the units its figures are in.
//
// The database, quote feed, Risk Governor and auto-debrief are stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/tradeEngine/__qa__/paperValuationDisclosure.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";

const database = await import("@workspace/db");
const ACCOUNT = {
  id: 5, userId: 44, accountName: "Practice", startingBalance: 10_000, currentBalance: 10_000,
  equity: 10_000, marginUsed: 0, isActive: 1, createdAt: new Date(), updatedAt: new Date(),
};
// markToMarket reads paper_orders twice: the open orders, then every order
// (it filters the closed ones itself). The stub ignores where-clauses, so it
// answers the first read with the OPEN rows only.
const state: { orders: Array<Record<string, unknown>>; ordersReads: number } = { orders: [], ordersReads: 0 };

function chain(rows: () => unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.orderBy = self; q.limit = self; q.returning = self;
  q.then = (ok: (v: unknown[]) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve().then(rows).then(ok, bad);
  q.catch = (bad: (e: unknown) => unknown) => Promise.resolve().then(rows).catch(bad);
  return q;
}
const fakeDb = {
  select: () => ({
    from: (table: Table) => chain(() => {
      const name = getTableName(table);
      if (name === "paper_accounts") return [ACCOUNT];
      if (name === "paper_orders") {
        state.ordersReads++;
        return state.ordersReads % 2 === 1 ? state.orders.filter((o) => o.status === "OPEN") : state.orders;
      }
      return [];
    }),
  }),
  update: () => ({ set: () => chain(() => []) }),
  insert: () => ({ values: () => chain(() => []) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
mock.module("../../autoDebriefService.js", { namedExports: { runAutoDebrief: async () => ({}) } });
mock.module("../../riskGovernor/enforce.js", { namedExports: { enforcePreTradeRisk: async () => ({ allowed: true, blockedBy: [] }) } });
mock.module("../marketQuote.js", {
  namedExports: { currentQuote: async () => ({ ok: true, bid: 1.2, ask: 1.2002, at: new Date(), source: "qa-stub" }) },
});

const { markToMarket, pnlFor, MARKET_PRICED_SIMULATED_OPEN } = await import("../paperVenue.js");

// Far stop and target so the synthetic price never settles the order in this test.
const OPEN_SIM = {
  id: 1, userId: 44, paperAccountId: 5, symbol: "EURUSD", direction: "BUY", orderType: "MARKET",
  lotSize: 1, entryPrice: 1.085, stopLoss: 0.0001, takeProfit: 1_000_000, status: "OPEN",
  strategyId: null, profitLoss: 0, exitPrice: null, openedAt: new Date(), closedAt: null,
};

test("pnlFor is a simulator scale, not money: a 1-lot, 50-pip EURUSD move is 0.50", () => {
  assert.ok(Math.abs(pnlFor("BUY", 1, 1.085, 1.09) - 0.5) < 1e-9);
});

test("a ticket order (no market quote) is valued at the synthetic simulator price, and the account says so", async () => {
  state.orders = [OPEN_SIM];
  state.ordersReads = 0;
  const acc = await markToMarket(5) as unknown as { valuation?: Record<string, unknown> };
  assert.ok(acc, "account returned");
  const v = acc.valuation;
  assert.ok(v, "the account carries a valuation disclosure");
  assert.equal(v.priceSource, "SIMULATOR");
  assert.equal(v.openPricedBySimulator, 1);
  assert.equal(v.units, "SIMULATOR_UNITS");
  assert.equal(v.pnlMultiplier, 100);
  assert.equal(v.marginPerLot, 1000);
  assert.match(String(v.note), /synthetic price \(generated, not a market quote\)/);
  assert.match(String(v.note), /simulator units, not money/);
  assert.match(String(v.note), /not the instrument's contract size/);
  assert.match(String(v.note), /not a broker margin/);
});

test("a market-priced open is valued at the quote; a closed simulator order is still disclosed", async () => {
  state.orders = [
    { ...OPEN_SIM, id: 2, strategyId: MARKET_PRICED_SIMULATED_OPEN },
    { ...OPEN_SIM, id: 3, status: "CLOSED_MANUAL", profitLoss: 0.5, exitPrice: 1.09, closedAt: new Date() },
  ];
  state.ordersReads = 0;
  const acc = await markToMarket(5) as unknown as { valuation?: Record<string, unknown> };
  const v = acc.valuation!;
  assert.equal(v.priceSource, "MARKET_QUOTE");
  assert.equal(v.openPricedBySimulator, 0);
  assert.equal(v.closedSimulatorPriced, 1);
  assert.match(String(v.note), /1 closed order was priced by the simulator, not the market/);
});
