// P0-3 — "flat on a failed fetch" is a wrong-trading-decision bug.
//
// OpenLivePositions used `fetch(...).then(r => r.json())` with NO `r.ok`
// check. A 500/502/401 whose body is an error object (or empty) produced
// `items: undefined` → `[]`, and the component rendered "No open live
// positions". A trader looking at that reads it as "I am flat" and may open a
// fresh position on top of real, still-open broker exposure — or skip closing
// one that is running against them.
//
// The contract this locks:
//   - a non-OK response NEVER renders the empty state;
//   - it renders an explicit error state that tells the trader NOT to assume
//     they are flat, with a retry affordance;
//   - the loading state also never renders the empty state;
//   - the empty state renders ONLY on a confirmed 200 with zero open rows.
//
// Render proof only — no network, no QueryClientProvider from app code. The
// component calls useQuery directly, so a throwaway QueryClient is supplied
// with retries disabled for determinism.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The card's close actions route through the instant-trade router; stub it so
// importing the component never pulls a live execution path into the test.
vi.mock("@/lib/instantTradeRouter", () => ({
  executeInstantTrade: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { OpenLivePositions } from "./OpenLivePositions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        // NOTE: the component sets `retry: 2` itself, which overrides any
        // client-level `retry`. We deliberately do NOT try to disable it — the
        // retry is part of the behaviour under test. We only collapse the
        // backoff so three attempts resolve immediately instead of ~3s.
        retryDelay: 0,
        gcTime: 0,
        staleTime: 0,
      },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <OpenLivePositions />
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

describe("OpenLivePositions — a failed fetch must never read as 'flat'", () => {
  it("renders the error state, NOT 'No open live positions', on a 500", async () => {
    stubFetch({ ok: false, status: 500, body: { error: "INTERNAL" } });
    renderCard();

    const err = await screen.findByTestId("live-positions-error");
    expect(err).toBeTruthy();
    // The decisive assertion: the empty state must be absent.
    expect(screen.queryByTestId("live-positions-empty")).toBeNull();
    expect(screen.queryByText(/No open live positions/i)).toBeNull();
    // The copy must actively warn against the "I am flat" reading.
    expect(err.textContent ?? "").toMatch(/do not assume you are flat/i);
    expect(screen.getByTestId("btn-retry-live-positions")).toBeTruthy();
  });

  it("renders the error state on a 502 with an empty body (no JSON to parse)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: false,
          status: 502,
          json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
          text: async () => "",
        }) as unknown as Response,
      ),
    );
    renderCard();

    expect(await screen.findByTestId("live-positions-error")).toBeTruthy();
    expect(screen.queryByTestId("live-positions-empty")).toBeNull();
    // Never leak the raw parser/status error at the trader.
    expect(screen.queryByText(/Unexpected end of JSON input/)).toBeNull();
  });

  it("renders the error state on a network rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderCard();

    expect(await screen.findByTestId("live-positions-error")).toBeTruthy();
    expect(screen.queryByTestId("live-positions-empty")).toBeNull();
  });

  it("shows a loading state — never the empty state — while the fetch is in flight", async () => {
    let release: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => { release = r; });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    renderCard();

    expect(await screen.findByTestId("live-positions-loading")).toBeTruthy();
    expect(screen.queryByTestId("live-positions-empty")).toBeNull();
    expect(screen.queryByTestId("live-positions-error")).toBeNull();

    release({
      ok: true,
      status: 200,
      json: async () => ({ items: [], count: 0 }),
    } as unknown as Response);

    // Only once the 200 lands may the empty state appear.
    await waitFor(() => expect(screen.getByTestId("live-positions-empty")).toBeTruthy());
  });

  it("renders the empty state ONLY on a confirmed 200 with zero rows", async () => {
    stubFetch({ ok: true, status: 200, body: { items: [], count: 0 } });
    renderCard();

    expect(await screen.findByTestId("live-positions-empty")).toBeTruthy();
    expect(screen.queryByTestId("live-positions-error")).toBeNull();
  });

  it("renders rows on a confirmed 200 with open positions", async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: {
        items: [{
          id: 1, brokerPositionId: "111", symbol: "EURUSD", direction: "BUY",
          lotSize: 0.10, entryPrice: 1.1, currentPrice: 1.2,
          stopLoss: null, takeProfit: null, unrealizedProfitLoss: 10,
          openedAt: null, status: "OPEN",
        }],
        count: 1,
      },
    });
    renderCard();

    expect(await screen.findByText("EURUSD")).toBeTruthy();
    expect(screen.queryByTestId("live-positions-empty")).toBeNull();
    expect(screen.queryByTestId("live-positions-error")).toBeNull();
  });
});
