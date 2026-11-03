// Journal & Lessons: React Query keeps the last successful data after a failed
// refetch. The panel showed "couldn't read your reviews right now" AND the old
// review rows / win rates as if current. After a failed read neither list is
// shown (its age is unknown), and the "no closed scalps yet" empty state is not
// shown either — a failed read is not an empty journal.
//
// Real QueryClient; the generated hooks are replaced by plain useQuery driven
// by controllable functions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { RubyScalpReviewPanel } from "./RubyScalpReviewPanel";

const REVIEW = {
  id: 1,
  symbol: "EURUSD",
  displayName: "EUR/USD",
  direction: "BUY",
  result: "WIN",
  plQuality: "KNOWN",
  realizedPl: 12.5,
  lastFloatingPl: null,
  lesson: "Took profit into resistance as planned.",
  exitReason: null,
  rubyWarnedCorrectly: null,
  entryCount: 1,
  addOnCount: 0,
};
const PERSONALITY = {
  symbol: "EURUSD",
  displayName: "EUR/USD",
  isSynthetic: false,
  cautious: false,
  tradesClosed: 6,
  winRatePct: 67,
  notes: "Tends to follow through after a clean break.",
  continuationCount: 4,
  reversalCount: 1,
  fakeoutCount: 1,
};

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

describe("Journal & Lessons — a failed refetch does not keep the earlier lists", () => {
  it("rows listed, then both refetches fail → error lines only, no old rows, no empty-state copy", async () => {
    reviewsFn.mockResolvedValueOnce({ reviews: [REVIEW] });
    personalityFn.mockResolvedValueOnce({ symbols: [PERSONALITY] });
    render(withClient(<RubyScalpReviewPanel />));
    fireEvent.click(screen.getByTestId("ruby-scalp-reviews-collapse"));
    await waitFor(() => expect(screen.getAllByTestId("scalp-review-row")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("scalp-personality-row")).toHaveLength(1));

    reviewsFn.mockRejectedValueOnce(new Error("503"));
    personalityFn.mockRejectedValueOnce(new Error("503"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("ruby-scalp-reviews-refresh"));
    });
    await waitFor(() => expect(screen.getByText(/couldn't read your reviews right now/i)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/couldn't load what she's learned right now/i)).toBeTruthy());
    expect(screen.queryAllByTestId("scalp-review-row")).toHaveLength(0);
    expect(screen.queryAllByTestId("scalp-personality-row")).toHaveLength(0);
    expect(screen.queryByText(/67% won/)).toBeNull();
    expect(screen.queryByText(/No closed scalps yet/i)).toBeNull();
    expect(screen.queryByText(/learns a market's personality after a few closed trades/i)).toBeNull();

    reviewsFn.mockResolvedValueOnce({ reviews: [REVIEW] });
    personalityFn.mockResolvedValueOnce({ symbols: [PERSONALITY] });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ruby-scalp-reviews-refresh"));
    });
    await waitFor(() => expect(screen.getAllByTestId("scalp-review-row")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("scalp-personality-row")).toHaveLength(1));
  });
});
