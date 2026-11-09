// Truth: a demo (paper) trade's pnl is (exit − entry) × direction × lot size —
// a price move times lots with no contract size or account currency, so it is
// not money (EURUSD 1.0850 → 1.0900 at 1 lot is 0.005). Each serialized trade
// now says so (pnlUnit), so no surface has to guess.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
const fake = createFakeDb({
  paper_trades: [{
    id: 1, userId: 7, symbol: "EURUSD", side: "buy", status: "closed", entryPrice: 1.085, exitPrice: 1.09,
    lotSize: 1, pnl: 0.005, openedAt: new Date("2026-10-27T09:00:00Z"), closedAt: new Date("2026-10-27T10:00:00Z"),
    cancelledAt: null, createdAt: new Date("2026-10-27T09:00:00Z"), updatedAt: null,
  }],
});
mock.module("@workspace/db", { namedExports: { ...realDb, db: fake.db } });
const router = (await import("../mePaperTrades.js")).default;

test("a listed demo trade names its P/L unit: price move × lots, not money", async () => {
  await withRouter(router, { id: 7 }, async (base) => {
    const r = await fetch(`${base}/me/paper-trades`);
    assert.equal(r.status, 200);
    const { trades } = await r.json() as { trades: Array<Record<string, unknown>> };
    assert.equal(trades[0]!["pnl"], 0.005);
    assert.equal(trades[0]!["pnlUnit"], "price_move_x_lots");
  });
});
