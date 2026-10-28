// Position Manager truth:
//  - the server says when the bridge last reported the positions shown and
//    flags a reading older than 90 seconds as stale. Hours-old positions,
//    open P/L and stops must not read as the account now.
//
// Real QueryClient; the generated baskets hook is replaced by a plain useQuery.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { MeScalpBasketsResp, ScalpBasket } from "@workspace/api-client-react";

const basketsFn = vi.fn<() => Promise<MeScalpBasketsResp>>();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMeScalpBaskets: (options: { query: { queryKey: readonly unknown[] } }) =>
      useQuery({ queryKey: options.query.queryKey, queryFn: () => basketsFn(), retry: false }),
  };
});

import { RubyScalpBasketPanel } from "./RubyScalpBasketPanel";

function makeBasket(): ScalpBasket {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    direction: "BUY",
    accountMode: "LIVE",
    entryCount: 2,
    totalVolume: 0.2,
    averageEntry: 1.1001,
    currentPrice: 1.1012,
    combinedFloatingPl: 22,
    breakEvenPrice: 1.1001,
    hasUnprotectedLeg: false,
    legs: [],
    flame: { flameStage: "ACTIVE" },
    exit: { urgency: "NONE", action: "HOLD", headline: "Healthy", detail: "Let it work.", alertOnly: true },
    addOn: {
      recommendation: "HOLD", maxAddOns: 3, usedAddOns: 1, remainingAddOns: 2, allowed: false,
      revengeGuardTriggered: false, requiresFreshConfirmation: false, profitCushion: null, reason: "Hold.",
    },
    generatedAt: new Date().toISOString(),
  } as unknown as ScalpBasket;
}

let client: QueryClient;
function withClient(children: ReactNode) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  basketsFn.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("Position Manager — positions reading age", () => {
  it("a 3-hour-old reading is shown as that reading, not live", async () => {
    const asOf = new Date(Date.now() - 3 * 3_600_000).toISOString();
    basketsFn.mockResolvedValueOnce({
      baskets: [makeBasket()], accountMode: "LIVE_SHARED", positionsMeasured: true,
      positionsAsOf: asOf, positionsStale: true, generatedAt: new Date().toISOString(),
    });
    render(withClient(<RubyScalpBasketPanel />));
    await waitFor(() => expect(screen.getAllByTestId("scalp-basket-row")).toHaveLength(1));
    const warn = screen.getByTestId("scalp-baskets-stale");
    expect(warn.textContent).toMatch(/not live/);
    expect(warn.textContent).toMatch(/3h 0m ago/);
    expect(warn.textContent).toMatch(/may have changed or closed/);
    expect(screen.getByText("Open P/L (old reading)")).toBeTruthy();
  });

  it("a stale reading with no recorded time says so", async () => {
    basketsFn.mockResolvedValueOnce({
      baskets: [makeBasket()], accountMode: "LIVE_SHARED", positionsMeasured: true,
      positionsAsOf: null, positionsStale: true, generatedAt: new Date().toISOString(),
    });
    render(withClient(<RubyScalpBasketPanel />));
    await waitFor(() => expect(screen.getByTestId("scalp-baskets-stale")).toBeTruthy());
    expect(screen.getByTestId("scalp-baskets-stale").textContent).toMatch(/No reading time is recorded/);
  });

  it("a current reading carries its time and no stale warning", async () => {
    const asOf = new Date(Date.now() - 5_000).toISOString();
    basketsFn.mockResolvedValueOnce({
      baskets: [makeBasket()], accountMode: "LIVE_SHARED", positionsMeasured: true,
      positionsAsOf: asOf, positionsStale: false, generatedAt: new Date().toISOString(),
    });
    render(withClient(<RubyScalpBasketPanel />));
    await waitFor(() => expect(screen.getByTestId("scalp-baskets-as-of")).toBeTruthy());
    expect(screen.queryByTestId("scalp-baskets-stale")).toBeNull();
    expect(screen.getByText("Open P/L")).toBeTruthy();
  });
});
