// Trading Calendar truth: what each cell and the day detail claim.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { default: TradingCalendarPage } = await import("./trading-calendar");

type Routes = Record<string, unknown>;

function mockFetch(routes: Routes) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const body = key ? routes[key] : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TradingCalendarPage /></QueryClientProvider>);
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
      "/api/me/trading/mode": { tradingMode: "PAPER" },
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
      "/api/me/trading/mode": { tradingMode: "LIVE" },
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
      "/api/me/trading/mode": { tradingMode: "PAPER" },
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
      "/api/me/trading/mode": { tradingMode: "LIVE" },
      "/api/me/performance-calendar/": { date: `${MONTH}-02`, totalPnl: 0, tradesCount: 1, winRate: 0, trades: [{ id: 5, symbol: "EURUSD", side: "buy", pnl: null, entryPrice: 1.1, exitPrice: 1.1 }] },
      "/api/me/performance-calendar": { days: [{ date: `${MONTH}-02`, totalPnl: 0, tradesCount: 1, wins: 0, losses: 0, winRate: 0 }] },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId(`day-${MONTH}-02`));
    const cell = await screen.findByTestId("trade-pnl-5");
    expect(cell.textContent).not.toMatch(/0\.00/);
  });
});
