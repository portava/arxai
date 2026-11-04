// MT5 order-ticket rules (client mirror of the server's pendingOrderRules).
import { describe, expect, it } from "vitest";
import { ORDER_TYPE_INFO, expirationIso, isPendingType, parseNum, validateModify, validateTicket, type TicketDraft } from "./orderTicketRules";

const q = { bid: 1.1000, ask: 1.1002 };
const base: TicketDraft = { orderType: "MARKET_BUY", lot: 0.1, price: null, stopLimitPrice: null, stopLoss: null, takeProfit: null, expiration: "GTC", expiresAt: null };

describe("order types", () => {
  it("lists the eight MT5 types with MT5 button wording", () => {
    expect(ORDER_TYPE_INFO.map((o) => o.label)).toEqual([
      "Buy by Market", "Sell by Market", "Buy Limit", "Sell Limit", "Buy Stop", "Sell Stop", "Buy Stop Limit", "Sell Stop Limit",
    ]);
    expect(isPendingType("MARKET_SELL")).toBe(false);
    expect(isPendingType("SELL_STOP_LIMIT")).toBe(true);
  });
});

describe("validateTicket — MT5 side rules", () => {
  it("market orders need only a lot; SL/TP are checked against the exit side", () => {
    expect(validateTicket(base, q).ok).toBe(true);
    expect(validateTicket({ ...base, lot: null }, q).errors[0]).toMatch(/lot size/);
    // Buy: SL below Bid, TP above Bid.
    expect(validateTicket({ ...base, stopLoss: 1.1050 }, q).errors[0]).toMatch(/Stop Loss must be below/);
    expect(validateTicket({ ...base, takeProfit: 1.0900 }, q).errors[0]).toMatch(/Take Profit must be above/);
    expect(validateTicket({ ...base, stopLoss: 1.0950, takeProfit: 1.1100 }, q).ok).toBe(true);
  });
  it("Buy Limit below Ask, Buy Stop above Ask, Sell Limit above Bid, Sell Stop below Bid", () => {
    expect(validateTicket({ ...base, orderType: "BUY_LIMIT", price: 1.0990 }, q).ok).toBe(true);
    expect(validateTicket({ ...base, orderType: "BUY_LIMIT", price: 1.1010 }, q).errors[0]).toMatch(/Buy Limit price must be below the Ask/);
    expect(validateTicket({ ...base, orderType: "BUY_STOP", price: 1.1010 }, q).ok).toBe(true);
    expect(validateTicket({ ...base, orderType: "BUY_STOP", price: 1.0990 }, q).errors[0]).toMatch(/Buy Stop price must be above the Ask/);
    expect(validateTicket({ ...base, orderType: "SELL_LIMIT", price: 1.1010 }, q).ok).toBe(true);
    expect(validateTicket({ ...base, orderType: "SELL_LIMIT", price: 1.0990 }, q).errors[0]).toMatch(/Sell Limit price must be above the Bid/);
    expect(validateTicket({ ...base, orderType: "SELL_STOP", price: 1.0990 }, q).ok).toBe(true);
    expect(validateTicket({ ...base, orderType: "SELL_STOP", price: 1.1010 }, q).errors[0]).toMatch(/Sell Stop price must be below the Bid/);
    expect(validateTicket({ ...base, orderType: "SELL_STOP", price: null }, q).errors[0]).toMatch(/needs a price/);
  });
  it("stop limit: limit leg below the stop for a Buy, above for a Sell; SL/TP checked against the limit price", () => {
    const buy = { ...base, orderType: "BUY_STOP_LIMIT" as const, price: 1.1010, stopLimitPrice: 1.1005 };
    expect(validateTicket(buy, q).ok).toBe(true);
    expect(validateTicket({ ...buy, stopLimitPrice: 1.1015 }, q).errors[0]).toMatch(/limit price must be below the stop/);
    expect(validateTicket({ ...buy, stopLimitPrice: null }, q).errors[0]).toMatch(/needs the limit price/);
    expect(validateTicket(buy, q).reference).toBe(1.1005);
    const sell = { ...base, orderType: "SELL_STOP_LIMIT" as const, price: 1.0990, stopLimitPrice: 1.0995 };
    expect(validateTicket(sell, q).ok).toBe(true);
    expect(validateTicket({ ...sell, stopLimitPrice: 1.0980 }, q).errors[0]).toMatch(/limit price must be above the stop/);
  });
  it("pending SL/TP are checked against the pending price and give a risk:reward", () => {
    const v = validateTicket({ ...base, orderType: "BUY_LIMIT", price: 1.0990, stopLoss: 1.0940, takeProfit: 1.1090 }, q);
    expect(v.ok).toBe(true);
    expect(v.riskReward).toBe(2);
    expect(validateTicket({ ...base, orderType: "SELL_LIMIT", price: 1.1010, stopLoss: 1.1000 }, q).errors[0]).toMatch(/Stop Loss must be above/);
  });
  it("without a quote the side check is left to the broker, but a missing price is still refused", () => {
    expect(validateTicket({ ...base, orderType: "BUY_LIMIT", price: 5 }, { bid: null, ask: null }).ok).toBe(true);
    expect(validateTicket({ ...base, orderType: "BUY_LIMIT", price: null }, { bid: null, ask: null }).ok).toBe(false);
  });
  it("a specified expiry must be a future time", () => {
    const d = { ...base, orderType: "BUY_LIMIT" as const, price: 1.0990, expiration: "SPECIFIED" as const };
    expect(validateTicket({ ...d, expiresAt: null }, q).errors[0]).toMatch(/Pick an expiry/);
    expect(validateTicket({ ...d, expiresAt: "2000-01-01T00:00:00Z" }, q).errors[0]).toMatch(/future/);
    expect(validateTicket({ ...d, expiresAt: new Date(Date.now() + 3600_000).toISOString() }, q).ok).toBe(true);
  });
});

