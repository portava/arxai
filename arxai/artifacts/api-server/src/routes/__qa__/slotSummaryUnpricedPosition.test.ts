// GET /api/me/live/slot-summary — a position whose floating P/L the broker has
// not reported (floatingPl null) has unknown P/L, never $0.00.
//
// The defect this locks: floatingPl null was counted as 0 — the row showed
// "Net P/L $0.00" and the Open P/L tile and Slot Equity silently included it.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/slotSummaryUnpricedPosition.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { getSlotSummary, installSlotSummaryMocks, positionRow, state } from "./slotSummaryHarness.js";

await installSlotSummaryMocks();

test("an unpriced position: row P/L null, open P/L and equity unknown, count reported", async () => {
  const now = new Date();
  state.bridge = { id: 3, leverage: 100, lastHeartbeat: now, lastPositionsSnapshotAt: now };
  state.positions = [
    positionRow({ id: 1, brokerTicket: "5001", floatingPl: 12.5 }),
    positionRow({ id: 2, brokerTicket: "5002", floatingPl: null, currentPrice: null }),
  ];
  const s = await getSlotSummary();
  const positions = s["positions"] as Array<Record<string, unknown>>;
  const unpriced = positions.find((p) => p["brokerTicket"] === "5002")!;
  assert.equal(unpriced["netProfit"], null);
  assert.equal(unpriced["grossProfit"], null);
  assert.equal(unpriced["profitPercentOfSlot"], null);
  assert.equal(s["openPnL"], null, "open P/L is not a sum that counts the unpriced row as 0");
  assert.equal(s["equity"], null);
  assert.equal(s["freeMargin"], null);
  assert.equal(s["unpricedPositionCount"], 1);
  // Per-row freshness / confirmation stay on the wire for the panel.
  assert.equal(unpriced["freshness"], "FRESH");
  assert.equal(unpriced["confirmation"], "BROKER_CONFIRMED");
});

test("all positions priced: open P/L and equity are the real sums", async () => {
  const now = new Date();
  state.bridge = { id: 3, leverage: 100, lastHeartbeat: now, lastPositionsSnapshotAt: now };
  state.positions = [positionRow({ floatingPl: 12.5 }), positionRow({ id: 2, brokerTicket: "5002", floatingPl: -2.5 })];
  const s = await getSlotSummary();
  assert.equal(s["openPnL"], 10);
  assert.equal(s["equity"], 1010);
  assert.equal(s["unpricedPositionCount"], 0);
});
