// Same P0-3 contract as OpenLivePositions.errorState.test.tsx, applied to the
// Live Trades page's LiveOpenTradesPanel (per-user live slot positions):
//
//   - a non-OK response NEVER renders "No open trades right now.";
//   - it renders an explicit error state telling the trader NOT to assume
//     they are flat, with a retry affordance;
//   - the header count reads "(count unavailable)" while loading/errored —
//     never a confident "(0)";
//   - the empty state renders ONLY on a confirmed 200 with zero positions.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LiveOpenTradesPanel } from "./LiveOpenTradesPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0, gcTime: 0, staleTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <LiveOpenTradesPanel />
    </QueryClientProvider>,
  );
}

function stubFetch(res: { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ({
        ok: res.ok,
        status: res.status,
        json: async () => res.body,
        text: async () => JSON.stringify(res.body),
      }) as unknown as Response,
    ),
  );
}

describe("LiveOpenTradesPanel — a failed fetch must never read as 'flat'", () => {
  it("renders the error state, NOT 'No open trades right now.', on a 500", async () => {
    stubFetch({ ok: false, status: 500, body: { error: "INTERNAL" } });
    renderPanel();

    const err = await screen.findByTestId("open-trades-error");
    expect(err).toBeTruthy();
    expect(screen.queryByTestId("open-trades-empty")).toBeNull();
    expect(screen.queryByText(/No open trades right now/i)).toBeNull();
    expect(err.textContent ?? "").toMatch(/do not assume you are flat/i);
    expect(screen.getByTestId("btn-retry-open-trades")).toBeTruthy();
    // The header must not claim a confident zero count.
    expect(screen.getByText("(count unavailable)")).toBeTruthy();
    expect(screen.queryByText("(0)")).toBeNull();
  });

  it("renders the error state on a network rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderPanel();

    expect(await screen.findByTestId("open-trades-error")).toBeTruthy();
    expect(screen.queryByTestId("open-trades-empty")).toBeNull();
  });

  it("shows loading (not the empty state) in flight, and '(count unavailable)'", async () => {
    let release: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    renderPanel();

    expect(await screen.findByTestId("open-trades-loading")).toBeTruthy();
    expect(screen.queryByTestId("open-trades-empty")).toBeNull();
    expect(screen.getByText("(count unavailable)")).toBeTruthy();

    release({
      ok: true,
      status: 200,
      json: async () => ({ accountCurrency: "USD", positions: [], isLive: true, isStale: false, lastUpdated: new Date().toISOString() }),
    } as unknown as Response);

    await waitFor(() => expect(screen.getByTestId("open-trades-empty")).toBeTruthy());
    expect(screen.getByText("(0)")).toBeTruthy();
  });

  it("renders the empty state ONLY on a confirmed 200 with zero positions", async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: { accountCurrency: "USD", positions: [], isLive: true, isStale: false, lastUpdated: new Date().toISOString() },
    });
    renderPanel();

    expect(await screen.findByTestId("open-trades-empty")).toBeTruthy();
    expect(screen.queryByTestId("open-trades-error")).toBeNull();
  });

  it("renders rows on a confirmed 200 with open positions", async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: {
        accountCurrency: "USD",
        positions: [{
          brokerTicket: "42", symbol: "XAUUSD", direction: "BUY", volume: 0.1,
          entryPrice: 2400, currentPrice: 2410, stopLoss: null, takeProfit: null,
          grossProfit: 10, swap: null, commission: null, netProfit: 10,
          profitPercentOfSlot: null, openedAt: null, lastUpdated: null,
        }],
        isLive: true, isStale: false, lastUpdated: new Date().toISOString(),
      },
    });
    renderPanel();

    expect((await screen.findAllByText("XAUUSD")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("open-trades-empty")).toBeNull();
    expect(screen.queryByTestId("open-trades-error")).toBeNull();
  });
});