describe("expirationIso", () => {
  it("GTC → null, Today → end of today UTC, Specified → the ISO given", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    expect(expirationIso({ expiration: "GTC", expiresAt: null }, now)).toBeNull();
    expect(expirationIso({ expiration: "TODAY", expiresAt: null }, now)).toBe("2026-11-04T23:59:00.000Z");
    expect(expirationIso({ expiration: "SPECIFIED", expiresAt: "2026-11-05T08:00:00Z" }, now)).toBe("2026-11-05T08:00:00.000Z");
    expect(expirationIso({ expiration: "SPECIFIED", expiresAt: "nope" }, now)).toBeNull();
  });
});

describe("validateModify — open position SL/TP", () => {
  it("needs at least one level; Buy SL below / TP above price, Sell the reverse", () => {
    expect(validateModify({ side: "BUY", reference: 1.1, newStopLoss: null, newTakeProfit: null }).error).toMatch(/Enter a new/);
    expect(validateModify({ side: "BUY", reference: 1.1, newStopLoss: 1.09, newTakeProfit: 1.12 }).ok).toBe(true);
    expect(validateModify({ side: "BUY", reference: 1.1, newStopLoss: 1.11, newTakeProfit: null }).error).toMatch(/below/);
    expect(validateModify({ side: "SELL", reference: 1.1, newStopLoss: null, newTakeProfit: 1.12 }).error).toMatch(/below/);
    expect(validateModify({ side: "SELL", reference: 1.1, newStopLoss: 1.11, newTakeProfit: 1.08 }).ok).toBe(true);
    expect(validateModify({ side: "SELL", reference: null, newStopLoss: 1.0, newTakeProfit: null }).ok).toBe(true);
  });
  it("parseNum accepts positive numbers only", () => {
    expect(parseNum(" 1.5 ")).toBe(1.5);
    expect(parseNum("")).toBeNull();
    expect(parseNum("-1")).toBeNull();
    expect(parseNum("abc")).toBeNull();
  });
});
