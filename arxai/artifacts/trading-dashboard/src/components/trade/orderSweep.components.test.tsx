// @vitest-environment jsdom
// 2026-11-04 order-entry sweep — component behaviour:
//   ModifySlTpDialog remove/unchanged semantics, OpenDemoPositions double-submit,
//   OpenLivePositions confirm when one-click is off, QuickTradePanel one-click
//   wiring + MAX preset, LiveTradeTicket pending fields, LivePendingOrders list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
const modifyPosition = vi.fn(async () => ({ ok: true, status: "sent", reason: null, commandId: "m1", via: "demo" as const }));
vi.mock("@/lib/tradeActions", async (orig) => ({ ...(await orig<typeof import("@/lib/tradeActions")>()), modifyPosition: (...a: unknown[]) => modifyPosition(...(a as [])) }));

const oc = {
  mode: { on: false, scope: "live" as "live" | "demo" | null, canEnable: true, blockReason: null, defaultVolume: 0.01, maxLotPerClick: null as number | null, loading: false },
  busyKey: null, switching: false,
  execute: vi.fn(async () => ({ ok: true, status: "sent", reason: null, commandId: "x" })),
  closePosition: vi.fn(), enable: vi.fn(), disable: vi.fn(), refresh: vi.fn(),
};
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => oc }));
const spec = { volumeMin: null, volumeStep: null, volumeMax: null as number | null, point: null, stopsLevel: null };
vi.mock("@/hooks/useSymbolLotSpec", () => ({ useSymbolLotSpec: () => spec }));
const executeInstantTrade = vi.fn(async () => ({ ok: true, commandId: "c1" }));
vi.mock("@/lib/instantTradeRouter", async (orig) => ({ ...(await orig<typeof import("@/lib/instantTradeRouter")>()), executeInstantTrade: (...a: unknown[]) => executeInstantTrade(...(a as [])) }));
vi.mock("wouter", () => ({ useLocation: () => ["/", vi.fn()] }));
vi.mock("@/components/charts/ChartFeedConfidence", () => ({ ChartFeedConfidence: () => null }));
vi.mock("@/components/positions/PositionMiniChart", () => ({ PositionMiniChart: () => null }));

const { ModifySlTpDialog } = await import("./ModifySlTpDialog");
const { OpenDemoPositions } = await import("@/components/demo/OpenDemoPositions");
const { OpenLivePositions } = await import("@/components/live/OpenLivePositions");
const { QuickTradePanel, quickTradeMaxLot } = await import("@/components/dashboard/trade/QuickTradePanel");
const { LivePendingOrders } = await import("@/components/live/LivePendingOrders");

function withQc(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); toast.mockClear(); modifyPosition.mockClear(); executeInstantTrade.mockClear(); oc.execute.mockClear();
  oc.mode.on = false; oc.mode.maxLotPerClick = null; spec.volumeMax = null;
});

describe("ModifySlTpDialog", () => {
  const demo = { scope: "demo" as const, ticket: "9", symbol: "EURUSD", side: "BUY" as const, entryPrice: 1.1, currentPrice: 1.101, stopLoss: 1.095, takeProfit: 1.12 };
  it("demo: clearing SL keeps the current SL (not removal); only TP changes", async () => {
    render(<ModifySlTpDialog open onOpenChange={() => {}} target={demo} source="chart" />);
    fireEvent.change(screen.getByTestId("modify-sl"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("modify-tp"), { target: { value: "1.13" } });
    fireEvent.click(screen.getByTestId("modify-submit"));
    await waitFor(() => expect(modifyPosition).toHaveBeenCalledTimes(1));
    expect(modifyPosition.mock.calls[0]![0]).toMatchObject({ scope: "demo", newStopLoss: 1.095, newTakeProfit: 1.13 });
  });
  it("demo: Remove SL sends 0", async () => {
    render(<ModifySlTpDialog open onOpenChange={() => {}} target={demo} source="chart" />);
    fireEvent.click(screen.getByTestId("modify-remove-sl"));
    fireEvent.click(screen.getByTestId("modify-submit"));
    await waitFor(() => expect(modifyPosition).toHaveBeenCalledTimes(1));
    expect(modifyPosition.mock.calls[0]![0]).toMatchObject({ newStopLoss: 0, newTakeProfit: 1.12 });
  });
  it("live: Remove is disabled with a note", () => {
    render(<ModifySlTpDialog open onOpenChange={() => {}} target={{ ...demo, scope: "live" }} source="chart" />);
    expect((screen.getByTestId("modify-remove-sl") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("modify-remove-live-note").textContent).toMatch(/not available on live/);
  });
  it("no current price: the side check is skipped (not checked against the entry)", () => {
    render(<ModifySlTpDialog open onOpenChange={() => {}} target={{ ...demo, currentPrice: null, entryPrice: 1.2 }} source="chart" />);
    fireEvent.change(screen.getByTestId("modify-sl"), { target: { value: "1.15" } });
    expect((screen.getByTestId("modify-submit") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("OpenDemoPositions close", () => {
  it("one close in flight per ticket: a second click is ignored and the button is disabled", async () => {
    oc.mode.on = true;
    const posted: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("demo-positions-snapshot")) {
        return new Response(JSON.stringify({ ok: true, positionsMeasured: true, openPositions: [{ brokerTicket: "T1", symbol: "EURUSD", side: "BUY", volume: 0.1, matchStatus: "MATCHED_TO_ARX_COMMAND" }], reconciliation: {} }));
      }
      if (url.endsWith("/demo-commands") && init?.method === "POST") {
        posted.push(String(init.body));
        await gate;
        return new Response(JSON.stringify({ ok: false, reason: "BLOCKED_TEST" }));
      }
      return new Response("{}");
    }));
    render(<OpenDemoPositions />);
    const btn = await screen.findByTestId("demo-close-T1");
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn); });
    expect(posted.length).toBe(1);
    expect((screen.getByTestId("demo-close-T1") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); });
    // The refusal kept the key: a retry reuses the same idempotency key.
    await waitFor(() => expect((screen.getByTestId("demo-close-T1") as HTMLButtonElement).disabled).toBe(false));
    const key1 = JSON.parse(posted[0]!).payload.idempotencyKey;
    await act(async () => { fireEvent.click(screen.getByTestId("demo-close-T1")); });
    await waitFor(() => expect(posted.length).toBe(2));
    expect(JSON.parse(posted[1]!).payload.idempotencyKey).toBe(key1);
  });
});

