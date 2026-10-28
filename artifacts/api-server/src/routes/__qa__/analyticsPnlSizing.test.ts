// Truth: Institutional Analytics (routes/analytics.ts) priced every closed
// paper trade as Δprice × lots × 100, whatever the instrument. A 1.00-lot,
// 100-pip EURUSD winner read $1 (real: $1,000), and gold, indices and
// synthetics got a made-up dollar figure. Net P&L, expectancy, the equity
// curve and max drawdown all inherited it.
//
// Now P&L is sized at the instrument's contract size (lib/mt5/contractSize.ts
// via paperPnl). A trade that cannot be sized is left out of every money
// figure and reported in pnlCoverage — never booked as $0 or a guess.
//
// Offline: the REAL router runs on loopback over an in-memory db fake.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const router = (await import("../analytics.js")).default;

function order(over: Record<string, unknown>) {
  return {
    id: 1, userId: 7, paperAccountId: 1, symbol: "EURUSD", direction: "BUY", orderType: "MARKET",
    lotSize: 1, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095, status: "CLOSED_TP",
    openedAt: new Date("2026-10-20T08:00:00Z"), closedAt: new Date("2026-10-20T09:00:00Z"),
    exitPrice: 1.095, profitLoss: 1, strategyId: null, tradePlanId: null, decisionId: null,
    clientRequestKey: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

const ORDERS = [
  // 1.00 lot EURUSD, +100 pips → +$1,000 on a 100,000-unit contract.
  order({ id: 1 }),
  // Gold: no broker contract spec here, so it cannot be sized honestly.
  order({ id: 2, symbol: "XAUUSD", entryPrice: 2380, stopLoss: 2370, takeProfit: 2400, exitPrice: 2370, status: "CLOSED_SL" }),
];

function seed() {
  fake = createFakeDb({
    paper_orders: ORDERS,
    trader_skill_profiles: [],
    post_trade_debriefs: [],
    edge_discovery_reports: [],
  });
}

test("snapshot: 1.00 lot EURUSD +100 pips books $1,000 (not $1); unsized gold is left out and reported", async () => {
  seed();
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/analytics/snapshot`, { method: "POST" });
    const body = await r.json() as { snapshot: Record<string, number>; pnlCoverage: Record<string, unknown> };
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.snapshot["netProfitLoss"], 1000);
    assert.equal(body.snapshot["expectancy"], 1000);
    assert.equal(body.snapshot["totalTrades"], 2);
    // Win rate is by price move: one favourable, one adverse.
    assert.equal(body.snapshot["winRate"], 0.5);
    assert.equal(body.pnlCoverage["sizedTrades"], 1);
    assert.equal(body.pnlCoverage["unsizedTrades"], 1);
    assert.deepEqual(body.pnlCoverage["unsizedSymbols"], ["XAUUSD"]);
    assert.match(String(body.pnlCoverage["note"]), /could not be sized/);
  });
  const ins = fake.inserts.find((i) => i.table === "analytics_snapshots");
  assert.ok(ins);
  assert.equal(ins.values["netProfitLoss"], 1000);
  assert.equal("pnlCoverage" in ins.values, false, "coverage is not a snapshot column");
});

test("drawdown: the equity curve steps only on sized trades", async () => {
  seed();
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/analytics/drawdown`);
    const body = await r.json() as { equityCurve: Array<{ tradeId: number; equity: number }>; maxDrawdown: number; pnlCoverage: Record<string, unknown> };
    assert.equal(r.status, 200);
    assert.deepEqual(body.equityCurve.map((p) => [p.tradeId, p.equity]), [[1, 1000]]);
    assert.equal(body.maxDrawdown, 0);
    assert.equal(body.pnlCoverage["unsizedTrades"], 1);
  });
});

test("strategy: no $0.00 row for a symbol whose trades could not be sized", async () => {
  seed();
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/analytics/strategy`);
    const body = await r.json() as { strategies: Array<Record<string, unknown>>; pnlCoverage: Record<string, unknown> };
    assert.equal(r.status, 200);
    assert.deepEqual(body.strategies.map((s) => s["symbol"]), ["EURUSD"]);
    assert.equal(body.strategies[0]!["totalPnl"], 1000);
    assert.deepEqual(body.pnlCoverage["unsizedSymbols"], ["XAUUSD"]);
  });
});

test("snapshot: with nothing sizable, the coverage note says P&L was not measured", async () => {
  fake = createFakeDb({
    paper_orders: [ORDERS[1]],
    trader_skill_profiles: [], post_trade_debriefs: [], edge_discovery_reports: [],
  });
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/analytics/snapshot`, { method: "POST" });
    const body = await r.json() as { snapshot: Record<string, unknown>; pnlCoverage: Record<string, unknown> };
    assert.equal(body.pnlCoverage["sizedTrades"], 0);
    assert.match(String(body.pnlCoverage["note"]), /^P&L not measured/);
    assert.equal(body.snapshot["strongestStrategy"], null);
  });
});
