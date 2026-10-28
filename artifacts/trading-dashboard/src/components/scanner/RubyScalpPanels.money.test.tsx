// Position Manager basket P/L and Journal review P/L are in the trading
// account's currency (broker P/L). Neither the basket nor the journal entry
// carries that currency, so the panels must not prefix "$" — on a EUR or GBP
// account "$12.40" names the wrong currency. They use fmtScalpMoney with no
// currency: "12.40 (account currency)".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ScalpBasket, ScalpJournalEntry } from "@workspace/api-client-react";

const basketsFn = vi.fn<() => Promise<{ baskets: ScalpBasket[]; accountMode: string; generatedAt: string }>>();
const reviewsFn = vi.fn<() => Promise<{ reviews: ScalpJournalEntry[] }>>();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMeScalpBaskets: (options: { query: { queryKey: readonly unknown[] } }) =>
      useQuery({ queryKey: options.query.queryKey, queryFn: () => basketsFn(), retry: false }),
    useGetMeScalpReviews: (_p: unknown, options: { query: { queryKey: readonly unknown[]; enabled?: boolean } }) =>
      useQuery({ queryKey: options.query.queryKey, queryFn: () => reviewsFn(), retry: false, enabled: options.query.enabled }),
    useGetMeScalpPersonality: (_p: unknown, options: { query: { queryKey: readonly unknown[]; enabled?: boolean } }) =>
      useQuery({
        queryKey: options.query.queryKey,
        queryFn: async () => ({ symbols: [] }),
        retry: false,
        enabled: options.query.enabled,
      }),
  };
});

import { RubyScalpBasketPanel } from "./RubyScalpBasketPanel";
import { RubyScalpReviewPanel } from "./RubyScalpReviewPanel";

function makeBasket(combinedFloatingPl: number | null): ScalpBasket {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    direction: "BUY",
    accountMode: "DEMO",
    entryCount: 1,
    totalVolume: 0.1,
    averageEntry: 1.1001,
    currentPrice: 1.1012,
    combinedFloatingPl,
    breakEvenPrice: 1.1001,
    hasUnprotectedLeg: false,
    legs: [],
    flame: { flameStage: "ACTIVE" },
    exit: { urgency: "HOLD", action: "HOLD", headline: "Hold", detail: "Nothing to do.", alertOnly: true },
    addOn: {
      recommendation: "NO_ADD",
      maxAddOns: 3,
      usedAddOns: 0,
      remainingAddOns: 3,
      allowed: false,
      revengeGuardTriggered: false,
      requiresFreshConfirmation: true,
      profitCushion: 0,
      reason: "No add.",
    },
    generatedAt: new Date().toISOString(),
  } as unknown as ScalpBasket;
}

function makeEntry(overrides: Partial<ScalpJournalEntry>): ScalpJournalEntry {
  return {
    id: 1,
    accountMode: "DEMO",
    symbol: "EURUSD",
    displayName: "EUR/USD",
    isSynthetic: false,
    direction: "BUY",
    timeframe: "M5",
    entryCount: 1,
    addOnCount: 0,
    status: "CLOSED",
    result: "LOSS",
    plQuality: "KNOWN",
    realizedPl: -8.1,
    lastFloatingPl: null,
    ...overrides,
  } as ScalpJournalEntry;
}

let client: QueryClient;
function withClient(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  basketsFn.mockReset();
  reviewsFn.mockReset();
});
afterEach(() => cleanup());

describe("Position Manager basket P/L currency", () => {
  it("open P/L is not prefixed '$' when the account currency is not reported", async () => {
    basketsFn.mockResolvedValue({ baskets: [makeBasket(12.4)], accountMode: "DEMO", generatedAt: new Date().toISOString() });
    render(withClient(<RubyScalpBasketPanel />));
    const row = await screen.findByTestId("scalp-basket-row");
    expect(row.textContent).not.toContain("$12.40");
    expect(row.textContent).toContain("12.40 (account currency)");
  });
});

describe("Journal review P/L currency", () => {
  async function renderOpen(entry: ScalpJournalEntry) {
    reviewsFn.mockResolvedValue({ reviews: [entry] });
    render(withClient(<RubyScalpReviewPanel />));
    fireEvent.click(screen.getByTestId("ruby-scalp-reviews-collapse"));
    await waitFor(() => expect(screen.getAllByTestId("scalp-review-row")).toHaveLength(1));
    return screen.getByTestId("scalp-review-row");
  }

  it("a known realised P/L is not shown as '$-8.10'", async () => {
    const row = await renderOpen(makeEntry({ plQuality: "KNOWN", realizedPl: -8.1 }));
    expect(row.textContent).not.toContain("$");
    expect(row.textContent).toContain("-8.10 (account currency)");
  });

  it("an estimated P/L is not shown in dollars either", async () => {
    const row = await renderOpen(makeEntry({ plQuality: "ESTIMATED", realizedPl: null, lastFloatingPl: 3.25, result: "WIN" }));
    expect(row.textContent).not.toContain("$");
    expect(row.textContent).toContain("3.25 (account currency)");
    expect(row.textContent).toMatch(/estimated from the last reading/);
  });
});
