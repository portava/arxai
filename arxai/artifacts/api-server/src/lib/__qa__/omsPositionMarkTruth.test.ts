// Simulator OMS: a position's currentPrice must say what it is.
//
// Before: tickPosition left currentPrice untouched when the simulator had no
// quote, and closePosition overwrote it with the SL/TP/exit price, yet the
// position carried no timestamp or basis — the Positions page labelled all
// of these "Now".
//
// Run: pnpm --filter @workspace/api-server run test:truth-component-evidence
import { mock, test } from "node:test";
import assert from "node:assert/strict";

mock.module("../riskGovernor/enforce.js", {
  namedExports: {
    enforcePreTradeRisk: async () => ({ allowed: true, blockedBy: [], primaryReason: null, auditEventId: null }),
  },
});

const oms = await import("../oms.js");
const { marketSimulator } = await import("../marketSimulator.js");
const actor = { userId: 1 };

async function openPosition() {
  const { order } = await oms.placeOrder({
    environment: "DEMO_SIMULATOR", source: "MANUAL", symbol: "EURUSD", direction: "BUY",
    lotSize: 0.01, stopLoss: 0.5, takeProfit: 2.0,
  }, actor);
  const r = await oms.fillOrder(order.orderId, actor);
  assert.ok(r.ok && r.value.position, "the order fills in the simulator");
  return r.value.position!;
}

test("a fill and each quoted tick stamp the mark with the simulator quote time", async () => {
  const p = await openPosition();
  assert.equal(p.currentPriceBasis, "SIMULATOR_QUOTE");
  assert.ok(p.currentPriceAsOf && !Number.isNaN(Date.parse(p.currentPriceAsOf)));
  oms.tickAll();
  const after = oms.getPosition(p.positionId)!;
  assert.equal(after.currentPriceBasis, "SIMULATOR_QUOTE");
});

test("a tick with no simulator quote marks the price as the last known mark, not live", async () => {
  const p = await openPosition();
  const asOf = p.currentPriceAsOf;
  const quote = mock.method(marketSimulator, "quote", () => null);
  try {
    oms.tickAll();
  } finally {
    quote.mock.restore();
  }
  const after = oms.getPosition(p.positionId)!;
  assert.equal(after.currentPrice, after.entryPrice);
  assert.equal(after.currentPriceBasis, "NO_QUOTE", "the stale mark is flagged");
  assert.equal(after.currentPriceAsOf, asOf, "the as-of time is the last quote that marked it");
});

test("a closed position's price is labelled the exit price, stamped at the close", async () => {
  const p = await openPosition();
  const r = await oms.closeOmsPosition(p.positionId, actor);
  assert.ok(r.ok);
  assert.equal(r.value.currentPriceBasis, "EXIT_PRICE");
  assert.equal(r.value.currentPriceAsOf, r.value.closedAt);
});
