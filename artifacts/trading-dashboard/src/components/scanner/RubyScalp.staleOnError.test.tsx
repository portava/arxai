// A failed scalp check must not leave the earlier plan or per-position advice
// on screen as if it were current:
//   * Scalp Focus: after a READY result, a Refresh that fails publishes
//     CHECK_FAILED to the header — the card must not keep showing the READY
//     status, entry/stop/TP ladder and Build button under the "couldn't read"
//     line.
//   * Position Manager: after baskets were listed, a failed 15s refetch must not
//     keep rendering the previous baskets' exit urgency and add-on advice under
//     the error line.
//
// Real QueryClient; the generated client hooks are replaced by plain
// useMutation / useQuery driven by controllable functions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ScalpBasket, ScalpResult } from "@workspace/api-client-react";

const focusFn = vi.fn<(vars: { data: { symbol: string } }) => Promise<ScalpResult>>();
const basketsFn = vi.fn<() => Promise<{ baskets: ScalpBasket[]; accountMode: string; generatedAt: string }>>();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useCreateMeScalpFocus: () =>
      useMutation({ mutationFn: (vars: { data: { symbol: string } }) => focusFn(vars) }),
    useGetMeScalpBaskets: (options: { query: { queryKey: readonly unknown[] } }) =>
      useQuery({ queryKey: options.query.queryKey, queryFn: () => basketsFn(), retry: false }),
  };
});

import { RubyScalpFocusCard } from "./RubyScalpFocusCard";
import { RubyScalpBasketPanel } from "./RubyScalpBasketPanel";
import { SelectedActionStoreProvider, useSelectedActionStore } from "./selectedActionStore";

function makeResult(overrides: Partial<ScalpResult> = {}): ScalpResult {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    assetClass: "forex",
    direction: "BUY",
    scalpType: "Momentum",
    mode: "ANY",
    status: "READY",
    qualityScore: 72,
    confidenceLabel: "Strong",
    entryType: "MARKET_BUY",
    entryZone: { from: 1.1, to: 1.1005 },
    currentPrice: 1.1002,
    takeProfit: { quick: 1.101, main: 1.102, stretch: 1.103 },
    stopLoss: 1.099,
    invalidationPrice: 1.0985,
    suggestedLot: 0.1,
    minLot: 0.01,
    maxLot: 5,
    lotStep: 0.01,
    digits: 5,
    targetProfitAmount: 20,
    estimatedProfitMainTP: 20,
    estimatedRiskAmount: 10,
    rewardToRisk: 2,
    estimatedMargin: 100,
    spreadRisk: "LOW",
    slippageRisk: "LOW",
    newsRisk: "LOW",
    timingStatus: "VALID_NOW",
    validForSeconds: 90,
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    chaseWarning: null,
    plainEnglishReason: "Clean momentum continuation.",
    riskWarning: null,
    targetRealityCheck: "REALISTIC",
    userAction: "READY_TO_REVIEW",
    canBuildTrade: true,
    canWatch: false,
    noTradeReason: null,
    flame: null,
    timeframe: "M5",
    generatedAt: new Date().toISOString(),
    ...overrides,
  } as ScalpResult;
}

function makeBasket(): ScalpBasket {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    direction: "BUY",
    accountMode: "DEMO",
    entryCount: 2,
    totalVolume: 0.2,
    averageEntry: 1.1001,
    currentPrice: 1.1012,
    combinedFloatingPl: 22,
    breakEvenPrice: 1.1001,
    hasUnprotectedLeg: false,
    legs: [],
    flame: { flameStage: "ACTIVE" },
    exit: {
      urgency: "PROTECT_PROFIT",
      action: "PROTECT",
      headline: "Lock in some profit",
      detail: "Move the stop to break-even.",
      alertOnly: true,
    },
    addOn: {
      recommendation: "ADD_WITH_CAUTION",
      maxAddOns: 3,
      usedAddOns: 1,
      remainingAddOns: 2,
      allowed: true,
      revengeGuardTriggered: false,
      requiresFreshConfirmation: true,
      profitCushion: 10,
      reason: "Cushion allows one more small add.",
    },
    generatedAt: new Date().toISOString(),
  } as unknown as ScalpBasket;
}

let client: QueryClient;
function withClient(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

let published: string | null | undefined;
function ActionProbe() {
  const store = useSelectedActionStore();
  published = store.get("EURUSD", "5m");
  return null;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  focusFn.mockReset();
  basketsFn.mockReset();
  published = undefined;
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("Scalp Focus — a failed Refresh does not keep the earlier plan on screen", () => {
  it("READY result, then Refresh rejects → no scalp card, CHECK_FAILED published, error line shown", async () => {
    focusFn.mockResolvedValueOnce(makeResult());
    render(withClient(
      <SelectedActionStoreProvider>
        <RubyScalpFocusCard symbol="EURUSD" onBuild={() => {}} />
        <ActionProbe />
      </SelectedActionStoreProvider>,
    ));
    await waitFor(() => expect(screen.getByTestId("scalp-card-EURUSD")).toBeTruthy());

    focusFn.mockRejectedValueOnce(new Error("503"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("ruby-scalp-focus-refresh"));
    });
    await waitFor(() => expect(screen.getByText(/couldn't read this market right now/i)).toBeTruthy());
    expect(screen.queryByTestId("scalp-card-EURUSD")).toBeNull();
    expect(published).toBe("CHECK_FAILED");

    focusFn.mockResolvedValueOnce(makeResult());
    await act(async () => {
      fireEvent.click(screen.getByTestId("ruby-scalp-focus-refresh"));
    });
    await waitFor(() => expect(screen.getByTestId("scalp-card-EURUSD")).toBeTruthy());
    expect(screen.queryByText(/couldn't read this market right now/i)).toBeNull();
  });
});

describe("Position Manager — a failed refetch does not keep the earlier baskets", () => {
  it("baskets listed, then refetch rejects → no BasketRow under the error line", async () => {
    basketsFn.mockResolvedValueOnce({ baskets: [makeBasket()], accountMode: "DEMO", generatedAt: new Date().toISOString() });
    render(withClient(<RubyScalpBasketPanel />));
    await waitFor(() => expect(screen.getAllByTestId("scalp-basket-row")).toHaveLength(1));
    expect(screen.getByText("Lock in some profit")).toBeTruthy();

    basketsFn.mockRejectedValueOnce(new Error("503"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("ruby-scalp-baskets-refresh"));
    });
    await waitFor(() => expect(screen.getByText(/couldn't read your open positions right now/i)).toBeTruthy());
    expect(screen.queryAllByTestId("scalp-basket-row")).toHaveLength(0);
    expect(screen.queryByText("Lock in some profit")).toBeNull();
    expect(screen.queryByText(/No open scalp positions to manage/i)).toBeNull();

    basketsFn.mockResolvedValueOnce({ baskets: [makeBasket()], accountMode: "DEMO", generatedAt: new Date().toISOString() });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ruby-scalp-baskets-refresh"));
    });
    await waitFor(() => expect(screen.getAllByTestId("scalp-basket-row")).toHaveLength(1));
  });
});
