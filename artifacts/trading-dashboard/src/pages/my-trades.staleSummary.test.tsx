// Regression: after a failed 5-second refresh the Live Position Summary kept
// its green "Healthy" badge on the cached cards while the page banner said the
// bridge was unavailable; an empty book read "Checking" next to "No open trades
// right now"; and a total that included shared-master estimates was printed as
// a plain number without the "est." the per-row view carries.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

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
    id, source: "shared_master_attribution", routingMode: "SHARED_MASTER_MT5", accountType: "live",
    symbol: "EURUSD", side: "BUY", lotSize: 0.5, entryPrice: 1.085, currentPrice: 1.086,
    stopLoss: 1.08, takeProfit: 1.1, unrealizedPnl: 12.5, pnlIsEstimate: false, pnlPercent: null,
    status: "OPEN", openedAt: "2026-10-28T11:00:00Z", brokerLabelMasked: null, waitingForSync: false, ...over,
  };
}
function body(cards: unknown[]) {
  return JSON.stringify({ ok: true, routingMode: "SHARED_MASTER_MT5", accountType: "live", tradingMode: "LIVE", bannerLabel: "Live Shared MT5", cards });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Open Trades summary truth", () => {
  it("withdraws the Healthy badge when the refresh fails and the cards are a cached copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response(body([card("a", {}), card("b", { symbol: "GBPUSD" })]), { status: 200 });
      return new Response("boom", { status: 500 });
    }));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("position-summary-badge").textContent).toBe("Healthy"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await waitFor(() => expect(screen.getByText(/Bridge unavailable/)).toBeTruthy());
    const badge = screen.getByTestId("position-summary-badge");
    expect(badge.textContent).not.toBe("Healthy");
    expect(badge.textContent).toBe("Not current");
    expect(screen.getByTestId("position-summary-stale").textContent).toMatch(/Refresh failed \(HTTP 500\)\. Showing positions as last loaded at /);
  });

  it("says the positions could not be loaded when the first load fails, not 'No open trades'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("position-summary-badge").textContent).toBe("Unavailable"));
    expect(screen.queryByText("No open trades right now.")).toBeNull();
    expect(screen.getAllByText(/Open positions could not be loaded \(HTTP 500\)/).length).toBeGreaterThan(0);
  });

  it("an empty book is stated as such, not as 'Checking'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body([]), { status: 200 })));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("position-summary-badge").textContent).toBe("No positions"));
    expect(screen.getAllByText("No open trades right now.").length).toBeGreaterThan(0);
  });

  it("marks the summary Open P/L as an estimate when any row's P/L is an estimate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body([
      card("a", { unrealizedPnl: 10, pnlIsEstimate: true }),
      card("b", { symbol: "GBPUSD", unrealizedPnl: 5, pnlIsEstimate: false }),
    ]), { status: 200 })));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("position-summary-open-pnl").textContent).toMatch(/\+\$15\.00/));
    const tile = screen.getByTestId("position-summary-open-pnl").textContent ?? "";
    expect(tile).toMatch(/est\./);
    expect(tile).toMatch(/1 of 2 estimated/);
    expect(screen.getByTestId("open-trades-strip-pnl").textContent).toMatch(/est\./);
  });

  it("a row whose P/L is null (not marked syncing) shows Not reported, never +$0.00", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body([card("a", { unrealizedPnl: null, waitingForSync: false })]), { status: 200 })));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("position-summary-badge").textContent).toBe("Healthy"));
    expect(screen.queryByText("+$0.00")).toBeNull();
  });
});
