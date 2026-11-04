// /oms/dashboard-summary "today P&L" vs /pnl/summary dailyPnL for the same
// user. pnlSummary books each realization on its own day (a ½ close today
// counts today; the remainder counts on the day it closes). The dashboard
// summary bucketed each CLOSED position's whole realizedPnL by its close day,
// so a partial close today was missing from today's figure while the position
// stayed open, and a position closed today carried yesterday's partial into
// today. The two "today" numbers disagreed for one user.
//
// The pre-trade Risk Governor is mocked to "allow" so this runs without a
// database; its own behaviour is covered by omsGovernance.test.ts.
import { mock, test } from "node:test";
import assert from "node:assert/strict";

mock.module("../riskGovernor/enforce.js", {
  namedExports: {
    enforcePreTradeRisk: async () => ({ allowed: true, blockedBy: [], primaryReason: null, auditEventId: null }),
  },
});

const oms = await import("../oms.js");
const { omsDashboardSummaryFor } = await import("../omsScopedSummary.js");
const { marketSimulator } = await import("../marketSimulator.js");

async function openFor(actor: { userId: number }) {
  const q = marketSimulator.quote("EURUSD");
  assert.ok(q, "simulator quotes EURUSD");
  const { order } = await oms.placeOrder({
    environment: "PAPER", source: "MANUAL", symbol: "EURUSD", direction: "BUY", lotSize: 0.2,
    stopLoss: Number((q.ask - 0.05).toFixed(5)), takeProfit: Number((q.ask + 0.1).toFixed(5)),
  }, actor);
  const filled = await oms.fillOrder(order.orderId, actor);
  assert.ok(filled.ok && filled.value.position, "position opened");
  return filled.value.position!;
}

// Set the mark the next close books at (the simulator tick loop only runs
// every 2 s; a close right after a fill would otherwise realize 0.00).
function markAt(positionId: string, offset: number) {
  const live = oms.getPosition(positionId)!;
  (live as { currentPrice: number }).currentPrice = Number((live.entryPrice + offset).toFixed(5));
}

test("a partial close today counts in today's dashboard P&L, as it does in /pnl/summary", async () => {
  const A = { userId: 9301 };
  const p = await openFor(A);
  markAt(p.positionId, 0.0025);
  const part = await oms.partialCloseOmsPosition(p.positionId, 0.5, A);
  assert.ok(part.ok);
  const scope = { ownerUserId: A.userId };
  const daily = oms.pnlSummary(undefined, scope).dailyPnL;
  assert.ok(daily > 0, "the partial realized a gain today");
  assert.equal(oms.listPositions(scope)[0]!.status, "OPEN", "the rest of the position is still open");
  assert.equal(omsDashboardSummaryFor(scope).todayPnL, daily);
});

test("yesterday's partial is not counted again when the remainder closes today", async () => {
  const B = { userId: 9302 };
  const p = await openFor(B);
  markAt(p.positionId, -0.0025);
  const part = await oms.partialCloseOmsPosition(p.positionId, 0.5, B);
  assert.ok(part.ok);
  // Move the partial's booking to yesterday (it happened on day D; today is D+1).
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = oms.listPositions({ ownerUserId: B.userId })[0]!;
  row.realizations[0]!.at = yesterday;
  markAt(p.positionId, 0.0010);
  const closed = await oms.closeOmsPosition(p.positionId, B);
  assert.ok(closed.ok);
  const scope = { ownerUserId: B.userId };
  const daily = oms.pnlSummary(undefined, scope).dailyPnL;
  assert.ok(daily > 0 && closed.value.realizedPnL < 0, "today's remainder gained; the trade overall lost");
  assert.equal(omsDashboardSummaryFor(scope).todayPnL, daily);
});
