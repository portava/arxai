// POST /positions/:id/close-confirmation built its summary as
// `Close BUY EURUSD @ ${currentPrice ?? entryPrice} (uPnL ${uPnL ?? 0})`, so a
// position with no stored price (every ARX-governed position: the reconciler
// stores the broker's profit but never a price) showed the ENTRY price as if
// it were the current price, and an unknown P/L read as 0. It also never said
// when the numbers were last updated from the broker. The real route runs here
// with the position ledger read stubbed (no database, no broker).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { withRouter } from "./_fakeRouteDb.js";

let row: Record<string, unknown> | null = null;
const ledger = await import("../../lib/positions/ledger.js");
mock.module("../../lib/positions/ledger.js", {
  namedExports: {
    ...ledger,
    demoPositionLedger: { ...ledger.demoPositionLedger, read: async () => (row ? [row] : []) },
  },
});
const router = (await import("../livePositions.js")).default;

const NOW = Date.now();
function position(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 7, userId: 1, tradeId: null, brokerPositionId: "555", symbol: "EURUSD", direction: "BUY",
    lotSize: 0.1, entryPrice: 1.08, currentPrice: null, stopLoss: 1.07, takeProfit: 1.1,
    unrealizedProfitLoss: null, realizedProfitLoss: null, rewardToRisk: null, status: "OPEN",
    openedAt: new Date(NOW - 3_600_000), closedAt: null, lastSyncedAt: null,
    createdAt: new Date(NOW - 3_600_000), updatedAt: new Date(NOW - 3_600_000),
    ...over,
  };
}

async function summary(over: Record<string, unknown>): Promise<string> {
  row = position(over);
  let out = "";
  await withRouter(router, { id: 1, role: "TRADER" }, async (base) => {
    const r = await fetch(`${base}/positions/7/close-confirmation`, { method: "POST" });
    assert.equal(r.status, 200);
    out = ((await r.json()) as { summary: string }).summary;
  });
  return out;
}

test("no stored price and no P/L: the entry price is never shown as the current price, and P/L is not 0", async () => {
  const s = await summary({ currentPrice: null, unrealizedProfitLoss: null, lastSyncedAt: null });
  assert.doesNotMatch(s, /@ 1\.08/, s);
  assert.doesNotMatch(s, /uPnL 0|P\/L 0\b/, s);
  assert.match(s, /No current price is stored/, s);
  assert.match(s, /entry price 1\.08/, s);
  assert.match(s, /unrealized P\/L is not known/i, s);
  assert.match(s, /no record of when/i, s);
});

test("a broker-reported P/L is shown with the time the position was last updated from the broker", async () => {
  const synced = new Date(NOW - 5 * 60_000);
  const s = await summary({ currentPrice: null, unrealizedProfitLoss: -12.5, lastSyncedAt: synced });
  assert.match(s, /unrealized P\/L -12\.5/, s);
  assert.match(s, new RegExp(synced.toISOString().replace(/[.]/g, "\\.")), s);
  assert.match(s, /5 min ago/, s);
  assert.match(s, /No current price is stored/, s);
});

test("a stored price is labelled as the last stored price, not a live quote", async () => {
  const s = await summary({ currentPrice: 1.0855, unrealizedProfitLoss: 55, lastSyncedAt: new Date(NOW - 30_000) });
  assert.match(s, /^Close BUY EURUSD\./, s);
  assert.match(s, /last stored price 1\.0855/i, s);
  assert.match(s, /unrealized P\/L 55/, s);
  assert.match(s, /broker's price/i, s);
});
