// Truth: the auto-debrief (lib/autoDebriefService.ts) stored
//   pnl_percent = profit_loss ÷ (entry × lots × 100) × 100
// — a fixed 100-unit contract. For a 1.00-lot EURUSD trade booked at
// +$1,000 on a 100,000-unit contract that is 921.66%, and an order whose
// P&L could not be sized (profit_loss 0 placeholder) read 0%.
//
// Return on notional needs no contract size: P&L and notional share it, so
// it is the price move in the trade's favour ÷ entry. null when there is no
// exit price.
//
// Offline: the REAL service runs over an in-memory db fake.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "../../routes/__qa__/_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

const { runAutoDebrief } = await import("../autoDebriefService.js");

function order(over: Record<string, unknown>) {
  return {
    id: 41, userId: null, paperAccountId: 1, symbol: "EURUSD", direction: "BUY", orderType: "MARKET",
    lotSize: 1, entryPrice: 1.085, stopLoss: 1.08, takeProfit: 1.095, status: "CLOSED_TP",
    openedAt: new Date("2026-10-20T08:00:00Z"), closedAt: new Date("2026-10-20T09:00:00Z"),
    exitPrice: 1.095, profitLoss: 1000, strategyId: "build_ee_paper_execution", tradePlanId: null,
    decisionId: null, clientRequestKey: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

async function debriefPnlPercent(o: Record<string, unknown>): Promise<unknown> {
  fake = createFakeDb({ paper_orders: [o], post_trade_debriefs: [], heat_snapshots: [] });
  const r = await runAutoDebrief(o["id"] as number, { triggeredBy: "test" });
  assert.equal(r.status, "created", JSON.stringify(r));
  const ins = fake.inserts.find((i) => i.table === "post_trade_debriefs");
  assert.ok(ins);
  return (ins.values["autoMeta"] as Record<string, unknown>)["pnl_percent"];
}

test("1.00 lot EURUSD +100 pips booked at +$1,000: pnl_percent is the 0.92% move, not 921.66%", async () => {
  const pct = await debriefPnlPercent(order({}));
  assert.notEqual(pct, 921.6589861751152);
  assert.equal(pct, 0.9217);
});

test("an order whose P&L could not be sized (stored 0) still reports its real move, not 0%", async () => {
  const pct = await debriefPnlPercent(order({
    id: 42, symbol: "XAUUSD", direction: "SELL", entryPrice: 2380, stopLoss: 2400, takeProfit: 2360,
    exitPrice: 2400, status: "CLOSED_SL", profitLoss: 0,
  }));
  assert.equal(pct, -0.8403);
});

test("no exit price: pnl_percent is null, never 0", async () => {
  const pct = await debriefPnlPercent(order({ id: 43, status: "CANCELLED", exitPrice: null, profitLoss: 0 }));
  assert.equal(pct, null);
});
