// /oms/pnl/summary returned winRate 0, averageR 0 and maxDrawdown 0 when the
// caller had open simulator positions but none closed, and the Positions page
// printed "Win rate (closed) 0%", "Avg R (closed) 0", "Max DD (closed)
// $0.00" — figures nobody measured. "Sim realized today" summed the UTC day
// without saying so. The summary now carries closedCount and dayBoundary
// ("UTC") so the page can say what was and was not measured.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/lib/__qa__/omsPnlSummaryClosedCount.test.ts
import { mock, test } from "node:test";
import assert from "node:assert/strict";

mock.module("../riskGovernor/enforce.js", {
  namedExports: {
    enforcePreTradeRisk: async () => ({ allowed: true, blockedBy: [], primaryReason: null, auditEventId: null }),
  },
});

const oms = await import("../oms.js");

async function openPosition(userId: number) {
  const { order } = await oms.placeOrder({
    environment: "DEMO_SIMULATOR", source: "MANUAL", symbol: "EURUSD", direction: "BUY",
    lotSize: 0.01, stopLoss: 0.5, takeProfit: 2.0,
  }, { userId });
  const r = await oms.fillOrder(order.orderId, { userId });
  assert.ok(r.ok && r.value.position, "the order fills in the simulator");
  return r.value.position!;
}

test("open positions and none closed: closedCount is 0, so the closed-trade figures were not measured", async () => {
  await openPosition(9101);
  const s = oms.pnlSummary(undefined, { ownerUserId: 9101 });
  assert.equal(s.closedCount, 0);
  assert.equal(s.dayBoundary, "UTC");
});

test("after a close, closedCount counts it", async () => {
  const p = await openPosition(9102);
  const r = await oms.closeOmsPosition(p.positionId, { userId: 9102 });
  assert.ok(r.ok);
  const s = oms.pnlSummary(undefined, { ownerUserId: 9102 });
  assert.equal(s.closedCount, 1);
});
