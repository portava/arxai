import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const context = vi.hoisted(() => ({ symbol: "V75" }));
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => [context.symbol],
  bareSymbol: (s: string) => s,
}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ loaded: true, canTrade: false }),
}));
vi.mock("@/hooks/useOneClickMode", () => ({
  useOneClickMode: () => ({
    mode: { on: false, scope: null, canEnable: false, blockReason: null, defaultVolume: 0, maxLotPerClick: null, loading: false },
    settings: null, status: null, switching: false, busyKey: null,
    enable: vi.fn(), disable: vi.fn(), execute: vi.fn(), closePosition: vi.fn(), refresh: vi.fn(),
  }),
}));
vi.mock("@/components/charts/ChartFeedConfidence", () => ({
  ChartFeedConfidence: () => null,
}));
vi.mock("@/components/news/EventImpactBadge", () => ({
  EventImpactBadge: () => null,
}));
vi.mock("@/components/news/HighImpactEventBanner", () => ({
  HighImpactEventBanner: () => null,
}));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({
  LiveSharedTradeTicket: () => null,
}));
vi.mock("@/components/live/LiveTradeTicket", () => ({
  LiveTradeTicket: (p: any) =>
    p.open ? (
      <output data-testid="ticket">
        {JSON.stringify({
          symbol: p.defaultSymbol,
          side: p.defaultSide,
          sl: p.prefillSltp?.stopLoss,
          tp: p.prefillSltp?.takeProfit,
        })}
      </output>
    ) : null,
}));
import { ChartTradeEntry } from "./ChartTradeEntry";
afterEach(() => {
  cleanup();
  context.symbol = "V75";
  vi.unstubAllGlobals();
});
const renderWithQueries = (ui: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>,
);
describe("Chart order-entry handoff", () => {
  it("keeps Buy and Sell behind the existing confirmation ticket", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 401 }))));
    renderWithQueries(<ChartTradeEntry />);
    fireEvent.click(screen.getByText("Buy V75"));
    expect(JSON.parse(screen.getByTestId("ticket").textContent!)).toEqual({
      symbol: "V75",
      side: "BUY",
    });
    expect(screen.getByText("Sell V75")).toBeTruthy();
  });
  it("opens side-checked SL/TP fields in the order window for the selected market", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 401 }))));
    renderWithQueries(<ChartTradeEntry />);
    fireEvent.click(screen.getByRole("button", { name: /Buy Limit · Sell Limit/ }));
    expect(await screen.findByLabelText("Stop loss")).toBeTruthy();
    expect(screen.getByLabelText("Take profit")).toBeTruthy();
    expect(screen.getByTestId("text-chart-trade-symbol").textContent).toBe("V75");
  });
});
