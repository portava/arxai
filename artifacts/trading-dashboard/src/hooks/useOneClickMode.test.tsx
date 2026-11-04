// @vitest-environment jsdom
// What the one-click hook actually sends: live enable = arm, live disable =
// disarm + clear the live flag, demo = PUT scope flag, live execute = the
// instant-trade router with oneClick:true, demo execute = the demo command
// chain. Nothing here reaches a server; fetch is stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const trading = { isLiveShared: true, isDemo: false, isLoading: false };
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => trading }));

import { useOneClickMode } from "./useOneClickMode";

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let settingsBody: Record<string, unknown> = {};
let statusBody: Record<string, unknown> = {};
let demoTerminal = "FILLED_DEMO";

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: unknown = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = String(init?.body); }
    calls.push({ url, method, body });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.endsWith("/api/me/one-click") && method === "GET") return json(settingsBody);
    if (url.endsWith("/api/me/one-click/status")) return json(statusBody);
    if (url.endsWith("/api/me/one-click/arm")) return json({ ok: true, armed: true });
    if (url.endsWith("/api/me/one-click/disarm")) return json({ ok: true, armed: false });
    if (url.endsWith("/api/me/one-click") && method === "PUT") return json({ ok: true });
    if (url.endsWith("/api/trades/instant/execute")) return json({ ok: true, action: body && (body as { action: string }).action, commandId: "live-1" });
    if (url.endsWith("/api/trades/instant/close")) return json({ ok: false, error: "LIVE_ONE_CLICK_DISABLED", primaryReason: "LIVE_ONE_CLICK_DISABLED" }, 412);
    if (url.endsWith("/api/me/demo-commands")) return json({ ok: true, command: { commandId: "d-1" } });
    if (url.endsWith("/confirm") || url.endsWith("/dispatch")) return json({ ok: true });
    if (url.includes("/api/me/demo-commands/")) return json({ command: { status: demoTerminal, reason: null } });
    return json({}, 404);
  }));
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useOneClickMode(), { wrapper });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); calls = []; trading.isLiveShared = true; trading.isDemo = false; demoTerminal = "FILLED_DEMO"; });

describe("useOneClickMode (live)", () => {
  it("derives ON from armed + access, enable() arms with agreed:true, disable() disarms and clears the live flag", async () => {
    settingsBody = { ok: true, oneClickArmed: false, liveOneClickEnabled: false, canEnableLive: true, defaultVolume: 0.1 };
    statusBody = { armed: false, canArm: true, bridgeType: "OWN" };
    stubFetch();
    const { result } = setup();
    await waitFor(() => expect(result.current.mode.loading).toBe(false));
    expect(result.current.mode).toMatchObject({ on: false, scope: "live", canEnable: true });

    settingsBody = { ...settingsBody, oneClickArmed: true };
    let r!: { ok: boolean; error: string | null };
    await act(async () => { r = await result.current.enable(); });
    expect(r).toEqual({ ok: true, error: null });
    expect(calls.find((c) => c.url.endsWith("/api/me/one-click/arm"))).toMatchObject({ method: "POST", body: { agreed: true } });
    await waitFor(() => expect(result.current.mode.on).toBe(true));

    calls = [];
    await act(async () => { r = await result.current.disable(); });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/api/me/one-click/disarm") && c.method === "POST")).toBe(true);
    expect(calls.find((c) => c.url.endsWith("/api/me/one-click") && c.method === "PUT")).toMatchObject({ body: { scope: "live", enable: false } });
  });

  it("execute() refuses while OFF, and ON sends one instant-trade market order with oneClick:true", async () => {
    settingsBody = { ok: true, oneClickArmed: false, canEnableLive: true, defaultVolume: 0.1 };
    statusBody = { armed: false, canArm: true };
    stubFetch();
    const { result } = setup();
    await waitFor(() => expect(result.current.mode.loading).toBe(false));
    let r!: Awaited<ReturnType<typeof result.current.execute>>;
    await act(async () => { r = await result.current.execute({ side: "BUY", symbol: "EURUSD", volume: 0.2, source: "chart" }); });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("ONE_CLICK_OFF");
    expect(calls.some((c) => c.url.includes("/api/trades/instant"))).toBe(false);

    settingsBody = { ...settingsBody, oneClickArmed: true };
    await act(async () => { await result.current.refresh(); });
    await waitFor(() => expect(result.current.mode.on).toBe(true));
    await act(async () => { r = await result.current.execute({ side: "SELL", symbol: "EURUSD", volume: 0.2, source: "chart" }); });
    expect(r).toMatchObject({ ok: true, status: "sent", commandId: "live-1" });
    const exec = calls.filter((c) => c.url.endsWith("/api/trades/instant/execute"));
    expect(exec).toHaveLength(1);
    expect(exec[0].body).toMatchObject({ source: "chart", action: "SELL", accountMode: "live", symbol: "EURUSD", volume: 0.2, orderType: "MARKET_SELL", oneClick: true });
  });

  it("closePosition() goes through the instant close route and surfaces the server's refusal", async () => {
    settingsBody = { ok: true, oneClickArmed: true, canEnableLive: true };
    statusBody = { armed: true, canArm: true };
    stubFetch();
    const { result } = setup();
    await waitFor(() => expect(result.current.mode.on).toBe(true));
    let r!: Awaited<ReturnType<typeof result.current.closePosition>>;
    await act(async () => { r = await result.current.closePosition({ ticket: "77", symbol: "EURUSD", source: "chart" }); });
    expect(r).toMatchObject({ ok: false, status: "LIVE_ONE_CLICK_DISABLED", reason: "LIVE_ONE_CLICK_DISABLED" });
    expect(calls.find((c) => c.url.endsWith("/api/trades/instant/close"))?.body).toMatchObject({ action: "CLOSE", accountMode: "live", positionId: "77", oneClick: true });
  });
});

