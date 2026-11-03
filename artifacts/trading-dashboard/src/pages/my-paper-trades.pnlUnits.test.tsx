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

function stub(trades: unknown[], days: unknown[], totalPnl: number) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response;
    if (u.endsWith("/api/me/paper-trades")) return ok({ trades });
    if (u.endsWith("/api/me/trade-journal")) return ok({ entries: [] });
    if (u.endsWith("/api/me/performance-calendar")) return ok({ days, isEmpty: days.length === 0, source: "paper_trades" });
    if (u.endsWith("/api/me/performance-summary")) return ok({ totalTrades: trades.length, totalPnl, wins: 1, losses: 0, winRate: 50, isEmpty: false, source: "paper_trades" });
    if (u.endsWith("/api/me/ai-trade-reviews")) return ok({ reviews: [] });
    if (u.endsWith("/api/me/performance-insights")) return ok({ isEmpty: true, sampleSize: 0, insights: [], byStrategy: [], topSymbols: [], topMistakes: [], averages: { avgWin: 0, avgLoss: 0, expectancy: 0 }, bestDay: null, worstDay: null });
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
});
