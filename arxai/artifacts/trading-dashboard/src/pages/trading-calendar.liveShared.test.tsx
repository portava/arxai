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

// GET /api/me/trading/mode must carry envelope.tradingMode (the page treats a
// reply without it as "mode could not be loaded"); a non-LIVE envelope sends
// the page to /api/performance/calendar, the route that withholds LIVE_SHARED.
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
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, envelope: { tradingMode: "DEMO" }, perUserTradingMode: { mode: "LIVE" } });
      if (url.startsWith("/api/performance/calendar")) {
        return json({
          calendar: { month: "2026-10", days: [], total_pnl: null, total_trades: null, winning_days: null, losing_days: null, no_trade_days: null },
          currentAccountMode: "LIVE_SHARED", modeScopeApplied: true, liveAggregation: "NOT_AVAILABLE", modeNote: LIVE_NOTE,
        });
      }
      return json({}, 404);
    });
    await waitFor(() => expect(screen.getByTestId("calendar-mode-note").textContent).toContain("not zero"));
    expect(screen.queryByText(/from your (demo trades|simulated orders)/)).toBeNull();
    expect(screen.queryByText("0.00")).toBeNull();
    expect(screen.getByTestId("calendar-total-pnl").textContent).toMatch(/Not shown/);
    expect(screen.getByTestId("calendar-total-trades").textContent).toMatch(/Not shown/);
    expect(screen.queryByTestId("btn-rebuild")).toBeNull();
  });

  // The LIVE_SHARED placeholder read no ledger and sends no source_note. The
  // page's fallback notes ("From your simulated orders…", "From your closed
  // live trades…") name a ledger the server never read, so neither is shown.
  it("names no ledger it did not read: no source note for the placeholder month (paper route)", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, envelope: { tradingMode: "DEMO" } });
      if (url.startsWith("/api/performance/calendar")) {
        return json({
          calendar: { month: "2026-10", days: [], total_pnl: null, total_trades: null, winning_days: null, losing_days: null, no_trade_days: null },
          currentAccountMode: "LIVE_SHARED", modeScopeApplied: true, liveAggregation: "NOT_AVAILABLE", modeNote: LIVE_NOTE,
        });
      }
      return json({}, 404);
    });
    await waitFor(() => expect(screen.getByTestId("calendar-mode-note").textContent).toBe(LIVE_NOTE));
    expect(screen.queryByTestId("calendar-source-note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Paper Autopilot and simulated trade tickets/);
    expect(document.body.textContent).not.toMatch(/simulated orders/i);
  });

  it("names no ledger it did not read: no source note for the placeholder month (live route)", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, envelope: { tradingMode: "LIVE" } });
      if (url.startsWith("/api/me/performance-calendar")) {
        return json({ days: [], isEmpty: true, source: "withheld_live_shared", currentAccountMode: "LIVE_SHARED", modeScopeApplied: true });
      }
      return json({}, 404);
    });
    expect(await screen.findByTestId("calendar-not-shown")).toBeTruthy();
    expect(screen.queryByTestId("calendar-source-note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/closed live trades recorded against your account/i);
  });

  // Which ledger the page reads is only known once the calendar reply says
  // whether it is withheld (notShownHere). While it loads, or after it fails,
  // the page used to fall back to "From your simulated orders…" for a
  // LIVE_SHARED account — a ledger the server never reads for it — and kept
  // it next to "could not be loaded".
  it("a failed calendar load names no ledger (no 'simulated orders' source note)", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, envelope: { tradingMode: "DEMO" }, perUserTradingMode: { mode: "LIVE" } });
      if (url.startsWith("/api/performance/calendar")) return json({ error: "boom" }, 500);
      return json({}, 404);
    });
    await waitFor(() => expect(screen.getByTestId("calendar-load-error").textContent).toMatch(/could not be loaded/i));
    expect(screen.queryByTestId("calendar-source-note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/simulated orders/i);
    expect(document.body.textContent).not.toMatch(/Paper Autopilot and simulated trade tickets/);
  });

  it("a failed live calendar load names no ledger (no 'closed live trades' source note)", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, envelope: { tradingMode: "LIVE" } });
      if (url.startsWith("/api/me/performance-calendar")) return json({ error: "boom" }, 500);
      return json({}, 404);
    });
    await waitFor(() => expect(screen.getByTestId("calendar-load-error").textContent).toMatch(/could not be loaded/i));
    expect(screen.queryByTestId("calendar-source-note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/from your closed live trades/i);
    expect(document.body.textContent).not.toMatch(/closed live trades recorded against your account/i);
  });

  it("while the calendar loads it says it is checking, not which ledger it reads", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, envelope: { tradingMode: "DEMO" } });
      if (url.startsWith("/api/performance/calendar")) return new Promise<Response>(() => {});
      return json({}, 404);
    });
    await waitFor(() => expect(screen.getByText(/Checking which trades this calendar reads/)).toBeTruthy());
    expect(screen.queryByTestId("calendar-source-note")).toBeNull();
    expect(document.body.textContent).not.toMatch(/simulated orders/i);
  });

  it("day detail: no invented rating, profit factor or win rate", async () => {
    renderPage((url) => {
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, envelope: { tradingMode: "DEMO" } });
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
      if (url.startsWith("/api/me/trading/mode")) return json({ ok: true, envelope: { tradingMode: "DEMO" } });
      if (url.startsWith("/api/performance/calendar")) return json({ error: "boom" }, 500);
      return json({}, 404);
    });
    await waitFor(() => expect(screen.getByTestId("calendar-load-error").textContent).toMatch(/could not be loaded/i));
    expect(screen.queryByText("0.00")).toBeNull();
  });
});
