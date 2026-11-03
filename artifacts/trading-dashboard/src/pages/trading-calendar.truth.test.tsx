// Trading Calendar truth: the page must show the calendar that matches the
// user's real trading mode. GET /api/me/trading/mode returns
// { ok, envelope: { tradingMode }, perUserTradingMode: { mode } }
// (api-server/src/routes/meTradingMode.ts) — there is no top-level
// tradingMode, so reading one left a LIVE trader on their demo calendar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(await screen.findByText(/win rate from your closed live trades/)).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/me/performance-calendar?from="))).toBe(true));
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/performance/calendar"))).toBe(false);
    expect(document.body.textContent).not.toMatch(/from your (demo trades|simulated orders)/);
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
    expect(await screen.findByText(/AI activity from your simulated orders/)).toBeTruthy();
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
    // Merged with fix-0: the month's totals are shown as unknown ("Not shown"),
    // never as a 0.00 month, instead of the tiles being left out.
    expect(screen.getByTestId("calendar-total-pnl").textContent).toMatch(/Not shown/);
    expect(screen.getByTestId("calendar-total-trades").textContent).toMatch(/Not shown/);
    expect(body).not.toMatch(/0\.00/);
    expect(body).not.toMatch(/from your (closed )?live trades/);
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
    expect(body).not.toMatch(/from your (demo trades|simulated orders)/);
    expect(body).not.toMatch(/from your (closed )?live trades/);
    expect(screen.queryByTestId("btn-rebuild")).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("performance"))).toBe(false);
  });

  // The review scenario: the mode read rejects (network error) or returns a
  // non-JSON proxy 502. The calendar query never runs, so the page must still
  // say the mode could not be loaded rather than a header over an empty grid.
  for (const [label, impl] of [
    ["a network error", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a non-JSON 502", () => Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 502 }))],
  ] as const) {
    it(`a mode read that fails with ${label} says it could not be loaded, not a blank calendar`, async () => {
      fetchMock = vi.fn(async (input: string) => {
        const url = String(input);
        if (url.startsWith("/api/me/trading/mode")) return impl();
        return new Response(JSON.stringify(paperCal), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      renderPage();
      expect((await screen.findByTestId("calendar-mode-error")).textContent).toMatch(/could not be loaded/);
      expect(screen.queryByText("Sun")).toBeNull();
      expect(document.body.textContent).not.toMatch(/from your (demo trades|simulated orders)/);
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("performance"))).toBe(false);
    });
  }

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
    expect(screen.getByTestId("calendar-source-note").textContent).toMatch(/simulated orders each time this page loads/);
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

// ── What each cell and the day detail claim (merged from the calendar truth
// fixes: grades, open/cancelled P&L, source ledger, profit factor). ──
type Routes = Record<string, unknown>;

function mockFetch(routes: Routes) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const body = key ? routes[key] : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

function day(date: string, over: Record<string, unknown> = {}) {
  return {
    date, net_pnl: 0, total_trades: 0, wins: 0, losses: 0, win_rate: 0,
    day_rating: null, day_status: "NO_TRADE_DAY", debriefs_created: 0, learning_events_created: 0,
    symbols_traded: [], is_future: false, ...over,
  };
}

const MONTH = new Date().toISOString().slice(0, 7);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("trading calendar: day grades", () => {
  it("a no-trade day and a future day carry no grade badge; a future day says 'not yet'", async () => {
    mockFetch({
      "/api/me/trading/mode": { ok: true, envelope: { tradingMode: "PAPER" } },
      "/api/performance/calendar": {
        calendar: {
          month: MONTH, total_pnl: 2, total_trades: 1, winning_days: 1, losing_days: 0, no_trade_days: 1,
          days: [
            day(`${MONTH}-01`),
            day(`${MONTH}-02`, { net_pnl: 2, total_trades: 1, wins: 1, win_rate: 100, day_rating: "A", day_status: "WINNING_DAY" }),
            day(`${MONTH}-03`, { is_future: true }),
          ],
        },
      },
      "/api/performance/day": {
        day: { date: `${MONTH}-01`, stats: { net_pnl: 0, total_trades: 0, win_rate: 0, profit_factor: null, day_rating: null, top_lesson: "" }, trades: [] },
      },
    });
    renderPage();
    await screen.findByTestId(`day-${MONTH}-01`);
    expect(screen.getByTestId(`day-${MONTH}-01`).textContent).not.toMatch(/F/);
    expect(screen.queryByTestId(`day-rating-${MONTH}-01`)).toBeNull();
    expect(screen.queryByTestId(`day-rating-${MONTH}-03`)).toBeNull();
    expect(screen.getByTestId(`day-rating-${MONTH}-02`).textContent).toBe("A");
    expect(screen.getByTestId(`day-${MONTH}-03`).textContent).toMatch(/not yet/);
    expect(screen.getByTestId(`day-${MONTH}-03`).textContent).not.toMatch(/no trades/);

    fireEvent.click(screen.getByTestId(`day-${MONTH}-01`));
    const detail = await screen.findByTestId("day-detail-rating");
    await waitFor(() => expect(detail.textContent).toMatch(/Not rated/));
    expect(detail.textContent).not.toMatch(/^F$/);
  });

  it("live days are not given an invented grade", async () => {
    mockFetch({
      "/api/me/trading/mode": { ok: true, envelope: { tradingMode: "LIVE" } },
      "/api/me/performance-calendar": { days: [{ date: `${MONTH}-02`, totalPnl: -5, tradesCount: 2, wins: 0, losses: 2, winRate: 0 }] },
    });
    renderPage();
    await screen.findByTestId(`day-${MONTH}-02`);
    expect(screen.queryByTestId(`day-rating-${MONTH}-02`)).toBeNull();
    // It used to print a "C" badge on every live day, whatever the result.
    expect(screen.getByTestId(`day-${MONTH}-02`).textContent).not.toMatch(/C/);
  });
});

describe("trading calendar: day detail P&L", () => {
  it("an open or cancelled order shows no P&L, not a green 0.00 (also when an older server sends 0)", async () => {
    mockFetch({
      "/api/me/trading/mode": { ok: true, envelope: { tradingMode: "PAPER" } },
      "/api/performance/calendar": {
        calendar: { month: MONTH, total_pnl: 0, total_trades: 0, winning_days: 0, losing_days: 0, no_trade_days: 1, days: [day(`${MONTH}-01`)] },
      },
      "/api/performance/day": {
        day: {
          date: `${MONTH}-01`,
          stats: { net_pnl: 2, total_trades: 1, win_rate: 100, profit_factor: null, day_rating: "A", top_lesson: "" },
          trades: [
            { trade_id: 12, symbol: "EURUSD", action: "BUY", status: "OPEN", pnl: null, pnl_note: "Still open — no realized P&L yet (unrealized P&L is not recorded on the order).", entry_price: 1.1, exit_price: null, stop_loss: 1.09, take_profit: 1.12, decision_id: null },
            { trade_id: 13, symbol: "EURUSD", action: "SELL", status: "CANCELLED", pnl: 0, entry_price: 1.1, exit_price: null, stop_loss: 1.11, take_profit: 1.08, decision_id: null },
            { trade_id: 14, symbol: "EURUSD", action: "BUY", status: "CLOSED_TP", pnl: 2, pnl_note: null, entry_price: 1.1, exit_price: 1.12, stop_loss: 1.09, take_profit: 1.12, decision_id: null },
          ],
        },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId(`day-${MONTH}-01`));
    const open = await screen.findByTestId("trade-pnl-12");
    expect(open.textContent).not.toMatch(/0\.00/);
    expect(open.textContent).toMatch(/no realized P&L/);
    expect(open.className).not.toMatch(/emerald/);
    const cancelled = screen.getByTestId("trade-pnl-13");
    expect(cancelled.textContent).not.toMatch(/0\.00/);
    expect(cancelled.textContent).toMatch(/Cancelled/);
    expect(screen.getByTestId("trade-pnl-14").textContent).toBe("2.00");
  });

  it("a live trade with no recorded P&L is not shown as 0.00", async () => {
    mockFetch({
      "/api/me/trading/mode": { ok: true, envelope: { tradingMode: "LIVE" } },
      "/api/me/performance-calendar/": { date: `${MONTH}-02`, totalPnl: 0, tradesCount: 1, winRate: 0, trades: [{ id: 5, symbol: "EURUSD", side: "buy", pnl: null, entryPrice: 1.1, exitPrice: 1.1 }] },
      "/api/me/performance-calendar": { days: [{ date: `${MONTH}-02`, totalPnl: 0, tradesCount: 1, wins: 0, losses: 0, winRate: 0 }] },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId(`day-${MONTH}-02`));
    const cell = await screen.findByTestId("trade-pnl-5");
    expect(cell.textContent).not.toMatch(/0\.00/);
  });
});

describe("trading calendar: source", () => {
  it("names its ledger (simulated orders) and says My Demo Trades' hand-logged trades are separate", async () => {
    mockFetch({
      "/api/me/trading/mode": { ok: true, envelope: { tradingMode: "PAPER" } },
      // An older server sends no source note: the page still names its source.
      "/api/performance/calendar": {
        calendar: { month: MONTH, total_pnl: 0, total_trades: 0, winning_days: 0, losing_days: 0, no_trade_days: 1, days: [day(`${MONTH}-01`)] },
      },
    });
    renderPage();
    await screen.findByTestId(`day-${MONTH}-01`);
    expect(screen.queryByText(/from your demo trades/)).toBeNull();
    const note = screen.getByTestId("calendar-source-note");
    expect(note.textContent).toMatch(/simulated orders/i);
    // Named by the page's visible title, "My Demo Trades".
    expect(note.textContent).toMatch(/My Demo Trades/);
    expect(note.textContent).not.toMatch(/My Performance/);
  });

  it("live mode shows the server's source note", async () => {
    mockFetch({
      "/api/me/trading/mode": { ok: true, envelope: { tradingMode: "LIVE" } },
      "/api/me/performance-calendar": { days: [], source: "live_trades", sourceNote: "From your closed live trades recorded against your account." },
    });
    renderPage();
    const note = await screen.findByTestId("calendar-source-note");
    await waitFor(() => expect(note.textContent).toMatch(/closed live trades recorded against your account/));
  });
});

describe("trading calendar: day profit factor", () => {
  for (const [label, pf] of [["new server (null)", null], ["older server (9.99 cap)", 9.99]] as const) {
    it(`no losing trade: profit factor is undefined, not 9.99 — ${label}`, async () => {
      mockFetch({
        "/api/me/trading/mode": { ok: true, envelope: { tradingMode: "PAPER" } },
        "/api/performance/calendar": {
          calendar: { month: MONTH, total_pnl: 2, total_trades: 1, winning_days: 1, losing_days: 0, no_trade_days: 0, days: [day(`${MONTH}-01`, { total_trades: 1, wins: 1, net_pnl: 2, day_rating: "A", day_status: "WINNING_DAY" })] },
        },
        "/api/performance/day": {
          day: { date: `${MONTH}-01`, stats: { net_pnl: 2, total_trades: 1, wins: 1, losses: 0, win_rate: 100, profit_factor: pf, day_rating: "A", top_lesson: "" }, trades: [] },
        },
      });
      renderPage();
      fireEvent.click(await screen.findByTestId(`day-${MONTH}-01`));
      const cell = await screen.findByTestId("day-detail-profit-factor");
      expect(cell.textContent).not.toMatch(/9\.99/);
      expect(cell.textContent).toMatch(/No losses/);
    });
  }

  it("a measured profit factor is shown", async () => {
    mockFetch({
      "/api/me/trading/mode": { ok: true, envelope: { tradingMode: "PAPER" } },
      "/api/performance/calendar": {
        calendar: { month: MONTH, total_pnl: 1.5, total_trades: 2, winning_days: 1, losing_days: 0, no_trade_days: 0, days: [day(`${MONTH}-01`, { total_trades: 2 })] },
      },
      "/api/performance/day": {
        day: { date: `${MONTH}-01`, stats: { net_pnl: 1.5, total_trades: 2, wins: 1, losses: 1, win_rate: 50, profit_factor: 2, day_rating: "B", top_lesson: "" }, trades: [] },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId(`day-${MONTH}-01`));
    expect((await screen.findByTestId("day-detail-profit-factor")).textContent).toBe("2.00");
  });
});
