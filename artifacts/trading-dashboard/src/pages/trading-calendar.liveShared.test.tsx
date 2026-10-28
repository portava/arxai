// Truth: /api/performance/calendar withholds the paper book from a
// LIVE_SHARED session and says the live month is unknown (null totals and a
// modeNote). The page must show that note, not "…from your demo trades" and
// a green Net P&L of 0.00, and the day detail must not show a rating or a
// profit factor the server did not compute. A failed load is "could not be
// loaded", not an empty month.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { default: TradingCalendarPage } = await import("./trading-calendar");

const LIVE_NOTE = "This is a live account. The ARX calendar only totals paper trades and does not total live trades yet, so live P&L, trade counts and winning or losing days are not shown here. They are not zero.";
const DAY_NOTE = "This is a live account. ARX does not total live trades by day yet, so this day's live P&L, win rate, profit factor and rating are not shown. They are not zero.";

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function renderPage(handler: (url: string) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => handler(String(input))));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><TradingCalendarPage /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("trading calendar — LIVE_SHARED", () => {
  it("shows the server's live note, not demo copy and 0.00", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, perUserTradingMode: { mode: "LIVE" } });
      if (url.startsWith("/api/performance/calendar")) {
        return json({
          calendar: { month: "2026-10", days: [], total_pnl: null, total_trades: null, winning_days: null, losing_days: null, no_trade_days: null },
          currentAccountMode: "LIVE_SHARED", modeScopeApplied: true, liveAggregation: "NOT_AVAILABLE", modeNote: LIVE_NOTE,
        });
      }
      return json({}, 404);
    });
    await waitFor(() => expect(screen.getByTestId("calendar-mode-note").textContent).toContain("not zero"));
    expect(screen.queryByText(/from your demo trades/)).toBeNull();
    expect(screen.queryByText("0.00")).toBeNull();
    expect(screen.getByTestId("calendar-total-pnl").textContent).toMatch(/Not shown/);
    expect(screen.getByTestId("calendar-total-trades").textContent).toMatch(/Not shown/);
    expect(screen.queryByTestId("btn-rebuild")).toBeNull();
  });

  it("day detail: no invented rating, profit factor or win rate", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true });
      if (url.startsWith("/api/performance/calendar")) {
        return json({
          calendar: { month: "2026-10", days: [{ date: "2026-10-27", net_pnl: 0, total_trades: 0, wins: 0, losses: 0, win_rate: 0, day_rating: "C", day_status: "NO_TRADE_DAY", debriefs_created: 0, learning_events_created: 0, symbols_traded: [] }], total_pnl: 0, total_trades: 0, winning_days: 0, losing_days: 0, no_trade_days: 1 },
          modeScopeApplied: true,
        });
      }
      if (url.startsWith("/api/performance/day")) {
        return json({
          day: { date: "2026-10-27", stats: { net_pnl: null, total_trades: null, win_rate: null, profit_factor: null, day_rating: null, top_lesson: null }, trades: [] },
          currentAccountMode: "LIVE_SHARED", liveAggregation: "NOT_AVAILABLE", modeNote: DAY_NOTE,
        });
      }
      return json({}, 404);
    });
    fireEvent.click(await screen.findByTestId("day-2026-10-27"));
    const card = await screen.findByTestId("day-detail-card");
    await waitFor(() => expect(card.textContent).toContain("not zero"));
    expect(card.textContent).not.toMatch(/Day Rating\s*F/);
    expect(card.textContent).not.toMatch(/Profit Factor\s*0/);
    expect(card.textContent).not.toMatch(/0\.0%/);
    expect(card.textContent).toMatch(/Not rated/);
    expect(card.textContent).not.toContain("No trades on this day.");
  });

  it("a failed calendar load says it could not be loaded", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true });
      if (url.startsWith("/api/performance/calendar")) return json({ error: "boom" }, 500);
      return json({}, 404);
    });
    await waitFor(() => expect(screen.getByTestId("calendar-load-error").textContent).toMatch(/could not be loaded/i));
    expect(screen.queryByText("0.00")).toBeNull();
  });
});
