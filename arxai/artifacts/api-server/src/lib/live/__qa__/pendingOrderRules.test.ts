// MT5 order-type rules used by the instant-trade router (pendingOrderRules.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyOrderType, expirationEpochSeconds, isKnownOrderType, label, validatePendingOrder, validateProtection,
} from "../pendingOrderRules.js";

const q = { bid: 1.1000, ask: 1.1002 };

test("classifyOrderType normalises spellings and tells market from pending", () => {
  assert.deepEqual(classifyOrderType("buy limit", "BUY"), { canonical: "BUY_LIMIT", kind: "LIMIT", side: "BUY", pending: true });
  assert.equal(classifyOrderType("BUY_MARKET", "BUY").canonical, "MARKET_BUY");
  assert.equal(classifyOrderType(undefined, "SELL").canonical, "MARKET_SELL");
  assert.equal(classifyOrderType("Sell-Stop-Limit", "SELL").kind, "STOP_LIMIT");
  assert.equal(isKnownOrderType("BUY_LIMIT"), true);
  assert.equal(isKnownOrderType("BUY_WHATEVER"), false);
  assert.equal(label("MARKET_BUY"), "BUY by Market");
  assert.equal(label("SELL_STOP"), "Sell Stop");
});

test("market orders need no price", () => {
  assert.deepEqual(validatePendingOrder({ orderType: "MARKET_BUY", action: "BUY", price: null, ...q }), { ok: true });
});

test("a pending order without a price is refused", () => {
  const r = validatePendingOrder({ orderType: "BUY_LIMIT", action: "BUY", price: null, ...q });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "MISSING_PENDING_PRICE");
});

test("MT5 side rules: Buy Limit below Ask, Buy Stop above Ask, Sell Limit above Bid, Sell Stop below Bid", () => {
  assert.equal(validatePendingOrder({ orderType: "BUY_LIMIT", action: "BUY", price: 1.0990, ...q }).ok, true);
  assert.equal(validatePendingOrder({ orderType: "BUY_LIMIT", action: "BUY", price: 1.1010, ...q }).ok, false);
  assert.equal(validatePendingOrder({ orderType: "BUY_STOP", action: "BUY", price: 1.1010, ...q }).ok, true);
  assert.equal(validatePendingOrder({ orderType: "BUY_STOP", action: "BUY", price: 1.0990, ...q }).ok, false);
  assert.equal(validatePendingOrder({ orderType: "SELL_LIMIT", action: "SELL", price: 1.1010, ...q }).ok, true);
  assert.equal(validatePendingOrder({ orderType: "SELL_LIMIT", action: "SELL", price: 1.0990, ...q }).ok, false);
  assert.equal(validatePendingOrder({ orderType: "SELL_STOP", action: "SELL", price: 1.0990, ...q }).ok, true);
  assert.equal(validatePendingOrder({ orderType: "SELL_STOP", action: "SELL", price: 1.1010, ...q }).ok, false);
  const wrong = validatePendingOrder({ orderType: "BUY_STOP", action: "BUY", price: 1.0990, ...q });
  if (!wrong.ok) { assert.equal(wrong.code, "PENDING_PRICE_WRONG_SIDE"); assert.match(wrong.detail, /above the current Ask/); }
});

test("stop-limit: the limit leg sits below the stop for a Buy and above it for a Sell", () => {
  assert.equal(validatePendingOrder({ orderType: "BUY_STOP_LIMIT", action: "BUY", price: 1.1010, stopLimitPrice: 1.1005, ...q }).ok, true);
  const r1 = validatePendingOrder({ orderType: "BUY_STOP_LIMIT", action: "BUY", price: 1.1010, stopLimitPrice: 1.1015, ...q });
  assert.equal(r1.ok, false); if (!r1.ok) assert.equal(r1.code, "STOP_LIMIT_PRICE_WRONG_SIDE");
  const r2 = validatePendingOrder({ orderType: "SELL_STOP_LIMIT", action: "SELL", price: 1.0990, stopLimitPrice: null, ...q });
  assert.equal(r2.ok, false); if (!r2.ok) assert.equal(r2.code, "MISSING_STOP_LIMIT_PRICE");
});

test("type/side mismatch and unknown types are refused; unknown bid/ask skips only the side check", () => {
  const m = validatePendingOrder({ orderType: "SELL_LIMIT", action: "BUY", price: 1.2, ...q });
  assert.equal(m.ok, false); if (!m.ok) assert.equal(m.code, "ORDER_TYPE_SIDE_MISMATCH");
  const u = validatePendingOrder({ orderType: "BUY_OCO", action: "BUY", price: 1.2, ...q });
  assert.equal(u.ok, false); if (!u.ok) assert.equal(u.code, "UNKNOWN_ORDER_TYPE");
  assert.equal(validatePendingOrder({ orderType: "BUY_LIMIT", action: "BUY", price: 1.5, bid: null, ask: null }).ok, true);
  assert.equal(validatePendingOrder({ orderType: "BUY_LIMIT", action: "BUY", price: null, bid: null, ask: null }).ok, false);
});

test("SL/TP side rules: Buy SL below / TP above the reference, Sell the reverse; no reference = broker decides", () => {
  assert.equal(validateProtection({ side: "BUY", reference: 1.1, stopLoss: 1.09, takeProfit: 1.12 }).ok, true);
  const a = validateProtection({ side: "BUY", reference: 1.1, stopLoss: 1.11 });
  assert.equal(a.ok, false); if (!a.ok) assert.equal(a.code, "STOP_LOSS_WRONG_SIDE");
  const b = validateProtection({ side: "SELL", reference: 1.1, takeProfit: 1.12 });
  assert.equal(b.ok, false); if (!b.ok) assert.equal(b.code, "TAKE_PROFIT_WRONG_SIDE");
  assert.equal(validateProtection({ side: "SELL", reference: 1.1, stopLoss: 1.11, takeProfit: 1.08 }).ok, true);
  assert.equal(validateProtection({ side: "SELL", reference: null, stopLoss: 1.0 }).ok, true);
});

test("expiration: ISO in the future → epoch seconds; absent, invalid or past → GTC (null)", () => {
  const now = Date.parse("2026-11-04T10:00:00Z");
  assert.equal(expirationEpochSeconds("2026-11-04T12:00:00Z", now), Math.floor(Date.parse("2026-11-04T12:00:00Z") / 1000));
  assert.equal(expirationEpochSeconds(null, now), null);
  assert.equal(expirationEpochSeconds("yesterday", now), null);
  assert.equal(expirationEpochSeconds("2026-11-04T09:00:00Z", now), null);
});
