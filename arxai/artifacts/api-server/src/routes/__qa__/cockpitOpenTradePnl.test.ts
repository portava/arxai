// GET /api/trading-cockpit/summary → "Open paper trades". paper_orders.profitLoss
// defaults to 0 and is written only when an order closes; mark-to-market folds
// floating P&L into the account's equity, never into the order row. The
// cockpit returned that column default for every open order, so each open
// trade read "P&L 0" as if it had been measured flat. An open order's P&L is
// now null with a status saying it is not measured, and a failed read of the
// open orders says so instead of returning an empty list ("no open trades").
//
// The real router runs; the database and the other cockpit reads are stubbed.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/cockpitOpenTradePnl.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";

const database = await import("@workspace/db");
const state: { paperOrders: unknown[]; failPaperOrders: boolean } = { paperOrders: [], failPaperOrders: false };

function chain(rows: () => unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = self; q.where = self; q.orderBy = self; q.limit = self;
  q.then = (ok: (v: unknown[]) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve().then(rows).then(ok, bad);
  return q;
}
const fakeDb = {
  select: () => ({
    from: (table: Table) => chain(() => {
      if (getTableName(table) !== "paper_orders") return [];
      if (state.failPaperOrders) throw new Error("db down");
      return state.paperOrders;
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });
mock.module("../../lib/auth/middleware.js", {
  namedExports: { requireUser: (_req: unknown, _res: unknown, next: () => void) => next() },
});
mock.module("../../lib/paperSession/manager.js", {
  namedExports: {
    preflight: async () => ({ paperTestingAllowed: true, hardBlocks: [], warnings: [], generatedAt: new Date().toISOString() }),
    getActiveSession: async () => null,
  },
});
mock.module("../../lib/readiness/traderReadiness.js", { namedExports: { evaluateReadiness: async () => null } });
mock.module("../../lib/readiness/gate.js", { namedExports: { getGateStatus: async () => null } });
mock.module("../../lib/alerts/alertManager.js", {
  namedExports: { getCriticalUnread: async () => [], getUnreadCount: async () => 0 },
});
mock.module("../../lib/systemHealth/health.js", { namedExports: { runHealthCheck: async () => ({}) } });

const { withRouter } = await import("./_fakeRouteDb.js");
const { default: router } = await import("../tradingCockpit.js");

const OPEN_ROW = {
  id: 7, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1,
  stopLoss: 1.09, takeProfit: 1.2, status: "OPEN", openedAt: new Date("2026-10-28T09:00:00Z"),
  profitLoss: 0,
};

async function summary(): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  await withRouter(router, { id: 44, role: "USER" }, async (base) => {
    const res = await fetch(`${base}/trading-cockpit/summary`);
    assert.equal(res.status, 200);
    body = (await res.json()) as Record<string, unknown>;
  });
  return body.summary as Record<string, unknown>;
}

test("an open paper order's P&L is not measured, not the column default 0", async () => {
  state.paperOrders = [OPEN_ROW];
  state.failPaperOrders = false;
  const s = await summary();
  const trades = s.openPaperTrades as Array<Record<string, unknown>>;
  assert.equal(trades.length, 1);
  assert.equal(trades[0]!.symbol, "EURUSD");
  assert.equal(trades[0]!.profitLoss, null, "the stored 0 is a column default, not a floating P&L");
  assert.equal(trades[0]!.profitLossStatus, "NOT_MEASURED");
  assert.equal(trades[0]!.openedAt, "2026-10-28T09:00:00.000Z");
  assert.equal(s.openPaperTradesStatus, "LOADED");
  assert.match(String(s.openPaperTradesNote), /not tracked per open order/i);
  assert.match(String(s.openPaperTradesNote), /when (it|the order) closes/i);
});

test("a failed read of the open paper orders is 'could not be loaded', not 'no open trades'", async () => {
  state.paperOrders = [OPEN_ROW];
  state.failPaperOrders = true;
  const s = await summary();
  assert.equal(s.openPaperTradesStatus, "UNAVAILABLE");
  assert.deepEqual(s.openPaperTrades, []);
});
