// 2026-11-04 order-entry sweep — pure client rules.
import { afterEach, describe, expect, it, vi } from "vitest";
import { expirationIso, resolveModifyLevels, validateTicket, type TicketDraft } from "./orderTicketRules";
import { normalizeLot, oneClickVolume, partialCloseVolume, stepLot } from "./oneClickMode";
import { closePositionByScope, openMarketByScope } from "./positionActions";
import { symbolTradeSpec } from "@/hooks/useSymbolLotSpec";
import type { Mt5SymbolView } from "./useMt5Symbols";

type Call = { url: string; body: Record<string, unknown> | null };
function stubFetch(answer: (url: string, body: Record<string, unknown> | null) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, body });
    return new Response(JSON.stringify(answer(url, body)));
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

const demoAnswer = (url: string) =>
  url.endsWith("/demo-commands") ? { ok: true, command: { commandId: "D1" } }
    : /\/D1$/.test(url) ? { command: { status: "FILLED_DEMO" } } : { ok: true };
const fastPoll = { pollMs: 0, timeoutMs: 1000, sleep: async () => {} };

describe("lot helpers follow the symbol's volume step", () => {
  const spec = { volumeMin: 0.1, volumeStep: 0.1, volumeMax: 5 };
  it("normalizeLot rounds to the step, raises to the min and clamps to cap/max", () => {
    expect(normalizeLot("0.27", null, spec)).toBe(0.3);
    expect(normalizeLot("0.04", null, spec)).toBe(0.1);
    expect(normalizeLot("9", null, spec)).toBe(5);
    expect(normalizeLot("9", 2, spec)).toBe(2);
    expect(normalizeLot("0.123", null)).toBe(0.12); // unknown spec → 0.01 steps
    expect(normalizeLot("abc", null, spec)).toBeNull();
  });
  it("stepLot never steps below the broker minimum or by less than its step", () => {
    expect(stepLot(0.1, -1, null, spec)).toBe(0.1);
    expect(stepLot(0.1, 1, null, spec)).toBe(0.2);
    expect(stepLot(0.01, -1, null)).toBe(0.01);
  });
  it("partialCloseVolume floors to the step and refuses a sub-minimum leg or remainder", () => {
    expect(partialCloseVolume(0.03, 0.5)).toBe(0.01);         // not the old hard 0.015 → 0.02
    expect(partialCloseVolume(0.5, 0.5, spec)).toBe(0.2);      // 0.25 floored to 0.1 steps
    expect(partialCloseVolume(0.1, 0.5, spec)).toBeNull();     // 0.05 < min
    expect(partialCloseVolume(0.01, 0.5)).toBeNull();
    expect(partialCloseVolume(null, 0.5)).toBeNull();
    expect(partialCloseVolume(1, 1)).toBeNull();               // not a partial
  });
  it("oneClickVolume never exceeds the per-click cap", () => {
    expect(oneClickVolume(0.5, 0.2)).toBe(0.2);
    expect(oneClickVolume(0.1, 0.2)).toBe(0.1);
    expect(oneClickVolume(0.5, null)).toBe(0.5);
  });
  it("symbolTradeSpec reads the EA-enumerated lot and stops rules by broker or display symbol", () => {
    const view = { symbol: "EURUSD", brokerSymbol: "EURUSD.r", displaySymbol: "EUR/USD", minLot: 0.01, lotStep: 0.01, maxLot: 50, point: 0.00001, stopsLevel: 10 } as Mt5SymbolView;
    expect(symbolTradeSpec([view], "FX:EURUSD.r")).toMatchObject({ volumeMin: 0.01, volumeStep: 0.01, volumeMax: 50, stopsLevel: 10 });
    expect(symbolTradeSpec([view], "GBPUSD")).toMatchObject({ volumeMin: null, volumeStep: null });
  });
});

describe("validateTicket with a symbol spec", () => {
  const d = (o: Partial<TicketDraft> = {}): TicketDraft => ({ orderType: "MARKET_BUY", lot: 0.15, price: null, stopLimitPrice: null, stopLoss: null, takeProfit: null, expiration: "GTC", expiresAt: null, ...o });
  it("flags an off-step lot and SL/TP inside the broker stops level", () => {
    const spec = { volumeMin: 0.1, volumeStep: 0.1, point: 0.0001, stopsLevel: 20 };
    const v = validateTicket(d({ stopLoss: 1.0995 }), { bid: 1.1, ask: 1.1001 }, spec);
    expect(v.errors.some((e) => /multiple of 0.1/.test(e))).toBe(true);
    expect(v.errors.some((e) => /at least 20 points/.test(e))).toBe(true);
    expect(validateTicket(d({ lot: 0.2, stopLoss: 1.09 }), { bid: 1.1, ask: 1.1001 }, spec).ok).toBe(true);
  });
});

