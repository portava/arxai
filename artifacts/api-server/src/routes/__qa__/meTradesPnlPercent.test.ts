// Truth: the "(x%)" beside open-trade P&L on My Open Trades must not come
// from P&L ÷ (entry × lots × 100). That divisor assumes a 100-unit contract,
// so a 1.00-lot EURUSD trade +1000 read "921.66%". No notional or equity
// basis is held for these cards, so the percent is withheld (null).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, withRouter } from "./_fakeRouteDb.js";

const realDb = await import("@workspace/db");
let fake = createFakeDb({});
const dbProxy = new Proxy({}, { get: (_t, p) => (fake.db as Record<string | symbol, unknown>)[p] });
mock.module("@workspace/db", { namedExports: { ...realDb, db: dbProxy } });

let routing: "USER_OWNED_MT5" | "SHARED_MASTER_MT5" = "SHARED_MASTER_MT5";
const realEnv = await import("../../lib/adminTrading/safetyEnvelope.js");
mock.module("../../lib/adminTrading/safetyEnvelope.js", { namedExports: {
  ...realEnv,
  getEnvelope: async () => ({ ...realEnv.FAIL_CLOSED_ENVELOPE, accountRoutingMode: routing, accountType: "demo", tradingMode: "DEMO", bannerLabel: "DEMO" }),
} });
const realScope = await import("../../lib/modeScope/getUserModeScope.js");
mock.module("../../lib/modeScope/getUserModeScope.js", { namedExports: {
  ...realScope,
  getUserModeScope: async () => ({ currentAccountMode: "DEMO" }),
} });
const realOpen = await import("../../lib/positions/openPositions.js");
mock.module("../../lib/positions/openPositions.js", { namedExports: {
  ...realOpen,
  selectDemoOpenPositions: async () => [{
    id: 11, symbol: "EURUSD", direction: "BUY", lotSize: 1, entryPrice: 1.085, currentPrice: null,
    stopLoss: null, takeProfit: null, unrealizedProfitLoss: 1000, lastSyncedAt: new Date(),
    status: "OPEN", openedAt: new Date(), createdAt: new Date(),
  }],
} });
const router = (await import("../meTrades.js")).default;

async function openCards(): Promise<Array<Record<string, unknown>>> {
  let cards: Array<Record<string, unknown>> = [];
  await withRouter(router, { id: 7, role: "user" }, async (base) => {
    const r = await fetch(`${base}/me/trades/open`);
    const body = await r.json() as { cards: Array<Record<string, unknown>> };
    assert.equal(r.status, 200, JSON.stringify(body));
    cards = body.cards;
  });
  return cards;
}

test("shared-master EURUSD 1.00 lot +1000: pnlPercent is not 921.66 (withheld)", async () => {
  routing = "SHARED_MASTER_MT5";
  fake = createFakeDb({
    shared_trade_attribution: [{
      id: 5, userId: 7, sharedMasterAccountId: 2, symbol: "EURUSD", side: "BUY", lotSize: 1,
      entryPrice: 1.085, stopLoss: null, takeProfit: null, pnl: 1000, status: "open",
      mt5PositionTicket: "778899", openedAt: new Date(), createdAt: new Date(),
    }],
    shared_master_accounts: [{ broker: "Demo Broker", masked: "***1234" }],
  });
  const cards = await openCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!["unrealizedPnl"], 1000);
  assert.notEqual(cards[0]!["pnlPercent"], 921.66);
  assert.equal(cards[0]!["pnlPercent"], null);
});

test("user-owned EURUSD 1.00 lot +1000: pnlPercent stays withheld", async () => {
  routing = "USER_OWNED_MT5";
  fake = createFakeDb({});
  const cards = await openCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!["pnlPercent"], null);
});
