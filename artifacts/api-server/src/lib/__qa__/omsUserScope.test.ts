// Simulator OMS — the book shown on /orders and /positions belongs to the
// user who placed it, and a partial close is booked as realized P/L on the
// day it happened.
//
// Before this, lib/oms.ts kept one process-wide orders/positions Map with no
// owner, and GET /orders, /oms/positions and /pnl/summary returned it to any
// signed-in caller: user B saw operator A's simulator book as "your
// positions". A ½ close added to the open row's realizedPnL, but pnlSummary
// summed realizedPnL over CLOSED positions only, so Daily/Weekly left the
// partial out until the remainder closed (and closePosition then overwrote
// the partial with the remainder's P/L).
//
// The pre-trade Risk Governor is mocked to "allow" so this runs without a
// database; its own behaviour is covered by omsGovernance.test.ts.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit src/lib/__qa__/omsUserScope.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

mock.module("../riskGovernor/enforce.js", {
  namedExports: {
    enforcePreTradeRisk: async () => ({ allowed: true, blockedBy: [], primaryReason: null, auditEventId: null }),
  },
});

const oms = await import("../oms.js");
const { marketSimulator } = await import("../marketSimulator.js");

const SYMBOL = "EURUSD";
const A = { userId: 9101 };
const B = { userId: 9102 };

async function openFor(actor: { userId: number }, lotSize = 0.1) {
  const q = marketSimulator.quote(SYMBOL);
  assert.ok(q, "simulator quotes EURUSD");
  const { order } = await oms.placeOrder({
    environment: "PAPER", source: "MANUAL", symbol: SYMBOL, direction: "BUY", lotSize,
    stopLoss: Number((q.ask - 0.05).toFixed(5)), takeProfit: Number((q.ask + 0.1).toFixed(5)),
  }, actor);
  const filled = await oms.fillOrder(order.orderId, actor);
  assert.ok(filled.ok, filled.ok ? "" : filled.message);
  assert.ok(filled.value.position, filled.value.error);
  return { order, position: filled.value.position! };
}

test("orders, positions and P/L are listed for their owner only", async () => {
  const { order, position } = await openFor(A);

  const aOrders = oms.listOrders({ ownerUserId: A.userId });
  const bOrders = oms.listOrders({ ownerUserId: B.userId });
  assert.ok(aOrders.some((o) => o.orderId === order.orderId), "A sees A's order");
  assert.equal(bOrders.some((o) => o.orderId === order.orderId), false, "B must not see A's order");

  const aPos = oms.listPositions({ ownerUserId: A.userId });
  const bPos = oms.listPositions({ ownerUserId: B.userId });
  assert.ok(aPos.some((p) => p.positionId === position.positionId), "A sees A's position");
  assert.deepEqual(bPos, [], "B sees an empty book");

  await oms.closeOmsPosition(position.positionId, A);
  const bPnl = oms.pnlSummary(undefined, { ownerUserId: B.userId });
  assert.equal(bPnl.closedRealizedPnL, 0);
  assert.equal(bPnl.wins + bPnl.losses, 0, "B's P/L does not count A's closed trade");
});

test("the HTTP routes pass the signed-in user's scope to every book read", () => {
  const src = readFileSync(new URL("../../routes/oms.ts", import.meta.url), "utf8");
  for (const call of ["listOrders(", "listPositions(", "pnlSummary(", "pnlDaily(", "pnlBy("]) {
    const at = [...src.matchAll(new RegExp(call.replace("(", "\\("), "g"))].map((m) => m.index!);
    assert.ok(at.length > 0, `${call} is used`);
    for (const i of at) {
      const line = src.slice(i, src.indexOf("\n", i));
      assert.match(line, /ownerScope\(req\)|ownerUserId/, `${call} at offset ${i} is scoped to the caller: ${line}`);
    }
  }
  assert.match(src, /getOrder\(String\(req\.params\.id\)\)[\s\S]{0,200}ownedBy/, "GET /orders/:id checks ownership");
  assert.match(src, /getPosition\(String\(req\.params\.id\)\)[\s\S]{0,200}ownedBy/, "GET /oms/positions/:id checks ownership");
});

test("a partial close is realized P/L today and survives the final close", async () => {
  const actor = { userId: 9103 };
  const { position } = await openFor(actor, 0.2);
  // Move the mark price so the partial close realizes a non-zero amount.
  const live = oms.getPosition(position.positionId)!;
  const realizedHalf = (() => {
    (live as { currentPrice: number }).currentPrice = Number((live.entryPrice - 0.0025).toFixed(5));
    return Number((((live.currentPrice - live.entryPrice) / 0.0001) * 10 * 0.1).toFixed(2));
  })();
  assert.ok(realizedHalf < 0, "fixture moves price against the BUY");

  const r = await oms.partialCloseOmsPosition(position.positionId, 0.5, actor);
  assert.ok(r.ok, r.ok ? "" : r.message);
  assert.equal(r.value.status, "OPEN");
  assert.equal(r.value.realizedPnL, realizedHalf);

  const mid = oms.pnlSummary(undefined, { ownerUserId: actor.userId });
  assert.equal(mid.dailyPnL, realizedHalf, "Daily includes the partial close realized today");
  assert.equal(mid.weeklyPnL, realizedHalf, "Weekly includes it too");
  assert.equal(mid.closedRealizedPnL, realizedHalf, "realized total includes it");

  // Close the remainder at entry (0.00 on the remaining half): total stays the partial.
  const remaining = oms.getPosition(position.positionId)!;
  (remaining as { currentPrice: number }).currentPrice = remaining.entryPrice;
  const closed = await oms.closeOmsPosition(position.positionId, actor);
  assert.ok(closed.ok, closed.ok ? "" : closed.message);
  assert.equal(closed.value.realizedPnL, realizedHalf, "final close adds to, never overwrites, the partial");
  const end = oms.pnlSummary(undefined, { ownerUserId: actor.userId });
  assert.equal(end.dailyPnL, realizedHalf, "the partial is booked once, not twice");
  assert.equal(end.closedRealizedPnL, realizedHalf);
});
