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