describe("useOneClickMode (demo)", () => {
  it("enable() PUTs the demo flag, never arms; execute() runs the demo chain and reports the terminal status", async () => {
    trading.isLiveShared = false; trading.isDemo = true;
    settingsBody = { ok: true, demoOneClickEnabled: false, defaultVolume: 0.05 };
    stubFetch();
    const { result } = setup();
    await waitFor(() => expect(result.current.mode.loading).toBe(false));
    expect(result.current.mode).toMatchObject({ on: false, scope: "demo", canEnable: true, defaultVolume: 0.05 });
    expect(calls.some((c) => c.url.endsWith("/one-click/status"))).toBe(false); // status is a live-arm concept

    settingsBody = { ...settingsBody, demoOneClickEnabled: true };
    await act(async () => { await result.current.enable(); });
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({ body: { scope: "demo", enable: true } });
    expect(calls.some((c) => c.url.endsWith("/arm"))).toBe(false);
    await waitFor(() => expect(result.current.mode.on).toBe(true));

    let r!: Awaited<ReturnType<typeof result.current.execute>>;
    await act(async () => { r = await result.current.execute({ side: "BUY", symbol: "XAUUSD", volume: 0.05, source: "chart" }); });
    expect(r).toMatchObject({ ok: true, status: "FILLED_DEMO", commandId: "d-1" });
    const draft = calls.find((c) => c.url.endsWith("/api/me/demo-commands") && c.method === "POST");
    expect(draft?.body).toMatchObject({ commandType: "PLACE_MARKET_ORDER", payload: { symbol: "XAUUSD", side: "BUY", volume: 0.05, orderType: "MARKET_BUY", sourcePage: "ONE_CLICK_CHART" } });
    expect(calls.some((c) => c.url.includes("/api/trades/instant"))).toBe(false);
  }, 15_000);

  it("closePosition() drafts a CLOSE_POSITION demo command carrying the ticket", async () => {
    trading.isLiveShared = false; trading.isDemo = true;
    settingsBody = { ok: true, demoOneClickEnabled: true };
    demoTerminal = "REJECTED";
    stubFetch();
    const { result } = setup();
    await waitFor(() => expect(result.current.mode.on).toBe(true));
    let r!: Awaited<ReturnType<typeof result.current.closePosition>>;
    await act(async () => { r = await result.current.closePosition({ ticket: "501", symbol: "XAUUSD", side: "SELL", volume: 0.1, source: "chart" }); });
    expect(r).toMatchObject({ ok: false, status: "REJECTED", commandId: "d-1" });
    const draft = calls.find((c) => c.url.endsWith("/api/me/demo-commands") && c.method === "POST");
    expect(draft?.body).toMatchObject({ commandType: "CLOSE_POSITION", payload: { brokerTicket: "501", ticket: "501", positionTicket: "501", symbol: "XAUUSD" } });
  }, 15_000);
});
