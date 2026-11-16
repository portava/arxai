// Demo performance totals — GET /paper/history computed closedCount, wins,
// losses, winRate and netPnl from the same query that lists orders, which is
// capped at the latest 500. An account with more than 500 orders got totals
// for only its latest 500, presented as complete. The totals must cover every
// order of the account; the listed orders stay capped.
//
// Only the database handle and the paper venue's mark-to-market / ownership
// check are stubbed. No network, no broker.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/paperHistoryTotals.test.ts
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { getTableName, type Table } from "drizzle-orm";
import { withRouter } from "./_fakeRouteDb.js";

// 600 closed orders, newest first: the newest 500 won 1.00 each, the oldest
// 100 lost 2.00 each. Totals: 600 closed, 500 wins, 100 losses, net +300.
const ORDERS = Array.from({ length: 600 }, (_, i) => ({
  id: 600 - i, userId: 7, paperAccountId: 4, symbol: "EURUSD", direction: "BUY", lotSize: 0.1,
  entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.11, status: i < 500 ? "CLOSED_TP" : "CLOSED_SL",
  profitLoss: i < 500 ? 1 : -2, openedAt: new Date(Date.UTC(2026, 0, 1) + (600 - i) * 60_000),
}));

// A fake that honours .limit(n), so the 500 cap is real in this test.
function chain(rows: unknown[]) {
  let out = [...rows];
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.where = self; q.orderBy = self;
  q.limit = (n: number) => { out = out.slice(0, n); return q; };
  q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(out).then(ok, bad);
  return q;
}
const realDb = await import("@workspace/db");
const fakeDb = {
  select: (_cols?: unknown) => ({
    from: (table: Table) => chain(getTableName(table) === "paper_orders" ? ORDERS : []),
  }),
};
mock.module("@workspace/db", { namedExports: { ...realDb, db: fakeDb } });

const realVenue = await import("../../lib/tradeEngine/paperVenue.js");
mock.module("../../lib/tradeEngine/paperVenue.js", {
  namedExports: { ...realVenue, markToMarket: async () => ({}), ownPaperAccount: async () => true },
});

const router = (await import("../paperTrading.js")).default;

test("totals cover every order of the account, not only the latest 500", async () => {
  await withRouter(router, { id: 7, role: "user" }, async (base) => {
    const r = await fetch(`${base}/paper/history?accountId=4`);
    const body = await r.json() as Record<string, unknown>;
    assert.equal(r.status, 200, JSON.stringify(body).slice(0, 300));
    assert.equal(body["closedCount"], 600);
    assert.equal(body["wins"], 500);
    assert.equal(body["losses"], 100);
    assert.equal(body["netPnl"], 300);
    assert.equal(body["winRate"], 500 / 600);
    // The listed orders keep their cap.
    assert.equal((body["orders"] as unknown[]).length, 500);
  });
});
