import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
const context = vi.hoisted(() => ({ symbol: "V75" }));
vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => [context.symbol],
  bareSymbol: (s: string) => s,
}));
vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ loaded: true, canTrade: false }),
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
});
describe("Chart protective levels handoff", () => {
  it("copies the entered levels and side into the existing confirmation ticket", () => {
    render(<ChartTradeEntry />);
    fireEvent.change(screen.getByLabelText("Stop loss"), {
      target: { value: "12420" },
    });
    fireEvent.change(screen.getByLabelText("Take profit"), {
      target: { value: "12540" },
    });
    fireEvent.click(screen.getByText("Buy V75"));
    expect(JSON.parse(screen.getByTestId("ticket").textContent!)).toEqual({
      symbol: "V75",
      side: "BUY",
      sl: 12420,
      tp: 12540,
    });
  });
  it("blocks invalid levels and clears a market-specific draft when the symbol changes", () => {
    const r = render(<ChartTradeEntry />);
    fireEvent.change(screen.getByLabelText("Stop loss"), {
      target: { value: "-1" },
    });
    expect((screen.getByText("Buy V75") as HTMLButtonElement).disabled).toBe(
      true,
    );
    context.symbol = "EURUSD";
    r.rerender(<ChartTradeEntry />);
    expect((screen.getByLabelText("Stop loss") as HTMLInputElement).value).toBe(
      "",
    );
    fireEvent.click(screen.getByText("Sell EURUSD"));
    expect(JSON.parse(screen.getByTestId("ticket").textContent!)).toEqual({
      symbol: "EURUSD",
      side: "SELL",
      sl: null,
      tp: null,
    });
  });
});
