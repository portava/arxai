// @vitest-environment jsdom
// With one-click mode ON, the chart's Buy/Sell buttons ARE the order: one
// execute() call with the default lot, no ticket opened. A setup-preview
// prefill still opens the ticket for review. With the mode OFF the ticket
// opens as before and nothing executes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/components/charts/ChartFeedConfidence", () => ({ ChartFeedConfidence: () => null }));
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["FX:EURUSD", () => {}],
  bareSymbol: (s: string) => s.replace(/^.*:/, ""),
}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({ useMasterLiveAccess: () => ({ loaded: true, canTrade: false }) }));
const ticketOpens: boolean[] = [];
vi.mock("@/components/live/LiveTradeTicket", () => ({ LiveTradeTicket: ({ open }: { open: boolean }) => { ticketOpens.push(open); return open ? <div data-testid="ticket-open" /> : null; } }));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({ LiveSharedTradeTicket: () => null }));
vi.mock("@/components/news/EventImpactBadge", () => ({ EventImpactBadge: () => null }));
vi.mock("@/components/news/HighImpactEventBanner", () => ({ HighImpactEventBanner: () => null }));

const oc = {
  mode: { on: true, scope: "live" as "live" | "demo" | null, canEnable: true, blockReason: null, defaultVolume: 0.1, maxLotPerClick: null, loading: false },
  busyKey: null,
  switching: false,
  execute: vi.fn(async () => ({ ok: true, status: "sent", reason: null, commandId: "c" })),
  closePosition: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
};
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => oc }));

import { ChartTradeEntry } from "./ChartTradeEntry";

afterEach(() => { cleanup(); toast.mockReset(); oc.execute.mockClear(); ticketOpens.length = 0; oc.mode = { ...oc.mode, on: true }; });

describe("ChartTradeEntry in one-click mode", () => {
  it("Sell executes immediately with the default lot and opens no ticket", async () => {
    render(<ChartTradeEntry />);
    expect(screen.getByTestId("chart-trade-entry-mode").textContent).toMatch(/One-click ON: Buy\/Sell execute immediately \(0.1 lot, LIVE\)/);
    fireEvent.click(screen.getByTestId("btn-chart-open-sell"));
    await waitFor(() => expect(oc.execute).toHaveBeenCalledWith({ side: "SELL", symbol: "EURUSD", volume: 0.1, source: "chart" }));
    expect(screen.queryByTestId("ticket-open")).toBeNull();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "SELL EURUSD 0.1" })));
  });

  it("a blocked one-click is reported as blocked", async () => {
    oc.execute.mockResolvedValueOnce({ ok: false, status: "LIVE_ONE_CLICK_DISABLED", reason: "LIVE_ONE_CLICK_DISABLED", commandId: null });
    render(<ChartTradeEntry />);
    fireEvent.click(screen.getByTestId("btn-chart-open-buy"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "BUY blocked", variant: "destructive" })));
    expect(screen.queryByTestId("ticket-open")).toBeNull();
  });

  it("a setup-preview prefill still opens the ticket for review, never auto-fires", async () => {
    render(<ChartTradeEntry prefill={{ token: 1, side: "BUY", stopLoss: 1.07, takeProfit: 1.1 }} />);
    await waitFor(() => expect(screen.getByTestId("ticket-open")).toBeTruthy());
    expect(oc.execute).not.toHaveBeenCalled();
  });

  it("mode OFF: Buy opens the ticket and executes nothing", async () => {
    oc.mode = { ...oc.mode, on: false };
    render(<ChartTradeEntry />);
    expect(screen.getByTestId("chart-trade-entry-mode").textContent).toMatch(/Final confirmation required/);
    fireEvent.click(screen.getByTestId("btn-chart-open-buy"));
    await waitFor(() => expect(screen.getByTestId("ticket-open")).toBeTruthy());
    expect(oc.execute).not.toHaveBeenCalled();
  });
});
