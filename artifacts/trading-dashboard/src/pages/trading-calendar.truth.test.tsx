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

let lastClient: QueryClient;
function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = qc;
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

// A closed live trade whose P&L the EA has not reported yet has pnl NULL in
// shared_trade_attribution. It must not read as a measured green 0.00 trade,
// a 0.00 break-even day, or a 0.00 month.
describe("Trading Calendar live P&L not recorded", () => {
  const liveDay = (extra: Record<string, unknown>) => ({
    date: `${month}-03`, tradesCount: 1, wins: 0, losses: 0, breakeven: 1, totalPnl: 0, totalRisk: 0,
    bestTrade: 0, worstTrade: 0, winRate: 0, ...extra,
  });
  const dayDetail = (trades: unknown[], extra: Record<string, unknown> = {}) => ({
    date: `${month}-03`, tradesCount: trades.length, wins: 0, losses: 0, breakeven: trades.length, totalPnl: 0,
    totalRisk: 0, bestTrade: 0, worstTrade: 0, winRate: 0, trades, currentAccountMode: "PAPER", modeScopeApplied: true, ...extra,
  });
  const nullTrade = { id: 77, symbol: "EURUSD", side: "BUY", pnl: null, lotSize: 1, entryPrice: 1.08, exitPrice: 1.09, strategyTag: null, closedAt: `${month}-03T10:00:00.000Z` };

  it("a closed live trade with no recorded P&L is not a green 0.00, a break-even day or a 0.00 month", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("LIVE") },
      "/api/me/performance-calendar/": { body: dayDetail([nullTrade], { pnlNotRecorded: 1 }) },
      "/api/me/performance-calendar?": {
        body: { days: [liveDay({ pnlNotRecorded: 1 })], isEmpty: false, currentAccountMode: "PAPER", modeScopeApplied: true },
      },
    });
    renderPage();
    const cell = await screen.findByTestId(`day-${month}-03`);
    expect(cell.textContent).not.toContain("0.00");
    expect(cell.textContent).toMatch(/not recorded/);
    expect(cell.className).not.toMatch(/amber|emerald|rose/);
    const monthPnl = screen.getByTestId("month-net-pnl");
    expect(monthPnl.textContent).not.toContain("0.00");
    expect(monthPnl.textContent).toMatch(/Not recorded/);
    expect(monthPnl.innerHTML).not.toMatch(/emerald/);

    cell.click();
    const row = await screen.findByTestId("trade-row-77");
    expect(row.textContent).toMatch(/P&L not recorded/);
    expect(row.textContent).not.toContain("0.00");
    expect(row.innerHTML).not.toMatch(/emerald/);
    const dayPnl = screen.getByTestId("day-net-pnl");
    expect(dayPnl.textContent).toMatch(/Not recorded/);
    expect(dayPnl.innerHTML).not.toMatch(/emerald/);
    expect(screen.getByTestId("day-pnl-not-recorded").textContent).toMatch(/1 of 1 closed trades/);
  });

  it("a day with one recorded and one unrecorded P&L shows a partial total, not a measured result", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("LIVE") },
      "/api/me/performance-calendar/": {
        body: dayDetail([{ ...nullTrade, id: 78, pnl: 5 }, nullTrade], { tradesCount: 2, wins: 1, breakeven: 1, totalPnl: 5, winRate: 50, pnlNotRecorded: 1 }),
      },
      "/api/me/performance-calendar?": {
        body: { days: [liveDay({ tradesCount: 2, wins: 1, breakeven: 1, totalPnl: 5, winRate: 50, pnlNotRecorded: 1 })], isEmpty: false, currentAccountMode: "PAPER", modeScopeApplied: true },
      },
    });
    renderPage();
    const cell = await screen.findByTestId(`day-${month}-03`);
    expect(cell.textContent).toMatch(/1 P&L not recorded/);
    expect(cell.textContent).not.toMatch(/50%w/);
    expect(cell.className).not.toMatch(/emerald/);
    expect(screen.getByTestId("month-net-pnl").textContent).toMatch(/5\.00 \(partial\)/);
    // A day whose P&L is only partly recorded is not counted as a winning day.
    expect(document.body.textContent).toMatch(/Winning Days0/);

    cell.click();
    expect((await screen.findByTestId("trade-row-78")).textContent).toContain("5.00");
    expect(screen.getByTestId("trade-row-77").textContent).toMatch(/P&L not recorded/);
    expect(screen.getByTestId("day-net-pnl").textContent).toMatch(/5\.00 \(partial\)/);
    expect(document.body.textContent).not.toMatch(/50\.0%/);
  });

  it("an older server without pnlNotRecorded still shows the day detail's null P&L as not recorded", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("LIVE") },
      "/api/me/performance-calendar/": { body: dayDetail([nullTrade]) },
      "/api/me/performance-calendar?": {
        body: { days: [liveDay({})], isEmpty: false, currentAccountMode: "PAPER", modeScopeApplied: true },
      },
    });
    renderPage();
    (await screen.findByTestId(`day-${month}-03`)).click();
    const row = await screen.findByTestId("trade-row-77");
    expect(row.textContent).toMatch(/P&L not recorded/);
    expect(screen.getByTestId("day-net-pnl").textContent).toMatch(/Not recorded/);
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

  it("a failed mode re-check hides the month cards and day detail it can no longer place as live or demo", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("DEMO") },
      "/api/performance/calendar": { body: paperCal },
      "/api/performance/day": { body: { day: { date: `${month}-02`, stats: { net_pnl: 4, total_trades: 1, win_rate: 100, profit_factor: "—", day_rating: "B", top_lesson: null }, trades: [] } } },
    });
    renderPage();
    (await screen.findByTestId(`day-${month}-02`)).click();
    await screen.findByText(/No trades on this day/);
    expect(document.body.textContent).toMatch(/Net P&L \(month\)/);
    // Only the mode read fails on the re-check; the calendar and day reads
    // are not repeated, so React Query still holds their earlier data.
    routes["/api/me/trading/mode"] = { status: 500, body: { error: "boom" } };
    await lastClient.refetchQueries({ queryKey: ["trading-mode-for-calendar"] });
    expect((await screen.findByTestId("calendar-mode-error")).textContent).toMatch(/Nothing is shown until it loads/);
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/Net P&L \(month\)/);
    expect(body).not.toMatch(/Winning Days|Losing Days|Total Trades/);
    expect(screen.queryByTestId("day-detail-card")).toBeNull();
    expect(screen.queryByTestId(`day-${month}-02`)).toBeNull();
  });

  it("a failed live mode re-check also hides 'No live trades recorded yet'", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("LIVE") },
      "/api/me/performance-calendar": { body: { days: [], isEmpty: true, currentAccountMode: "PAPER", modeScopeApplied: true } },
    });
    renderPage();
    expect(await screen.findByText(/No live trades recorded yet/)).toBeTruthy();
    routes["/api/me/trading/mode"] = { status: 500, body: { error: "boom" } };
    await lastClient.refetchQueries({ queryKey: ["trading-mode-for-calendar"] });
    await screen.findByTestId("calendar-mode-error");
    expect(document.body.textContent).not.toMatch(/No live trades recorded yet/);
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

