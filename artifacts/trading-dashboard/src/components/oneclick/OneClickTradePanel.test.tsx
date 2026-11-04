// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChartPosition } from "@/hooks/useLivePositionOverlays";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const ocState: {
  mode: { on: boolean; scope: "live" | "demo" | null; canEnable: boolean; blockReason: string | null; defaultVolume: number; maxLotPerClick: number | null; loading: boolean };
  busyKey: string | null;
  switching: boolean;
  execute: ReturnType<typeof vi.fn>;
  closePosition: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
} = {
  mode: { on: true, scope: "live", canEnable: true, blockReason: null, defaultVolume: 0.1, maxLotPerClick: 2, loading: false },
  busyKey: null,
  switching: false,
  execute: vi.fn(async () => ({ ok: true, status: "sent", reason: null, commandId: "x" })),
  closePosition: vi.fn(async () => ({ ok: true, status: "sent", reason: null, commandId: "y" })),
  enable: vi.fn(async () => ({ ok: true, error: null })),
  disable: vi.fn(async () => ({ ok: true, error: null })),
};
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => ocState }));

import { OneClickTradePanel, quoteReady } from "./OneClickTradePanel";

const freshQuote = { symbol: "EURUSD", bid: 1.08412, ask: 1.08425, last: 1.0842, available: true, stale: false, ageMs: 1500, source: "mt5-ea" };

function stubQuote(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
}

function renderPanel(positions: ChartPosition[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPositionsChanged = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <OneClickTradePanel symbol="EURUSD" positions={positions} onPositionsChanged={onPositionsChanged} />
    </QueryClientProvider>,
  );
  return { onPositionsChanged };
}

const pos: ChartPosition = {
  scope: "live", brokerTicket: "8812", symbol: "EURUSD", side: "BUY", lotSize: 0.2, entryPrice: 1.08, currentPrice: 1.0842,
  stopLoss: null, takeProfit: null, floatingPnl: 12.4, accountMode: "LIVE",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); toast.mockReset(); ocState.execute.mockClear(); ocState.closePosition.mockClear(); ocState.mode = { ...ocState.mode, on: true, scope: "live", canEnable: true, blockReason: null }; });

describe("quoteReady", () => {
  it("needs a price, a bid/ask and a fresh observation", () => {
    expect(quoteReady(null).ok).toBe(false);
    expect(quoteReady({ available: false, observationNote: "feed down" })).toEqual({ ok: false, why: "feed down" });
    expect(quoteReady({ available: true, bid: 1, ask: null, last: null }).ok).toBe(false);
    expect(quoteReady({ available: true, bid: 1, ask: 1.1, stale: true }).why).toMatch(/stale/i);
    expect(quoteReady(freshQuote).ok).toBe(true);
  });
});

describe("OneClickTradePanel", () => {
  it("mode OFF: shows only the turn-on button, which opens the disclaimer", async () => {
    ocState.mode = { ...ocState.mode, on: false };
    stubQuote(freshQuote);
    renderPanel();
    expect(screen.getByTestId("one-click-panel-off")).toBeTruthy();
    expect(screen.queryByTestId("one-click-buy")).toBeNull();
    fireEvent.click(screen.getByTestId("one-click-panel-turn-on"));
    await waitFor(() => expect(screen.getByTestId("one-click-disclaimer")).toBeTruthy());
    // Accept is locked until the checkbox is ticked.
    expect((screen.getByTestId("one-click-disclaimer-accept") as HTMLButtonElement).disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled(); // no quote polling while OFF
  });

  it("mode ON: shows bid on SELL and ask on BUY, and BUY fires one execute with the typed lot", async () => {
    stubQuote(freshQuote);
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("one-click-ask").textContent).toBe("1.08425"));
    expect(screen.getByTestId("one-click-bid").textContent).toBe("1.08412");
    expect((screen.getByTestId("one-click-lot") as HTMLInputElement).value).toBe("0.1");

    fireEvent.change(screen.getByTestId("one-click-lot"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByTestId("one-click-buy"));
    await waitFor(() => expect(ocState.execute).toHaveBeenCalledTimes(1));
    expect(ocState.execute).toHaveBeenCalledWith({ side: "BUY", symbol: "EURUSD", volume: 0.5, source: "chart" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "BUY EURUSD 0.5" })));
  });

  it("a stale quote disables both buttons and says why", async () => {
    stubQuote({ ...freshQuote, stale: true, ageMs: 40_000 });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("one-click-not-ready")).toBeTruthy());
    expect((screen.getByTestId("one-click-buy") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("one-click-sell") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("one-click-sell"));
    expect(ocState.execute).not.toHaveBeenCalled();
  });

  it("lot +/- step the lot and the cap is respected", async () => {
    stubQuote(freshQuote);
    renderPanel();
    await waitFor(() => expect((screen.getByTestId("one-click-lot") as HTMLInputElement).value).toBe("0.1"));
    fireEvent.click(screen.getByTestId("one-click-lot-plus"));
    expect((screen.getByTestId("one-click-lot") as HTMLInputElement).value).toBe("0.2");
    fireEvent.change(screen.getByTestId("one-click-lot"), { target: { value: "1.95" } });
    fireEvent.click(screen.getByTestId("one-click-lot-plus"));
    expect((screen.getByTestId("one-click-lot") as HTMLInputElement).value).toBe("2");
  });

  it("× closes the position on the first click and refreshes positions", async () => {
    stubQuote(freshQuote);
    const { onPositionsChanged } = renderPanel([pos, { ...pos, brokerTicket: "9", scope: "demo", accountMode: "DEMO" }]);
    // Only this scope's positions are listed (live), so the demo row is absent.
    expect(screen.queryByTestId("one-click-close-9")).toBeNull();
    fireEvent.click(screen.getByTestId("one-click-close-8812"));
    await waitFor(() => expect(ocState.closePosition).toHaveBeenCalledWith({ ticket: "8812", symbol: "EURUSD", side: "BUY", volume: 0.2, source: "chart" }));
    await waitFor(() => expect(onPositionsChanged).toHaveBeenCalled());
  });

  it("a blocked click shows the server's reason, never a success", async () => {
    stubQuote(freshQuote);
    ocState.execute.mockResolvedValueOnce({ ok: false, status: "LIVE_ONE_CLICK_DISABLED", reason: "LIVE_ONE_CLICK_DISABLED", commandId: null });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("one-click-ask").textContent).toBe("1.08425"));
    fireEvent.click(screen.getByTestId("one-click-sell"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "SELL blocked", variant: "destructive" })));
  });
});
