// Regression (review of bca5c984):
//  (a) one failed /api/me/trades/open refresh was explained two ways: the
//      banner said "Bridge unavailable. Open positions will refresh when the
//      MT5 bridge reconnects." while the summary said "Refresh failed (HTTP
//      500)". The failure is the API request; the banner now says so too.
//  (b) the strip showed the account snapshot's "Open P/L $12.34" while the
//      Live Position Summary and the Eleanor read said P/L was not reported (1
//      of 3 awaiting). The strip now names its source and the summary and
//      the Eleanor read state the snapshot total next to the per-position gap.
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
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));
const snap = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({ useLiveAccountSnapshot: () => snap.value }));
vi.mock("@/components/account/CanonicalBalancePanel", () => ({ CanonicalBalancePanel: () => null }));
vi.mock("@/components/ui/FreshnessBadge", () => ({ FreshnessBadge: () => null }));

const { default: MyTradesPage } = await import("./my-trades");

function card(id: string, over: Record<string, unknown>) {
  return {
    id, source: "own_mt5", routingMode: "OWN_MT5", accountType: "demo",
    symbol: "EURUSD", side: "BUY", lotSize: 0.1, entryPrice: 1.085, currentPrice: 1.086,
    stopLoss: 1.08, takeProfit: 1.1, unrealizedPnl: 5, pnlIsEstimate: false, pnlPercent: null,
    status: "OPEN", openedAt: "2026-10-28T11:00:00Z", brokerLabelMasked: null, waitingForSync: false, ...over,
  };
}
const body = (cards: unknown[]) => JSON.stringify({ ok: true, routingMode: "OWN_MT5", accountType: "demo", tradingMode: "DEMO", bannerLabel: "Demo", cards });
const unavailable = { isUnavailable: true, snapshot: null, live: null, freshness: "unknown", lastUpdatedMs: null, isEstimate: false };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("My Trades — one failure, one explanation", () => {
  it("a failed refresh is described as the request failing, in the banner and the summary alike", async () => {
    snap.value = unavailable;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++calls === 1 ? new Response(body([card("a", {})]), { status: 200 }) : new Response("boom", { status: 500 }))));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("position-summary-badge").textContent).toBe("Healthy"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await waitFor(() => expect(screen.getByTestId("open-trades-error-banner")).toBeTruthy());
    const banner = screen.getByTestId("open-trades-error-banner").textContent ?? "";
    expect(banner).not.toMatch(/Bridge unavailable|MT5 bridge reconnects/);
    expect(banner).toMatch(/HTTP 500/);
    expect(screen.getByTestId("position-summary-stale").textContent).toMatch(/HTTP 500/);
  });

  it("a failed first load: the banner says the positions could not be loaded", async () => {
    snap.value = unavailable;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("open-trades-error-banner").textContent).toMatch(/Open positions could not be loaded \(HTTP 500\)/));
  });
});

describe("My Trades — strip and summary Open P/L", () => {
  it("names the account snapshot as the strip's source and states it beside the per-position gap", async () => {
    snap.value = {
      isUnavailable: false, snapshot: { openPL: 12.34, openPositionsCount: 3 }, live: null,
      freshness: "live", lastUpdatedMs: Date.now(), isEstimate: false,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body([
      card("a", {}), card("b", { symbol: "GBPUSD" }), card("c", { symbol: "USDJPY", waitingForSync: true, unrealizedPnl: null }),
    ]), { status: 200 })));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("open-trades-strip-pnl").textContent).toMatch(/\$12\.34/));
    expect(screen.getByTestId("open-trades-strip-pnl-source").textContent).toBe("account snapshot");
    const summary = screen.getByTestId("position-summary-open-pnl").textContent ?? "";
    expect(summary).toMatch(/Not reported/);
    expect(summary).toMatch(/1 of 3 awaiting broker P\/L/);
    expect(summary).toMatch(/account snapshot reports \+?\$12\.34 in total/);
    expect(screen.getByText(/Open P\/L is not reported yet for 1 of 3 positions\. The account snapshot reports \+?\$12\.34 in total\./)).toBeTruthy();
  });
});

// Regression (review of 34f894b8): a stale snapshot still feeds the strip
// (only "unavailable" drops it), and the note beside the per-position gap said
// "The account snapshot reports $12.34 in total." in the present tense, with
// no stale marker or time, in the two places that carry no FreshnessBadge.
describe("My Trades — a stale account snapshot total is not stated as current", () => {
  const cardsBody = () => body([
    card("a", {}), card("b", { symbol: "GBPUSD" }), card("c", { symbol: "USDJPY", waitingForSync: true, unrealizedPnl: null }),
  ]);

  for (const freshness of ["stale", "delayed"] as const) {
    it(`a ${freshness} snapshot is "last reported", with its freshness and time`, async () => {
      const at = new Date("2026-10-28T11:58:07Z").getTime();
      snap.value = {
        isUnavailable: false, isStale: freshness === "stale", snapshot: { openPL: 12.34, openPositionsCount: 3 }, live: null,
        freshness, lastUpdatedMs: at, isEstimate: false,
      };
      vi.stubGlobal("fetch", vi.fn(async () => new Response(cardsBody(), { status: 200 })));
      render(<MyTradesPage />);
      await waitFor(() => expect(screen.getByTestId("position-summary-open-pnl").textContent).toMatch(/1 of 3 awaiting broker P\/L/));
      const expected = `The account snapshot last reported +$12.34 in total (${freshness}, as of ${new Date(at).toLocaleTimeString()}).`;
      const summary = screen.getByTestId("position-summary-open-pnl").textContent ?? "";
      expect(summary).toContain(expected);
      expect(document.body.textContent).not.toMatch(/account snapshot reports/);
      expect(screen.getByText(/Open P\/L is not reported yet for 1 of 3 positions\./).textContent).toContain(expected);
    });
  }

  it("a stale snapshot with no update time says the time was not reported", async () => {
    snap.value = {
      isUnavailable: false, isStale: true, snapshot: { openPL: 12.34, openPositionsCount: 3 }, live: null,
      freshness: "stale", lastUpdatedMs: null, isEstimate: false,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(cardsBody(), { status: 200 })));
    render(<MyTradesPage />);
    await waitFor(() => expect(screen.getByTestId("position-summary-open-pnl").textContent).toMatch(/1 of 3 awaiting broker P\/L/));
    expect(screen.getByTestId("position-summary-open-pnl").textContent).toContain(
      "The account snapshot last reported +$12.34 in total (stale, update time not reported).",
    );
  });
});