// GET /api/performance/calendar recomputes every day from paper_orders
// (performanceCC/aggregator.ts computeCalendarMonth); POST
// /api/performance/rebuild only rewrites the saved snapshot tables, which the
// calendar never reads. The button must not imply the calendar was rebuilt.
describe("Trading Calendar rebuild button", () => {
  const paperCal = { calendar: { month, days: [], total_pnl: 0, total_trades: 0, winning_days: 0, losing_days: 0, no_trade_days: 0 } };
  const calendarCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/performance/calendar")).length;

  it("says it rebuilds saved snapshots the calendar does not read, and reports what it wrote", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("DEMO") },
      "/api/performance/calendar": { body: paperCal },
      "/api/performance/rebuild": { body: { rebuild: { started_at: "2026-10-28T11:00:00.000Z", finished_at: "2026-10-28T11:00:02.000Z", daily_snapshots_written: 12, symbol_snapshots_written: 3, ai_snapshots_written: 4, warnings: [] } } },
    });
    renderPage();
    const btn = await screen.findByTestId("btn-rebuild");
    expect(btn.textContent).toMatch(/snapshots/i);
    expect(screen.getByTestId("calendar-source-note").textContent).toMatch(/demo orders each time this page loads/);
    await waitFor(() => expect(calendarCalls()).toBe(1));
    btn.click();
    const result = await screen.findByTestId("rebuild-result");
    expect(result.textContent).toMatch(/12 daily snapshots/);
    expect(result.textContent).toMatch(/does not read/);
    // Nothing on the calendar changed, so it is not reloaded as if rebuilt.
    expect(calendarCalls()).toBe(1);
  });

  it("a failed rebuild says the snapshots could not be rebuilt", async () => {
    serve({
      "/api/me/trading/mode": { body: modeResp("DEMO") },
      "/api/performance/calendar": { body: paperCal },
      "/api/performance/rebuild": { status: 500, body: { error: "boom" } },
    });
    renderPage();
    (await screen.findByTestId("btn-rebuild")).click();
    expect((await screen.findByTestId("rebuild-result")).textContent).toMatch(/could not be rebuilt/);
  });
});
