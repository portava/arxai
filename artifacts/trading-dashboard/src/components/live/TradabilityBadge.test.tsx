// Truth audit 2026-10-28 — useTradability resolves a failed lookup (5xx, 401,
// 8s abort, network error) to a settled `null` verdict. The badge used to
// treat that null exactly like an in-flight request and read "Checking
// tradability…" forever. A finished, failed check must say it could not be
// loaded, never that it is still checking.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
    expect(badge.textContent).toBe("Tradability not verified");
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
