// My Demo Trades — demo-trade P/L is (exit − entry) × direction × lot size
// (mePaperTrades.pnlFor). It has no contract size or account currency, so it is
// a price move times lots, not money. The page printed it bare ("PnL: 0.005"),
// with float noise (0.30000000000000004), and a closed trade with no recorded
// P/L showed a blank, red "PnL:".
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import MyPaperTradesPage from "./my-paper-trades";

const trade = (id: number, pnl: number | null) => ({
  id, symbol: "EURUSD", side: "buy", status: "closed", entryType: "market",
  plannedEntryPrice: null, entryPrice: 1.085, exitPrice: 1.09, stopLoss: null, takeProfit: null,
  lotSize: 1, riskAmount: null, rewardRiskRatio: null, pnl, pnlPercent: null,
  openedAt: "2026-10-27T09:00:00.000Z", closedAt: "2026-10-27T10:00:00.000Z", cancelledAt: null,
  strategyTag: null, setupGrade: null, reasonForEntry: null, notes: null, createdAt: "2026-10-27T09:00:00.000Z",
});

const EMPTY_INSIGHTS = { isEmpty: true, sampleSize: 0, insights: [], byStrategy: [], topSymbols: [], topMistakes: [], averages: { avgWin: 0, avgLoss: 0, expectancy: 0 }, bestDay: null, worstDay: null };

function stub(trades: unknown[], days: unknown[], totalPnl: number, insights: unknown = EMPTY_INSIGHTS, summaryOver: Record<string, unknown> = {}, source = "paper_trades") {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response;
    if (u.endsWith("/api/me/paper-trades")) return ok({ trades });
    if (u.endsWith("/api/me/trade-journal")) return ok({ entries: [] });
    if (u.endsWith("/api/me/performance-calendar")) return ok({ days, isEmpty: days.length === 0, source });
    if (u.endsWith("/api/me/performance-summary")) return ok({ totalTrades: trades.length, totalPnl, wins: 1, losses: 0, winRate: 50, isEmpty: false, source, ...summaryOver });
    if (u.endsWith("/api/me/ai-trade-reviews")) return ok({ reviews: [] });
    if (u.endsWith("/api/me/performance-insights")) return ok(insights);
    if (u.endsWith("/api/me/coaching-plan")) return ok({ isEmpty: true, sampleSize: 0, topStrengths: [], topWeaknesses: [], topMistakes: [] });
    if (u.endsWith("/api/me/playbooks")) return ok({ playbooks: [] });
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));
}

