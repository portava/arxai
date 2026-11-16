// 2026-11-04 order-entry sweep: pure rules behind the server fixes.
//   • expiration: a past / unreadable pending expiry is refused, never GTC.
//   • quotes: a last-only quote is not two-sided (no side check against "last").
//   • one-click cap: a one-click order above maxLotPerClick is refused.
//   • live pending list: which ledger rows are still working orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { exceedsOneClickCap, twoSidedQuote, validateExpiration } from "../pendingOrderRules.js";
import { selectWorkingPendingOrders, type LivePendingCommandRow } from "../livePendingOrdersView.js";

const now = Date.parse("2026-11-04T10:00:00Z");

test("validateExpiration: absent is GTC, future is its epoch", () => {
  assert.deepEqual(validateExpiration(null, now), { ok: true, epochSeconds: null });
  assert.deepEqual(validateExpiration("", now), { ok: true, epochSeconds: null });
  assert.deepEqual(validateExpiration("2026-11-04T12:00:00Z", now), { ok: true, epochSeconds: Math.floor(Date.parse("2026-11-04T12:00:00Z") / 1000) });
  assert.deepEqual(validateExpiration(Math.floor(now / 1000) + 60, now), { ok: true, epochSeconds: Math.floor(now / 1000) + 60 });
});

test("validateExpiration: past and unreadable are refused, not turned into GTC", () => {
  const past = validateExpiration("2026-11-04T09:00:00Z", now);
  assert.equal(past.ok, false);
  assert.equal(!past.ok && past.code, "EXPIRATION_IN_PAST");
  const atNow = validateExpiration(new Date(now).toISOString(), now);
  assert.equal(!atNow.ok && atNow.code, "EXPIRATION_IN_PAST");
  const bad = validateExpiration("tomorrow-ish", now);
  assert.equal(!bad.ok && bad.code, "EXPIRATION_INVALID");
  const pastEpoch = validateExpiration(Math.floor(now / 1000) - 1, now);
  assert.equal(!pastEpoch.ok && pastEpoch.code, "EXPIRATION_IN_PAST");
});

test("twoSidedQuote: only a quote with both bid and ask is used for side rules", () => {
  assert.deepEqual(twoSidedQuote({ bid: 1.1, ask: 1.1002 }), { bid: 1.1, ask: 1.1002 });
  assert.deepEqual(twoSidedQuote({ bid: null, ask: null, last: 1.1 } as never), { bid: null, ask: null });
  assert.deepEqual(twoSidedQuote({ bid: 1.1 }), { bid: null, ask: null });
  assert.deepEqual(twoSidedQuote({ bid: 0, ask: 1.1 }), { bid: null, ask: null });
  assert.deepEqual(twoSidedQuote(null), { bid: null, ask: null });
});

test("exceedsOneClickCap: one-click above the cap is refused; no cap, non one-click or within cap pass", () => {
  assert.equal(exceedsOneClickCap({ oneClick: true, volume: 0.5, maxLotPerClick: 0.1 }), true);
  assert.equal(exceedsOneClickCap({ oneClick: true, volume: 0.1, maxLotPerClick: 0.1 }), false);
  assert.equal(exceedsOneClickCap({ oneClick: true, volume: 5, maxLotPerClick: null }), false);
  assert.equal(exceedsOneClickCap({ oneClick: true, volume: 5, maxLotPerClick: 0 }), false);
  assert.equal(exceedsOneClickCap({ oneClick: false, volume: 5, maxLotPerClick: 0.1 }), false);
  assert.equal(exceedsOneClickCap({ volume: 5, maxLotPerClick: 0.1 }), false);
});

const row = (o: Partial<LivePendingCommandRow>): LivePendingCommandRow => ({
  commandId: "lvcmd_1", status: "LIVE_FILLED", symbol: "EURUSD", side: "BUY", orderType: "BUY_LIMIT",
  requestedVolume: 0.1, stopLoss: 1.09, takeProfit: 1.12, brokerTicket: "5001",
  payload: { price: 1.1, expirationEpoch: null }, createdAt: new Date(now - 60_000), ...o,
});

test("selectWorkingPendingOrders: a ticketed placed order is listed with its price and basis", () => {
  const out = selectWorkingPendingOrders([row({})], new Set(), now);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.orderTicket, "5001");
  assert.equal(out[0]!.price, 1.1);
  assert.equal(out[0]!.side, "BUY");
  assert.equal(out[0]!.stateBasis, "LAST_EA_RESULT");
});

test("selectWorkingPendingOrders: filled-into-position, expired, unticketed, refused and duplicate rows are dropped", () => {
  const rows = [
    row({ commandId: "a", brokerTicket: "1" }),                                         // filled → position 1
    row({ commandId: "b", brokerTicket: "2", payload: { price: 1.1, expirationEpoch: Math.floor(now / 1000) - 5 } }), // expired
    row({ commandId: "c", brokerTicket: null }),                                         // no ticket
    row({ commandId: "d", brokerTicket: "0" }),                                          // zero ticket
    row({ commandId: "e", brokerTicket: "4", status: "LIVE_REJECTED" }),                 // refused
    row({ commandId: "f", brokerTicket: "5" }),
    row({ commandId: "g", brokerTicket: "5" }),                                          // duplicate ticket
    row({ commandId: "h", brokerTicket: "6", payload: { entry: 1.2, stopLimitPrice: 1.19, expirationEpoch: Math.floor(now / 1000) + 3600 } }),
  ];
  const out = selectWorkingPendingOrders(rows, new Set(["1"]), now);
  assert.deepEqual(out.map((o) => o.commandId), ["f", "h"]);
  assert.equal(out[1]!.price, 1.2);
  assert.equal(out[1]!.stopLimitPrice, 1.19);
  assert.equal(out[1]!.expiration, new Date((Math.floor(now / 1000) + 3600) * 1000).toISOString());
});
