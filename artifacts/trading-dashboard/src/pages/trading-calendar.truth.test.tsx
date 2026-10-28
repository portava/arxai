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

// A failed request is "could not be loaded" — never a crash, a blank board,
// or a demo calendar shown in place of an unknown mode.
describe("Trading Calendar failed loads", () => {
  const SAFETY = { system: "performanceCommandCenter", liveTradingStatus: "DISABLED", mode: "REPORTING_ONLY" };
  const paperDay = { date: `${month}-02`, net_pnl: 4, total_trades: 1, wins: 1, losses: 0, win_rate: 100, day_rating: "B", day_status: "WINNING_DAY", debriefs_created: 0, learning_events_created: 0, symbols_traded: ["EURUSD"] };
  const paperCal = { calendar: { month, days: [paperDay], total_pnl: 4, total_trades: 1, winning_days: 1, losing_days: 0, no_trade_days: 0 } };

  it("a 500 from the calendar route says the calendar could not be loaded", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("DEMO") },
      "/api/performance/calendar": { status: 500, body: { ...SAFETY, error: "boom" } },
    });
    renderPage();
    const err = await screen.findByTestId("calendar-load-error");
    expect(err.textContent).toMatch(/could not be loaded/);
    expect(document.body.textContent).not.toMatch(/Net P&L \(month\)/);
  });

  it("a 500 from the live calendar route says the calendar could not be loaded", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("LIVE") },
      "/api/me/performance-calendar": { status: 500, body: { error: "boom" } },
    });
    renderPage();
    expect((await screen.findByTestId("calendar-load-error")).textContent).toMatch(/could not be loaded/);
    expect(document.body.textContent).not.toMatch(/No live trades recorded/);
  });

  it("a failed mode check is not shown as the demo calendar", async () => {
    serve({
      "/api/me/trading/mode": { status: 401, body: { ok: false, error: "NOT_AUTHENTICATED" } },
      "/api/performance/calendar": { body: paperCal },
    });
    renderPage();
    expect((await screen.findByTestId("calendar-mode-error")).textContent).toMatch(/could not be loaded/);
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/from your demo trades/);
    expect(body).not.toMatch(/from your live trades/);
    expect(screen.queryByTestId("btn-rebuild")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("performance"))).toBe(false);
  });

  it("a 500 from the day route says the day could not be loaded", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("DEMO") },
      "/api/performance/calendar": { body: paperCal },
      "/api/performance/day": { status: 500, body: { ...SAFETY, error: "boom" } },
    });
    renderPage();
    (await screen.findByTestId(`day-${month}-02`)).click();
    const err = await screen.findByTestId("day-load-error");
    expect(err.textContent).toMatch(/could not be loaded/);
    expect(err.textContent).toContain(`${month}-02`);
  });
});
