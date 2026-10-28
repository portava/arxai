// Regression: the portfolio page (GET /portfolio/exposure) read the retired
// legacy trades table and summed `pnl ?? 0`:
//  - a CLOSED row with pnlStatus "UNKNOWN" was added into Realized P&L, though
//    the schema contract says UNKNOWN rows MUST be excluded from aggregates;
//  - legacy OPEN rows are never marked to market (pnl null), so Floating P&L
//    always read a green $0.00 that nobody measured;
//  - nothing said the figures exclude broker positions, so "No exposure." read
//    as all-clear while the real open book lives in arx_live_positions.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Trade } from "@workspace/db";
import { computeExposure } from "../exposure.js";

function trade(over: Partial<Trade>): Trade {
  return {
    id: 1, userId: 7, symbol: "EURUSD", direction: "BUY", strategy: "s", lot: 1,
    status: "OPEN", pnl: null, pnlStatus: null, closedAt: null,
    ...over,
  } as unknown as Trade;
}

test("a CLOSED row with pnlStatus UNKNOWN is excluded from realized and daily figures", () => {
  const now = new Date();
  const e = computeExposure([
    trade({ id: 1, status: "CLOSED_LOSS", pnl: -50, pnlStatus: "UNKNOWN", closedAt: now }),
    trade({ id: 2, status: "CLOSED_WIN", pnl: 20, pnlStatus: "COMPUTED", closedAt: now }),
  ]);
  assert.equal(e.realizedPnl, 20);
  assert.equal(e.realizedPnlExcludedUnknown, 1);
  assert.equal(e.dailyDrawdown, 0);
  assert.equal(e.totalClosed, 2);
});

test("an OPEN row with no marked P&L makes floating P&L unavailable, not 0", () => {
  const e = computeExposure([trade({ id: 3, status: "OPEN", pnl: null })]);
  assert.equal(e.floatingPnl, null);
  assert.match(String(e.floatingPnlUnavailableReason), /not marked to market/i);
});

test("with no open rows floating P&L is 0 (nothing open in this source)", () => {
  const e = computeExposure([]);
  assert.equal(e.floatingPnl, 0);
  assert.equal(e.floatingPnlUnavailableReason, null);
});

test("the response names its source and says broker positions are not included", () => {
  const e = computeExposure([]);
  assert.equal(e.source, "LEGACY_TRADES_TABLE");
  assert.match(e.sourceNote, /broker positions are not included/i);
});

// Regression: the note said only that broker positions were left out, which
// implied the trader's paper book and DEMO EA positions were included. The
// trades table is a frozen record of simulated rows that takes no new trades.
test("the source note says the rows are simulated and the paper book and DEMO EA positions are not included", () => {
  const e = computeExposure([]);
  assert.match(e.sourceNote, /simulated/i);
  assert.match(e.sourceNote, /paper book/i);
  assert.match(e.sourceNote, /DEMO EA positions/);
  assert.match(e.sourceNote, /no (longer|new)/i);
});