describe("OpenLivePositions close", () => {
  const live = { items: [{ id: 1, brokerPositionId: "555", symbol: "EURUSD", direction: "BUY", lotSize: 0.1, entryPrice: 1.1, currentPrice: 1.1, stopLoss: null, takeProfit: null, unrealizedProfitLoss: 0, openedAt: null, status: "OPEN" }], count: 1 };
  const stub = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(live))));
  it("one-click OFF: Close asks first, then sends", async () => {
    stub();
    render(withQc(<OpenLivePositions />));
    fireEvent.click(await screen.findByTestId("btn-close-live-1"));
    expect(executeInstantTrade).not.toHaveBeenCalled();
    expect(screen.getByTestId("live-close-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("live-close-confirm-ok"));
    await waitFor(() => expect(executeInstantTrade).toHaveBeenCalledTimes(1));
    expect(executeInstantTrade.mock.calls[0]![0]).toMatchObject({ action: "CLOSE", positionId: "555" });
  });
  it("one-click ON: Close sends on the first click", async () => {
    oc.mode.on = true;
    stub();
    render(withQc(<OpenLivePositions />));
    fireEvent.click(await screen.findByTestId("btn-close-live-1"));
    await waitFor(() => expect(executeInstantTrade).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("live-close-confirm")).toBeNull();
  });
});

describe("QuickTradePanel", () => {
  const noop = () => undefined;
  const panel = () => (
    <QuickTradePanel symbol="EURUSD" setSymbol={noop} timeframe="M15" setTimeframe={noop} orderType="Market" setOrderType={noop}
      lot="0.05" setLot={noop} quote={null} slTpOn setSlTpOn={noop} stopLoss="1.09" setStopLoss={noop} takeProfit="" setTakeProfit={noop}
      riskApprox="—" canTrade blockedLabel="" />
  );
  it("MAX preset only when a cap or broker max is known; it is a number", () => {
    expect(quickTradeMaxLot(null, null)).toBeNull();
    expect(quickTradeMaxLot(0.5, 20)).toBe("0.5");
    render(withQc(panel()));
    expect(screen.queryByTestId("trade-lot-preset-MAX")).toBeNull();
  });
  it("one-click ON: BUY sends a market order with the panel's lot and SL", async () => {
    oc.mode.on = true;
    render(withQc(panel()));
    fireEvent.click(screen.getByTestId("trade-action-buy"));
    await waitFor(() => expect(oc.execute).toHaveBeenCalledTimes(1));
    expect(oc.execute.mock.calls[0]![0]).toMatchObject({ side: "BUY", symbol: "EURUSD", volume: 0.05, stopLoss: 1.09, source: "trade_panel" });
  });
  it("one-click OFF: SELL opens the order window, no order sent", () => {
    render(withQc(panel()));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    fireEvent.click(screen.getByTestId("trade-action-sell"));
    expect(oc.execute).not.toHaveBeenCalled();
    expect(screen.getByTestId("order-ticket")).toBeTruthy();
  });
});

describe("LivePendingOrders", () => {
  it("lists working orders for the chart symbol with Cancel / Modify controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, items: [
      { commandId: "a", orderTicket: "7001", symbol: "EURUSD", side: "BUY", orderType: "BUY_LIMIT", volume: 0.1, price: 1.09, stopLimitPrice: null, stopLoss: null, takeProfit: null, expiration: null, placedAt: null },
      { commandId: "b", orderTicket: "7002", symbol: "XAUUSD", side: "SELL", orderType: "SELL_STOP", volume: 0.1, price: 2300, stopLimitPrice: null, stopLoss: null, takeProfit: null, expiration: null, placedAt: null },
    ] }))));
    render(withQc(<LivePendingOrders symbol="EURUSD" />));
    expect(await screen.findByTestId("live-pending-7001")).toBeTruthy();
    expect(screen.queryByTestId("live-pending-7002")).toBeNull();
    expect(screen.getByTestId("live-pending-note").textContent).not.toMatch(/Cancel or change a live pending order in MT5/);
    expect(screen.getByTestId("live-pending-cancel-7001")).toBeTruthy();
  });
});
