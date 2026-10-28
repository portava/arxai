// ComparisonTab.availability.test.tsx — the Comparison tab's confirmed-empty
// instruction ("No comparison data yet … Run a backtest and a forward test")
// may only appear once both reads have settled and the backtest list was
// actually read as empty. A pending or failed read says so; a non-admin whose
// forward read is refused is never told to run a forward test. Backtest
// figures are never shown as "0 runs" when the backtest read failed.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div data-testid="line-chart">{children}</div>,
  Line: ({ name }: { name: string }) => <span>{name}</span>,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Legend: () => null,
}));

import { ComparisonTab } from "./ComparisonTab";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const FORWARD = {
  totalShadowDecisions: 20, shadowTradesTracked: 9, wins: 5, losses: 4,
  breakevens: 0, expired: 0, rejected: 0, winRate: 55.6,
  avgR: 0.31, maxDrawdownR: 1.75, confidenceCalibration: "NEEDS_MORE_DATA",
  bestSymbol: "EURUSD", worstSymbol: "GBPUSD", bestStrategy: "Trend Continuation", weakestStrategy: "Range Fade",
};

type Route = (url: string) => Promise<Response>;
let route: Route;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string) => route(String(url))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderTab(strategyId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ComparisonTab strategyId={strategyId} />
    </QueryClientProvider>,
  );
}

function routes(map: { backtest: () => Promise<Response>; forward: () => Promise<Response> }): Route {
  return (url) => {
    if (url.startsWith("/api/backtest-runs")) return map.backtest();
    if (url.startsWith("/api/forward-testing/results")) return map.forward();
    if (url.startsWith("/api/forward-testing/chart-series")) return map.forward();
    return Promise.resolve(jsonResponse(404, {}));
  };
}

describe("ComparisonTab — empty state only on a confirmed empty read", () => {
  it("backtest 500 + forward 403 → unavailable, never 'No comparison data yet'", async () => {
    route = routes({
      backtest: async () => jsonResponse(500, { error: "boom" }),
      forward: async () => jsonResponse(403, { error: "Forbidden" }),
    });
    renderTab("meanReversion");
    await waitFor(() => expect(screen.getByText(/Backtest runs could not be loaded/i)).toBeTruthy());
    expect(screen.queryByText(/No comparison data yet/i)).toBeNull();
    expect(screen.queryByText(/Run a backtest and a\s+forward test/i)).toBeNull();
    expect(screen.getByText(/Forward results are unavailable for this account/i)).toBeTruthy();
  });

  it("reads still in flight → loading, never 'No comparison data yet'", async () => {
    route = () => new Promise<Response>(() => {});
    renderTab();
    expect(screen.getByText(/Loading comparison data/i)).toBeTruthy();
    expect(screen.queryByText(/No comparison data yet/i)).toBeNull();
  });

  it("empty backtest list + forward 403 → no instruction to run a forward test the account cannot access", async () => {
    route = routes({
      backtest: async () => jsonResponse(200, { runs: [] }),
      forward: async () => jsonResponse(403, { error: "Forbidden" }),
    });
    renderTab("meanReversion");
    await waitFor(() => expect(screen.getByText(/No backtest runs yet for meanReversion/i)).toBeTruthy());
    expect(screen.queryByText(/Run a backtest and a\s+forward test/i)).toBeNull();
    expect(screen.getByText(/Forward results are unavailable for this account/i)).toBeTruthy();
  });

  it("both reads confirmed empty → the honest empty state is kept", async () => {
    route = routes({
      backtest: async () => jsonResponse(200, { runs: [] }),
      forward: async () => jsonResponse(200, { ...FORWARD, totalShadowDecisions: 0, shadowTradesTracked: 0, wins: 0, losses: 0 }),
    });
    renderTab();
    await waitFor(() => expect(screen.getByText(/No comparison data yet/i)).toBeTruthy());
  });

  it("backtest 500 while forward has trades → backtest card says unavailable, not 'Runs 0'", async () => {
    route = routes({
      backtest: async () => jsonResponse(500, { error: "boom" }),
      forward: async () => jsonResponse(200, FORWARD),
    });
    renderTab();
    await waitFor(() => expect(screen.getByText("Backtest diagnostics")).toBeTruthy());
    expect(screen.getByText(/Backtest runs could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText("Runs")).toBeNull();
  });
});
