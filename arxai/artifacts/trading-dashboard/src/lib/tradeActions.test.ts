// tradeActions: which gated route each order takes, and what it carries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_PENDING_UNSUPPORTED_NOTE, cancelDemoPendingOrder, demoRefusalText, modifyPosition, placeOrder } from "./tradeActions";
import type { TicketDraft } from "./orderTicketRules";

const draft = (over: Partial<TicketDraft> = {}): TicketDraft => ({
  orderType: "BUY_LIMIT", lot: 0.2, price: 1.0990, stopLimitPrice: null, stopLoss: 1.0940, takeProfit: 1.1090, expiration: "GTC", expiresAt: null, ...over,
});

type Call = { url: string; body: Record<string, unknown> | null };
function stubFetch(answer: (url: string, body: Record<string, unknown> | null) => unknown) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    return new Response(JSON.stringify(answer(url, body)));
  });
  vi.stubGlobal("fetch", f);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("placeOrder", () => {
  it("live + one-click ON: instant router carries orderType, price, SL/TP and expiration", async () => {
    const calls = stubFetch(() => ({ ok: true, commandId: "c1" }));
    const r = await placeOrder({ scope: "live", symbol: "EURUSD", draft: draft({ expiration: "SPECIFIED", expiresAt: "2030-01-01T00:00:00.000Z" }), source: "chart", oneClickOn: true });
    expect(r).toMatchObject({ ok: true, status: "sent", commandId: "c1", via: "instant" });
    expect(calls[0]!.url).toBe("/api/trades/instant/execute");
    expect(calls[0]!.body).toMatchObject({
      action: "BUY", orderType: "BUY_LIMIT", price: 1.0990, stopLoss: 1.0940, takeProfit: 1.1090, volume: 0.2, oneClick: true,
      expiration: "2030-01-01T00:00:00.000Z", stopLimitPrice: null,
    });
  });
  it("live + one-click ON refusal surfaces the server's code", async () => {
    stubFetch(() => ({ ok: false, error: "PENDING_PRICE_WRONG_SIDE", primaryReason: "PENDING_PRICE_WRONG_SIDE" }));
    const r = await placeOrder({ scope: "live", symbol: "EURUSD", draft: draft(), source: "chart", oneClickOn: true });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("PENDING_PRICE_WRONG_SIDE");
  });
  it("live + one-click OFF: standard draft → confirm → dispatch, pending fields in payload", async () => {
    const calls = stubFetch((url) => url.endsWith("/commands") ? { ok: true, command: { commandId: "L9" } } : { ok: true });
    const r = await placeOrder({ scope: "live", symbol: "XAUUSD", draft: draft({ orderType: "SELL_STOP_LIMIT", price: 2390, stopLimitPrice: 2392, stopLoss: 2400, takeProfit: 2350 }), source: "trade_panel", oneClickOn: false });
    expect(r).toMatchObject({ ok: true, via: "standard", commandId: "L9" });
    expect(calls.map((c) => c.url)).toEqual(["/api/me/live/commands", "/api/me/live/commands/L9/confirm", "/api/me/live/commands/L9/dispatch"]);
    expect(calls[0]!.body).toMatchObject({
      commandType: "PLACE_LIVE_PENDING_ORDER", side: "SELL", orderType: "SELL_STOP_LIMIT", requestedVolume: 0.2, stopLoss: 2400, takeProfit: 2350,
      payload: { price: 2390, stopLimitPrice: 2392, expiration: null, expirationEpoch: null },
    });
  });
  it("live + one-click OFF market order uses PLACE_LIVE_MARKET_ORDER and reports a blocked dispatch", async () => {
    const calls = stubFetch((url) => url.endsWith("/commands") ? { ok: true, command: { commandId: "L1" } } : url.endsWith("/dispatch") ? { ok: false, reason: "LIVE_BLOCKED: spread" } : { ok: true });
    const r = await placeOrder({ scope: "live", symbol: "EURUSD", draft: draft({ orderType: "MARKET_SELL", price: null }), source: "chart", oneClickOn: false });
    expect(calls[0]!.body).toMatchObject({ commandType: "PLACE_LIVE_MARKET_ORDER", side: "SELL", payload: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("LIVE_BLOCKED: spread");
  });
  it("demo market order goes through the governed demo queue with lotSize", async () => {
    const calls = stubFetch((url) => url.endsWith("/api/me/demo-commands") ? { ok: true, command: { commandId: "D1" } } : url.endsWith("/D1") ? { command: { status: "FILLED_DEMO" } } : { ok: true });
    const r = await placeOrder({ scope: "demo", symbol: "EURUSD", draft: draft({ orderType: "MARKET_BUY", price: null }), source: "chart", oneClickOn: true });
    expect(r).toMatchObject({ ok: true, status: "FILLED_DEMO", via: "demo" });
    expect(calls[0]!.body).toMatchObject({ commandType: "PLACE_MARKET_ORDER", payload: { symbol: "EURUSD", lotSize: 0.2, side: "BUY", orderType: "MARKET_BUY" } });
  });
  it("demo pending orders go to the governed queue with entry, stop-limit and expiry; PLACED_DEMO is success", async () => {
    const calls = stubFetch((url) => url.endsWith("/api/me/demo-commands") ? { ok: true, command: { commandId: "D2" } } : url.endsWith("/D2") ? { command: { status: "PLACED_DEMO" } } : { ok: true });
    const r = await placeOrder({ scope: "demo", symbol: "EURUSD", draft: draft({ orderType: "BUY_STOP_LIMIT", price: 1.105, stopLimitPrice: 1.103, expiration: "SPECIFIED", expiresAt: "2030-01-01T00:00:00.000Z" }), source: "chart", oneClickOn: false });
    expect(r).toMatchObject({ ok: true, status: "PLACED_DEMO", via: "demo" });
    expect(calls[0]!.body).toMatchObject({
      commandType: "PLACE_PENDING_ORDER",
      payload: { symbol: "EURUSD", lotSize: 0.2, side: "BUY", orderType: "BUY_STOP_LIMIT", price: 1.105, entry: 1.105, stopLimitPrice: 1.103, expirationEpoch: Date.parse("2030-01-01T00:00:00.000Z") / 1000 },
    });
  });
  it("demo pending refused by the server's EA version gate shows the corrected note", async () => {
    stubFetch((url) => url.endsWith("/api/me/demo-commands") ? { ok: false, reason: "EA_VERSION_TOO_OLD_FOR_COMMAND:PLACE_PENDING_ORDER:1.31<1.32" } : { ok: true });
    const r = await placeOrder({ scope: "demo", symbol: "EURUSD", draft: draft(), source: "chart", oneClickOn: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(DEMO_PENDING_UNSUPPORTED_NOTE);
    expect(DEMO_PENDING_UNSUPPORTED_NOTE).toContain("REJECTED_UNKNOWN_COMMAND_TYPE");
    expect(demoRefusalText("RISK_GATE_FAILED:x")).toBe("RISK_GATE_FAILED:x");
  });
  it("cancelDemoPendingOrder queues CANCEL_PENDING_ORDER with the order ticket", async () => {
    const calls = stubFetch((url) => url.endsWith("/api/me/demo-commands") ? { ok: true, command: { commandId: "D3" } } : url.endsWith("/D3") ? { command: { status: "CANCELLED_DEMO" } } : { ok: true });
    const r = await cancelDemoPendingOrder({ orderTicket: "5001", symbol: "EURUSD" });
    expect(r).toMatchObject({ ok: true, status: "CANCELLED_DEMO" });
    expect(calls[0]!.body).toMatchObject({ commandType: "CANCEL_PENDING_ORDER", payload: { symbol: "EURUSD", orderTicket: "5001", ticket: "5001" } });
  });
});

describe("modifyPosition", () => {
  it("live → instant router MODIFY_SL_TP with positionId", async () => {
    const calls = stubFetch(() => ({ ok: true, commandId: "m1" }));
    const r = await modifyPosition({ scope: "live", ticket: "555", symbol: "EURUSD", side: "BUY", newStopLoss: 1.09, newTakeProfit: null, source: "position_card" });
    expect(r.ok).toBe(true);
    expect(calls[0]!.url).toBe("/api/trades/instant/execute");
    expect(calls[0]!.body).toMatchObject({ action: "MODIFY_SL_TP", positionId: "555", newStopLoss: 1.09, newTakeProfit: null });
  });
  it("demo → demo queue MODIFY_SLTP carrying the ticket under the keys the consumer reads", async () => {
    const calls = stubFetch((url) => url.endsWith("/api/me/demo-commands") ? { ok: true, command: { commandId: "D2" } } : url.endsWith("/D2") ? { command: { status: "FILLED_DEMO" } } : { ok: true });
    const r = await modifyPosition({ scope: "demo", ticket: "777", symbol: "EURUSD", side: "SELL", newStopLoss: 1.11, newTakeProfit: 1.08, source: "chart" });
    expect(r.ok).toBe(true);
    expect(calls[0]!.body).toMatchObject({ commandType: "MODIFY_SLTP", payload: { ticket: "777", positionTicket: "777", stopLoss: 1.11, takeProfit: 1.08 } });
  });
});
