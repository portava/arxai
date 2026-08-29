// Render proof for the LiveTradeCard action row.
//
// WHAT WAS WRONG
//   POST /api/trade-management/:id/close read mt5State, discarded it, wrote
//   status/pnl/closedAt and answered "Trade closed at … (mock)." — with no
//   broker adapter anywhere on that path. This card wired the four mutation
//   hooks and NEVER rendered the returned message. On a page titled Live Trades
//   with a red LIVE badge, a user pressed Close, the row vanished, and they
//   believed they were flat while the broker position kept running.
//
//   The handlers were also `async () => { await x.mutateAsync(...); refresh(); }`
//   with no catch, so a refusal (409/404/401) became an unhandled rejection and
//   the user saw nothing at all.
//
// WHAT IS ASSERTED HERE
//   • a LIVE row shows no action buttons and says why;
//   • a DEMO row's success renders the server's own message verbatim;
//   • a rejected mutation renders the server's refusal, not silence.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  closeImpl: vi.fn(async () => ({ success: true, simulated: true, message: "" })),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetTradeSnapshot: () => ({
    data: {
      currentPrice: 1.105,
      floatingPnl: 4.2,
      rMultiple: 0.5,
      health: { score: 80, state: "HEALTHY" },
      primarySuggestion: "Hold.",
      suggestions: {
        breakEven: { recommended: false },
        trail: { recommended: false, newStop: 1.095 },
        partial: { recommended: false },
      },
    },
  }),
  useGetCoachExplanation: () => ({ data: undefined, isLoading: false }),
  useMoveTradeToBreakeven: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTrailTradeStop: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePartialCloseTrade: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloseTradeManually: () => ({ mutateAsync: h.closeImpl, isPending: false }),
  useGetMt5State: () => ({ data: { connected: true, liveAllowed: true } }),
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

function tradeRow(mode: "LIVE" | "DEMO") {
  return {
    id: 7,
    symbol: "EURUSD",
    direction: "BUY",
    lot: 0.01,
    mode,
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
  } as never;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("LiveTradeCard — LIVE row", () => {
  it("offers none of the four actions and explains why", () => {
    render(<LiveTradeCard trade={tradeRow("LIVE")} />);
    for (const id of ["button-close-7", "button-breakeven-7", "button-trail-7", "button-partial-7"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
    const note = screen.getByTestId("live-actions-unavailable-7");
    expect(note.textContent).toMatch(/not connected to a broker/);
    expect(note.textContent).toMatch(/Live Shared/);
  });

  it("does not advertise manual close or SL/TP editing on the badge row", () => {
    render(<LiveTradeCard trade={tradeRow("LIVE")} />);
    expect(screen.queryByTestId("badge-manual-close")).toBeNull();
    expect(screen.queryByTestId("badge-sltp-editable")).toBeNull();
    expect(screen.getByTestId("badge-managed-elsewhere")).toBeTruthy();
  });
});

describe("LiveTradeCard — DEMO row surfaces the server's own words", () => {
  it("renders the returned message instead of silently vanishing the row", async () => {
    h.closeImpl.mockResolvedValueOnce({
      success: true,
      simulated: true,
      message: "Trade closed at 1.10500 for 4.20. Simulated in ARX only — no broker order was sent.",
    });
    render(<LiveTradeCard trade={tradeRow("DEMO")} />);
    fireEvent.click(screen.getByTestId("button-close-7"));
    await waitFor(() => {
      expect(screen.getByTestId("action-result-7").textContent).toMatch(
        /Simulated in ARX only — no broker order was sent\./,
      );
    });
  });

  it("renders a refusal instead of swallowing it", async () => {
    // Shape of the ApiError the generated client throws on a non-2xx.
    const refusal = Object.assign(new Error("HTTP 409 Conflict"), {
      data: { error: "LIVE_TRADE_ACTION_NOT_AVAILABLE", message: "Refused. Manage a live position from Live Shared." },
    });
    h.closeImpl.mockRejectedValueOnce(refusal);
    render(<LiveTradeCard trade={tradeRow("DEMO")} />);
    fireEvent.click(screen.getByTestId("button-close-7"));
    await waitFor(() => {
      expect(screen.getByTestId("action-result-7").textContent).toMatch(/Refused\./);
    });
  });

  it("states up front that the demo actions send no broker order", () => {
    render(<LiveTradeCard trade={tradeRow("DEMO")} />);
    expect(screen.getByTestId("sim-actions-note-7").textContent).toMatch(/no broker order is sent/);
  });
});