async function renderPage() {
  render(<MyPaperTradesPage />);
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("My Demo Trades — P/L says what unit it is in", () => {
  it("a closed trade's P/L is labelled as price move × lots, not shown as a bare money-like number", async () => {
    stub([trade(1, 0.005)], [], 0.005);
    await renderPage();
    const cell = screen.getByTestId("paper-trade-pnl-1").textContent ?? "";
    expect(cell).toContain("+0.005");
    expect(cell).toMatch(/price move × lots/i);
    expect(screen.getByTestId("paper-pnl-unit-note").textContent).toMatch(/not a money amount/i);
  });

  it("a closed trade with no recorded P/L says so instead of a blank red value", async () => {
    stub([trade(2, null)], [], 0);
    await renderPage();
    const cell = screen.getByTestId("paper-trade-pnl-2");
    expect(cell.textContent).toMatch(/not recorded/i);
    expect(cell.className).not.toContain("text-red-500");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Performance" }), { button: 0, ctrlKey: false });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("paper-pnl-unrecorded-note").textContent).toMatch(/1 closed demo trade has no recorded P\/L/);
  });

  it("day tiles and the summary are rounded, with no float noise", async () => {
    stub([trade(3, 0.1), trade(4, 0.2)], [{ date: "2026-10-27", tradesCount: 2, wins: 2, losses: 0, breakeven: 0, totalPnl: 0.30000000000000004, winRate: 100, bestTrade: 0.2, worstTrade: 0.1 }], 0.30000000000000004);
    await renderPage();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Performance" }), { button: 0, ctrlKey: false });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).not.toContain("0.30000000000000004");
    expect(screen.getByTestId("paper-day-pnl-2026-10-27").textContent).toContain("+0.3");
  });

  // /me/performance-calendar counts a closed trade with no recorded P/L as 0
  // in totalPnl and as break-even, and says how many it did so for
  // (pnlNotRecorded). A day of such trades is not a measured 0.
  describe("a day whose P/L was not recorded is not shown as a measured 0", () => {
    const openPerformance = async () => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Performance" }), { button: 0, ctrlKey: false });
      await act(async () => { await Promise.resolve(); });
    };

    it("every trade that day unrecorded: the day and the summary P/L read 'not recorded'", async () => {
      stub([trade(2, null)], [{ date: "2026-10-27", tradesCount: 1, wins: 0, losses: 0, breakeven: 1, totalPnl: 0, winRate: 0, bestTrade: 0, worstTrade: 0, pnlNotRecorded: 1 }], 0,
        EMPTY_INSIGHTS, { wins: 0, losses: 0, winRate: 0 });
      await renderPage();
      await openPerformance();
      const day = screen.getByTestId("paper-day-pnl-2026-10-27");
      expect(day.textContent).toBe("not recorded");
      expect(day.className).not.toMatch(/emerald/);
      const card = screen.getByTestId("paper-day-2026-10-27");
      expect(card.className).not.toMatch(/emerald|red-500/);
      expect(card.textContent).toMatch(/1 trade · 1 P\/L not recorded/);
      expect(card.textContent).not.toMatch(/0W \/ 0L/);
      const total = screen.getByTestId("paper-summary-pnl");
      expect(total.textContent).toBe("not recorded");
      expect(total.className).not.toMatch(/emerald/);
    });

    it("some trades that day unrecorded: the recorded sum is marked partial and the unrecorded count named", async () => {
      stub([trade(3, 0.3), trade(4, null)], [{ date: "2026-10-27", tradesCount: 2, wins: 1, losses: 0, breakeven: 1, totalPnl: 0.3, winRate: 50, bestTrade: 0.3, worstTrade: 0, pnlNotRecorded: 1 }], 0.3);
      await renderPage();
      await openPerformance();
      expect(screen.getByTestId("paper-day-pnl-2026-10-27").textContent).toBe("+0.3 (partial)");
      const card = screen.getByTestId("paper-day-2026-10-27");
      expect(card.className).not.toMatch(/emerald/);
      expect(card.textContent).toMatch(/1W \/ 0L · 2 trades · 1 P\/L not recorded/);
      expect(screen.getByTestId("paper-summary-pnl").textContent).toBe("+0.3 (partial)");
    });

    it("a live-trade book with an unrecorded day is not drawn as demo days at all", async () => {
      stub([], [{ date: "2026-10-27", tradesCount: 1, wins: 0, losses: 0, breakeven: 1, totalPnl: 0, winRate: 0, bestTrade: 0, worstTrade: 0, pnlNotRecorded: 1 }], 0,
        EMPTY_INSIGHTS, { totalTrades: 1, wins: 0, losses: 0, winRate: 0 }, "live_trades");
      await renderPage();
      await openPerformance();
      expect(screen.getByTestId("performance-not-demo").textContent).toContain("closed live trades");
      expect(screen.queryByTestId("paper-day-pnl-2026-10-27")).toBeNull();
      expect(screen.queryByTestId("paper-summary-pnl")).toBeNull();
    });
  });

  // /me/performance-insights is computed from the same paper_trades.pnl
  // (detectPatterns), so its averages, best day and per-strategy average are
  // the same price-move × lots unit, not money.
  it("the Insights tab labels avg win / loss, expectancy, best day and strategy avg as price move × lots", async () => {
    stub([trade(5, 0.005)], [], 0.005, {
      isEmpty: false, sampleSize: 4, insights: [], topSymbols: [], topMistakes: [],
      byStrategy: [{ strategy: "breakout", count: 4, winRate: 50, avgPnl: 0.0025 }],
      averages: { avgWin: 0.005, avgLoss: -0.003, expectancy: 0.001 },
      bestDay: { date: "2026-10-27", pnl: 0.007 }, worstDay: null,
    });
    await renderPage();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Insights/ }), { button: 0, ctrlKey: false });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId("insights-pnl-unit-note").textContent).toMatch(/not a money amount/i);
    const win = screen.getByTestId("insights-avg-win");
    expect(win.textContent).toMatch(/Avg win \(price move × lots\)/);
    expect(win.textContent).toContain("+0.005");
    const loss = screen.getByTestId("insights-avg-loss");
    expect(loss.textContent).toMatch(/Avg loss \(price move × lots\)/);
    expect(loss.textContent).toContain("-0.003");
    expect(screen.getByTestId("insights-expectancy").textContent).toMatch(/Expectancy \(price move × lots\).*\+0\.001/);
    expect(screen.getByTestId("insights-best-day").textContent).toMatch(/Best day \(price move × lots\).*2026-10-27 \(\+0\.007\)/);
    expect(screen.getByTestId("insights-strategy-breakout").textContent).toMatch(/avg \+0\.0025 \(price move × lots\)/);
  });
});
