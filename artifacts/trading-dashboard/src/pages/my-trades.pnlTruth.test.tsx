// Regression: USER_OWNED_MT5 cards whose P/L the broker has not reported
// (waitingForSync, unrealizedPnl null) were summed as 0, so the status strip
// showed a green dot and "Open P/L +$0.00" and the summary tiles picked a
// Biggest Winner/Loser among zeros while every row read "syncing…".
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("wouter", () => ({ useLocation: () => ["/my-trades", () => {}], Link: ({ children }: { children: unknown }) => children }));
vi.mock("@workspace/api-client-react", () => ({
  useGetTimingBrainMulti: () => ({ data: undefined }),
  getGetTimingBrainMultiQueryKey: () => ["timing"],
}));
vi.mock("@/components/trading/ConfirmCloseModal", () => ({ ConfirmCloseModal: () => null }));
vi.mock("@/components/trading/QuickTradeModal", () => ({ QuickTradeModal: () => null }));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", () => {}] }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({
  useLiveAccountSnapshot: () => ({ isUnavailable: true, snapshot: null, live: null, freshness: "unknown", lastUpdatedMs: null, isEstimate: false }),
}));
vi.mock("@/components/account/CanonicalBalancePanel", () => ({ CanonicalBalancePanel: () => null }));
vi.mock("@/components/ui/FreshnessBadge", () => ({ FreshnessBadge: () => null }));

const { default: MyTradesPage } = await import("./my-trades");

function card(id: string, over: Record<string, unknown>) {
  return {
    id, source: "user_owned_mt5", routingMode: "USER_OWNED_MT5", accountType: "demo",
    symbol: "EURUSD", side: "BUY", lotSize: 0.5, entryPrice: 1.085, currentPrice: null,
    stopLoss: 1.08, takeProfit: 1.1, unrealizedPnl: null, pnlIsEstimate: false, pnlPercent: null,
    status: "OPEN", openedAt: "2026-10-28T11:00:00Z", brokerLabelMasked: null, waitingForSync: true, ...over,
  };
}
function stub(cards: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    ok: true, routingMode: "USER_OWNED_MT5", accountType: "demo", tradingMode: "DEMO", bannerLabel: "Demo", cards,
  }), { status: 200 })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Open Trades P/L truth", () => {
  it("does not show +$0.00 or a green dot while every position is waiting for broker P/L", async () => {
    stub([card("lp_1", { symbol: "EURUSD" }), card("lp_2", { symbol: "GBPUSD" })]);
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getAllByText("syncing…").length).toBe(2));
    const strip = screen.getByTestId("open-trades-strip-pnl");
    expect(strip.textContent).not.toBe("+$0.00");
    expect(strip.textContent).toMatch(/Not reported \(2 of 2 positions\)/);
    expect(screen.getByTestId("open-trades-status-dot").getAttribute("data-state")).toBe("waiting");
    expect(screen.queryByText("+$0.00")).toBeNull();
    expect(screen.getByText(/Open P\/L is not reported yet for 2 of 2 positions/)).toBeTruthy();
  });

  it("states the total once the broker has reported every position", async () => {
    stub([
      card("lp_1", { symbol: "EURUSD", unrealizedPnl: -42.1, waitingForSync: false }),
      card("lp_2", { symbol: "GBPUSD", unrealizedPnl: 7.3, waitingForSync: false }),
    ]);
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("open-trades-strip-pnl").textContent).toBe("-$34.80"));
    expect(screen.getByTestId("open-trades-status-dot").getAttribute("data-state")).toBe("ok");
  });
});
