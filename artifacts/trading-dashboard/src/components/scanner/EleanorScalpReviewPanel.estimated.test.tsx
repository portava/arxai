// Journal & Lessons: a closed scalp's result is graded from the last floating
// reading before the close (no broker-realised P/L is recorded). A leg last
// read at +$3 can close at -$4 after that reading, so the row must not carry a
// plain "Win" badge, and the per-market win share must not read as a fact.
// Only a KNOWN P/L earns a plain "Win" / "Loss".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

const reviewsFn = vi.fn<() => Promise<{ reviews: unknown[] }>>();
const personalityFn = vi.fn<() => Promise<{ symbols: unknown[] }>>();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMeScalpReviews: (_p: unknown, options: { query: { queryKey: readonly unknown[]; enabled?: boolean } }) =>
      useQuery({ queryKey: options.query.queryKey, queryFn: () => reviewsFn(), enabled: options.query.enabled, retry: false }),
    useGetMeScalpPersonality: (_p: unknown, options: { query: { queryKey: readonly unknown[]; enabled?: boolean } }) =>
      useQuery({ queryKey: options.query.queryKey, queryFn: () => personalityFn(), enabled: options.query.enabled, retry: false }),
  };
});

import { EleanorScalpReviewPanel } from "./EleanorScalpReviewPanel";

function review(over: Record<string, unknown>) {
  return {
    id: 1, symbol: "EURUSD", displayName: "EUR/USD", direction: "BUY",
    result: "WIN", plQuality: "ESTIMATED", realizedPl: null, lastFloatingPl: 3,
    lesson: null, exitReason: null, eleanorWarnedCorrectly: null, entryCount: 1, addOnCount: 0,
    ...over,
  };
}

let client: QueryClient;
function withClient(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reviewsFn.mockReset();
  personalityFn.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("Journal & Lessons — results graded from an estimate say so", () => {
  it("ESTIMATED win/loss/flat rows are badged as likely outcomes; only KNOWN is a plain Win", async () => {
    reviewsFn.mockResolvedValue({
      reviews: [
        review({ id: 1, symbol: "EURUSD", result: "WIN", plQuality: "ESTIMATED", lastFloatingPl: 3 }),
        review({ id: 2, symbol: "GBPUSD", result: "LOSS", plQuality: "ESTIMATED", lastFloatingPl: -4 }),
        review({ id: 3, symbol: "USDJPY", result: "BREAKEVEN", plQuality: "ESTIMATED", lastFloatingPl: 0 }),
        review({ id: 4, symbol: "AUDUSD", result: "WIN", plQuality: "KNOWN", realizedPl: 5, lastFloatingPl: null }),
      ],
    });
    personalityFn.mockResolvedValue({ symbols: [] });
    render(withClient(<EleanorScalpReviewPanel />));
    fireEvent.click(screen.getByTestId("eleanor-scalp-reviews-collapse"));
    await waitFor(() => expect(screen.getAllByTestId("scalp-review-row")).toHaveLength(4));
    const rows = screen.getAllByTestId("scalp-review-row");
    const bySymbol = (sym: string) => rows.find((r) => r.getAttribute("data-symbol") === sym)!;

    expect(within(bySymbol("EURUSD")).getByText(/Likely win \(estimated\)/)).toBeTruthy();
    expect(within(bySymbol("EURUSD")).queryByText(/^\s*Win\s*$/)).toBeNull();
    expect(within(bySymbol("GBPUSD")).getByText(/Likely loss \(estimated\)/)).toBeTruthy();
    expect(within(bySymbol("USDJPY")).getByText(/Roughly flat \(estimated\)/)).toBeTruthy();
    expect(within(bySymbol("AUDUSD")).getByText(/^\s*Win\s*$/)).toBeTruthy();
    expect(within(bySymbol("AUDUSD")).queryByText(/estimated/)).toBeNull();
  });

  // eleanorWarnedCorrectly is derived from the result graded from the last
  // floating reading. A leg last read at -$2 that closed at +$1 must not be
  // told Eleanor's warning "matched what happened".
  it("the warning line on an ESTIMATED row says it is going by the last reading, not what happened", async () => {
    reviewsFn.mockResolvedValue({
      reviews: [
        review({ id: 1, symbol: "EURUSD", result: "LOSS", plQuality: "ESTIMATED", lastFloatingPl: -2, eleanorWarnedCorrectly: true }),
        review({ id: 2, symbol: "GBPUSD", result: "WIN", plQuality: "ESTIMATED", lastFloatingPl: 2, eleanorWarnedCorrectly: false }),
        review({ id: 3, symbol: "AUDUSD", result: "LOSS", plQuality: "KNOWN", realizedPl: -2, lastFloatingPl: null, eleanorWarnedCorrectly: true }),
      ],
    });
    personalityFn.mockResolvedValue({ symbols: [] });
    render(withClient(<EleanorScalpReviewPanel />));
    fireEvent.click(screen.getByTestId("eleanor-scalp-reviews-collapse"));
    await waitFor(() => expect(screen.getAllByTestId("scalp-review-row")).toHaveLength(3));
    const rows = screen.getAllByTestId("scalp-review-row");
    const bySymbol = (sym: string) => rows.find((r) => r.getAttribute("data-symbol") === sym)!;
    expect(bySymbol("EURUSD").textContent).not.toMatch(/matched what happened/);
    expect(bySymbol("EURUSD").textContent).toMatch(/warning matched the last reading before the close \(estimated\)/);
    expect(bySymbol("GBPUSD").textContent).toMatch(/Going by the last reading before the close, this one didn't follow .*'s read \(estimated\)/);
    expect(bySymbol("AUDUSD").textContent).toMatch(/warning matched what happened\./);
  });

  it("the per-market win share is labelled as estimated", async () => {
    reviewsFn.mockResolvedValue({ reviews: [] });
    personalityFn.mockResolvedValue({
      symbols: [{
        symbol: "EURUSD", displayName: "EUR/USD", isSynthetic: false, cautious: true,
        tradesClosed: 5, winRatePct: 60, notes: null,
        continuationCount: 3, reversalCount: 1, fakeoutCount: 0,
      }],
    });
    render(withClient(<EleanorScalpReviewPanel />));
    fireEvent.click(screen.getByTestId("eleanor-scalp-reviews-collapse"));
    await waitFor(() => expect(screen.getAllByTestId("scalp-personality-row")).toHaveLength(1));
    const row = screen.getByTestId("scalp-personality-row");
    expect(row.textContent).toMatch(/60% won \(estimated\)/);
  });
});
