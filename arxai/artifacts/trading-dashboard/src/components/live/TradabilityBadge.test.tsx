// Truth audit 2026-10-28 — useTradability resolves a failed lookup (5xx, 401,
// 8s abort, network error) to a settled `null` verdict. The badge used to
// treat that null exactly like an in-flight request and read "Checking
// tradability…" forever. A finished, failed check must say it could not be
// loaded, never that it is still checking.
//
// The badge renders what /api/market-data/tradability decided. A failed
// lookup (the hook resolves it to null) is "could not be loaded", never an
// endless "Checking…"; a verdict is shown with the server's own copy.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The "TradabilityBadge" block drives the hook's result directly through
// `query`; while it is null the real hook runs, so the "failed lookup" block
// goes through fetch.
type HookResult = { data: unknown; isPending: boolean; isFetching: boolean };
let query: HookResult | null = null;
vi.mock("@/lib/useTradability", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/useTradability")>();
  return {
    ...real,
    useTradability: (symbol: string) =>
      (query ?? real.useTradability(symbol)) as ReturnType<typeof real.useTradability>,
  };
});

import { TradabilityBadge } from "./TradabilityBadge";

function renderBadge() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TradabilityBadge symbol="EURUSD" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  query = null;
});

describe("TradabilityBadge — failed lookup", () => {
  it.each([
    ["HTTP 500", () => Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false }) })],
    ["HTTP 401", () => Promise.resolve({ ok: false, status: 401, json: async () => ({}) })],
    ["ok:false body", () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: "tradability_lookup_failed" }) })],
    ["network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("%s: says the check could not be loaded, not 'Checking'", async (_n, impl) => {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal("fetch", fetchMock);
    renderBadge();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const badge = await screen.findByTestId("badge-tradability-unavailable");
    // Merged with fix-2: the failed-lookup badge reads "could not be loaded"
    // (it was "Tradability not verified", which is also a server verdict label).
    expect(badge.textContent).toBe("Tradability could not be loaded");
    expect(screen.queryByText("Checking tradability…")).toBeNull();
    expect(screen.getByTestId("text-tradability-helper").textContent).toMatch(/could not be loaded/);
  });

  it("still says 'Checking' while the request is in flight", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderBadge();
    expect(screen.getByTestId("badge-tradability-loading").textContent).toBe("Checking tradability…");
  });

  it("renders the server's verdict when the lookup answers", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({
        ok: true, symbol: "EURUSD", assetClass: "forex", dataProvider: "external", dataAvailable: true,
        mt5Tradable: "yes", executionProvider: "mt5", liveExecutionAllowed: true,
        badgeLabel: "Tradable via MT5", userMessage: "This market can be traded through your MT5 bridge.",
      }),
    })));
    renderBadge();
    expect((await screen.findByTestId("badge-tradability")).textContent).toBe("Tradable via MT5");
  });
});

describe("TradabilityBadge", () => {
  it("shows 'Checking…' only while the request is in flight", () => {
    query = { data: undefined, isPending: true, isFetching: true };
    render(<TradabilityBadge symbol="EURUSD" />);
    expect(screen.getByTestId("badge-tradability-loading").textContent).toMatch(/Checking/);
  });

  it("a failed lookup reads 'could not be loaded', not 'Checking…'", () => {
    query = { data: null, isPending: false, isFetching: false };
    render(<TradabilityBadge symbol="EURUSD" />);
    expect(screen.queryByTestId("badge-tradability-loading")).toBeNull();
    expect(screen.getByTestId("badge-tradability-unavailable").textContent).toBe("Tradability could not be loaded");
    expect(screen.getByTestId("text-tradability-helper").textContent).toMatch(/was not checked/);
  });

  it("an allowed market shows the server label and copy, which make no bridge-connection claim", () => {
    query = {
      data: {
        ok: true, symbol: "EURUSD", assetClass: "forex", dataProvider: "external", dataAvailable: true,
        mt5Tradable: "yes", executionProvider: "mt5", liveExecutionAllowed: true,
        badgeLabel: "Allowed for MT5 live",
        userMessage: "EURUSD is on your live market list and is an ARX Focus market — that is all this label checks. The MT5 bridge connection, the broker's symbol list, governance rules and every live safety gate are checked only when an order is submitted.",
      },
      isPending: false, isFetching: false,
    };
    render(<TradabilityBadge symbol="EURUSD" />);
    expect(screen.getByTestId("badge-tradability").textContent).toBe("Allowed for MT5 live");
    expect(screen.getByTestId("text-tradability-helper").textContent).not.toMatch(/connected MT5 bridge/);
  });
});
