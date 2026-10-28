// Trading Calendar truth: the page must show the calendar that matches the
// user's real trading mode. GET /api/me/trading/mode returns
// { ok, envelope: { tradingMode }, perUserTradingMode: { mode } }
// (api-server/src/routes/meTradingMode.ts) — there is no top-level
// tradingMode, so reading one left a LIVE trader on their demo calendar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TradingCalendarPage from "./trading-calendar";

type Route = { status?: number; body: unknown };
let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

function serve(r: Record<string, Route>) {
  routes = r;
  fetchMock = vi.fn(async (input: string) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const hit = key ? routes[key] : { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TradingCalendarPage /></QueryClientProvider>);
}

function modeResp(tradingMode: string) {
  return {
    ok: true,
    envelope: { tradingMode },
    perUserTradingMode: { mode: tradingMode, label: tradingMode },
    disclosure: { version: "v1", text: "x" },
  };
}

const month = new Date().toISOString().slice(0, 7);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Trading Calendar mode", () => {
  it("a LIVE envelope shows the live calendar, not demo P&L", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("LIVE") },
      "/api/me/performance-calendar": {
        body: {
          days: [{ date: `${month}-03`, tradesCount: 2, wins: 1, losses: 1, breakeven: 0, totalPnl: 12.5, totalRisk: 0, bestTrade: 20, worstTrade: -7.5, winRate: 50 }],
          isEmpty: false, currentAccountMode: "PAPER", modeScopeApplied: true,
        },
      },
      "/api/performance/calendar": { body: { calendar: { month, days: [], total_pnl: 999, total_trades: 9, winning_days: 9, losing_days: 0, no_trade_days: 0 } } },
    });
    renderPage();
    expect(await screen.findByText(/from your live trades/)).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/me/performance-calendar?from="))).toBe(true));
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/performance/calendar"))).toBe(false);
    expect(document.body.textContent).not.toMatch(/from your demo trades/);
    expect(screen.queryByTestId("btn-rebuild")).toBeNull();
    // The live day keeps its real P&L, and a live day carries no invented rating.
    const cell = await screen.findByTestId(`day-${month}-03`);
    expect(cell.textContent).toContain("12.50");
    expect(cell.firstElementChild?.textContent).toBe("3");
    // The month grid starts on the 1st, so weekday padding lines up.
    expect(screen.getByTestId(`day-${month}-01`)).toBeTruthy();
  });

  it("a non-LIVE envelope keeps the demo calendar", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("DEMO") },
      "/api/performance/calendar": { body: { calendar: { month, days: [], total_pnl: 0, total_trades: 0, winning_days: 0, losing_days: 0, no_trade_days: 0 } } },
    });
    renderPage();
    expect(await screen.findByText(/from your demo trades/)).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/performance/calendar?month="))).toBe(true));
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/me/performance-calendar"))).toBe(false);
  });

  it("a shared-account live calendar the server did not look up is not shown as 'no live trades'", async () => {
    // GET /me/performance-calendar returns an empty, mode-tagged answer for
    // LIVE_SHARED without reading any trades (mePerformanceCalendar.ts).
    serve({
      "/api/me/trading/mode": { body: modeResp("LIVE") },
      "/api/me/performance-calendar": { body: { days: [], isEmpty: true, currentAccountMode: "LIVE_SHARED", modeScopeApplied: true } },
    });
    renderPage();
    expect(await screen.findByTestId("calendar-not-shown")).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/No live trades recorded/);
    expect(body).not.toMatch(/Net P&L \(month\)/);
    expect(body).not.toMatch(/from your live trades/);
  });
});