describe("expiration", () => {
  it("Today ends 23:59 on the broker clock when its offset is known, else UTC", () => {
    const now = new Date("2026-11-04T22:30:00Z");
    expect(expirationIso({ expiration: "TODAY", expiresAt: null }, now)).toBe("2026-11-04T23:59:00.000Z");
    // Broker UTC+2: it is already 00:30 on the 5th there, so "today" ends 2026-11-05 23:59 broker = 21:59Z.
    expect(expirationIso({ expiration: "TODAY", expiresAt: null }, now, 120)).toBe("2026-11-05T21:59:00.000Z");
  });
  it("a Today expiry that has already passed is refused before the click", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T23:59:30Z"));
    try {
      const v = validateTicket({ orderType: "BUY_LIMIT", lot: 0.1, price: 1.09, stopLimitPrice: null, stopLoss: null, takeProfit: null, expiration: "TODAY", expiresAt: null }, { bid: null, ask: null });
      expect(v.errors.some((e) => /trading day has ended/.test(e))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("resolveModifyLevels", () => {
  const base = { side: "BUY" as const, currentPrice: 1.101, current: { stopLoss: 1.095, takeProfit: 1.12 }, slText: "1.095", tpText: "1.12" };
  it("demo: an empty field keeps the current level (the demo EA would otherwise remove it)", () => {
    const r = resolveModifyLevels({ ...base, scope: "demo", slText: "", tpText: "1.13" });
    expect(r).toMatchObject({ error: null, newStopLoss: 1.095, newTakeProfit: 1.13 });
  });
  it("live: an empty field is null (server keeps the position's level)", () => {
    const r = resolveModifyLevels({ ...base, scope: "live", slText: "", tpText: "1.13" });
    expect(r).toMatchObject({ error: null, newStopLoss: null, newTakeProfit: 1.13 });
  });
  it("demo: Remove sends 0; live ignores Remove (the live EA reads 0 as leave)", () => {
    expect(resolveModifyLevels({ ...base, scope: "demo", removeSl: true })).toMatchObject({ error: null, newStopLoss: 0, newTakeProfit: 1.12 });
    expect(resolveModifyLevels({ ...base, scope: "live", removeSl: true }).unchanged).toBe(true);
  });
  it("skips the side check when there is no current price (never checks against entry)", () => {
    const r = resolveModifyLevels({ ...base, scope: "live", currentPrice: null, slText: "1.2" });
    expect(r.error).toBeNull();
    expect(resolveModifyLevels({ ...base, scope: "live", slText: "1.2" }).error).toMatch(/Stop Loss must be below/);
  });
});

describe("positionActions route by the row's account", () => {
  it("live partial close → instant router with closeVolume", async () => {
    const calls = stubFetch(() => ({ ok: true, commandId: "c1" }));
    const r = await closePositionByScope({ scope: "live", ticket: "77", symbol: "EURUSD", side: "BUY", positionVolume: 0.4, closeVolume: 0.2, source: "chart" });
    expect(r).toMatchObject({ ok: true, via: "instant", commandId: "c1" });
    expect(calls[0]!.url).toBe("/api/trades/instant/close");
    expect(calls[0]!.body).toMatchObject({ action: "CLOSE", accountMode: "live", positionId: "77", closeVolume: 0.2 });
    expect(calls[0]!.body).not.toHaveProperty("volume");
  });
  it("live full close sends no closeVolume", async () => {
    const calls = stubFetch(() => ({ ok: true }));
    await closePositionByScope({ scope: "live", ticket: "77", symbol: "EURUSD", side: "BUY", positionVolume: 0.4, source: "chart" });
    expect(calls[0]!.body).not.toHaveProperty("closeVolume");
  });
  it("demo close never reaches the instant router; it runs the demo queue with the lots", async () => {
    const calls = stubFetch(demoAnswer);
    const r = await closePositionByScope({ scope: "demo", ticket: "88", symbol: "EURUSD", side: "SELL", positionVolume: 0.4, closeVolume: 0.2, source: "chart", demoPoll: fastPoll });
    expect(r).toMatchObject({ ok: true, status: "FILLED_DEMO", via: "demo" });
    expect(calls.some((c) => c.url.includes("/trades/instant"))).toBe(false);
    expect(calls[0]!.body).toMatchObject({ commandType: "CLOSE_POSITION", payload: { brokerTicket: "88", volume: 0.2 } });
  });
  it("demo market open goes to the demo queue", async () => {
    const calls = stubFetch(demoAnswer);
    const r = await openMarketByScope({ scope: "demo", symbol: "EURUSD", side: "BUY", volume: 0.1, source: "chart", demoPoll: fastPoll });
    expect(r.ok).toBe(true);
    expect(calls[0]!.body).toMatchObject({ commandType: "PLACE_MARKET_ORDER", payload: { side: "BUY", volume: 0.1, orderType: "MARKET_BUY" } });
  });
});
