import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * LiveTradeCard snapshot truth. When the server had no quote for the trade's
 * symbol it returns currentPrice / floatingPnl / rMultiple / health as null
 * with a reason. The card must say "Unavailable" — never the entry price,
 * "$0.00" or "0.00R" as if the trade were flat — and, when priced, name the
 * quote time.
 */

const h = vi.hoisted(() => ({ snap: undefined as unknown }));

vi.mock("@workspace/api-client-react", () => ({
  useGetTradeSnapshot: () => ({ data: h.snap }),
  useGetCoachExplanation: () => ({ data: undefined, isLoading: false }),
  useMoveTradeToBreakeven: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrailTradeStop: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePartialCloseTrade: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloseTradeManually: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useGetMt5State: () => ({ data: undefined }),
  useGetAaciDecision: () => ({ data: undefined }),
  getGetTradeSnapshotQueryKey: (id: number) => ["snap", id],
  getGetOpenTradesQueryKey: () => ["open-trades"],
  getGetCoachExplanationQueryKey: (id: number) => ["coach", id],
  getGetMt5StateQueryKey: () => ["mt5-state"],
  getGetAaciDecisionQueryKey: (s: string) => ["aaci", s],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: {} }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { LiveTradeCard } from "./LiveTradeCard";

const trade = {
  id: 1, symbol: "EURUSD", direction: "BUY", lot: 1, mode: "DEMO",
  entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12,
} as never;

const unavailableReason = "No current quote for EURUSD from the market-data feed — price, P&L, R and health cannot be measured right now.";
const notRecommended = { recommended: false, reason: unavailableReason };

afterEach(() => cleanup());

describe("LiveTradeCard snapshot truth", () => {
  it("no quote: Current, P&L, R and Health read Unavailable, not entry / $0.00 / 0.00R", () => {
    h.snap = {
      tradeId: 1, currentPrice: null, quoteAt: null, priceUnavailableReason: unavailableReason,
      rMultiple: null, floatingPnl: null, health: null,
      suggestions: { breakEven: notRecommended, trail: notRecommended, partial: notRecommended, earlyExit: notRecommended },
      primarySuggestion: unavailableReason, invalidated: false,
    };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("snap-current-1").textContent).toBe("Unavailable");
    expect(screen.getByTestId("snap-pnl-1").textContent).toBe("Unavailable");
    expect(screen.getByTestId("snap-r-1").textContent).toBe("Unavailable");
    expect(screen.getByTestId("snap-health-unavailable-1")).toBeTruthy();
    expect(screen.queryByTestId("snap-quote-at-1")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("0.00R")).toBeNull();
    expect(screen.getByText(unavailableReason)).toBeTruthy();
  });

  it("priced: shows the measured values and the quote time", () => {
    h.snap = {
      tradeId: 1, currentPrice: 1.101, quoteAt: "2026-10-28T09:00:00.000Z", priceUnavailableReason: null,
      rMultiple: 0.1, floatingPnl: 100, health: { score: 72, state: "healthy", factors: {} },
      suggestions: { breakEven: { recommended: false, reason: "x" }, trail: { recommended: false, reason: "x" }, partial: { recommended: false, reason: "x" }, earlyExit: { recommended: false, reason: "x" } },
      primarySuggestion: "Hold — no action recommended.", invalidated: false,
    };
    render(<LiveTradeCard trade={trade} />);
    expect(screen.getByTestId("snap-current-1").textContent).toBe("1.10100");
    expect(screen.getByTestId("snap-pnl-1").textContent).toBe("$100.00");
    expect(screen.getByTestId("snap-r-1").textContent).toBe("0.10R");
    expect(screen.getByTestId("snap-quote-at-1").textContent).toMatch(/^Quote as of /);
  });
});
