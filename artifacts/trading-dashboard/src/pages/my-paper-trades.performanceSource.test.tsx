// My Demo Trades — the Performance tab reads /me/performance-calendar and
// /me/performance-summary, which follow the account mode: in live trading mode
// they read closed live trades, and a live-shared account gets no book. The tab
// labelled every answer "demo" ("Close a demo trade…") next to a Trades tab full
// of closed demo trades. It now shows demo figures only when the server says
// they came from the demo record (source: "paper_trades").
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import MyPaperTradesPage from "./my-paper-trades";

const CLOSED = {
  id: 1, symbol: "EURUSD", side: "buy", status: "closed", entryType: "market",
  plannedEntryPrice: null, entryPrice: 1.085, exitPrice: 1.09, stopLoss: null, takeProfit: null,
  lotSize: 1, riskAmount: null, rewardRiskRatio: null, pnl: 0.005, pnlPercent: null,
  openedAt: "2026-10-27T09:00:00.000Z", closedAt: "2026-10-27T10:00:00.000Z", cancelledAt: null,
  strategyTag: null, setupGrade: null, reasonForEntry: null, notes: null, createdAt: "2026-10-27T09:00:00.000Z",
};

function stub(calendar: Record<string, unknown> | null, summary: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response;
    if (u.endsWith("/api/me/paper-trades")) return ok({ trades: [CLOSED] });
    if (u.endsWith("/api/me/trade-journal")) return ok({ entries: [] });
    if (u.endsWith("/api/me/performance-calendar")) {
      return calendar ? ok(calendar) : ({ ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response);
    }
    if (u.endsWith("/api/me/performance-summary")) return ok(summary);
    if (u.endsWith("/api/me/ai-trade-reviews")) return ok({ reviews: [] });
    if (u.endsWith("/api/me/performance-insights")) return ok({ isEmpty: true, sampleSize: 0, insights: [], byStrategy: [], topSymbols: [], topMistakes: [], averages: { avgWin: 0, avgLoss: 0, expectancy: 0 }, bestDay: null, worstDay: null });
    if (u.endsWith("/api/me/coaching-plan")) return ok({ isEmpty: true, sampleSize: 0, topStrengths: [], topWeaknesses: [], topMistakes: [] });
    if (u.endsWith("/api/me/playbooks")) return ok({ playbooks: [] });
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));
}
const emptySummary = (source?: string) => ({ totalTrades: 0, totalPnl: 0, wins: 0, losses: 0, winRate: 0, isEmpty: true, ...(source ? { source } : {}) });

async function openPerformance() {
  render(<MyPaperTradesPage />);
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Performance" }), { button: 0, ctrlKey: false });
  await act(async () => { await Promise.resolve(); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("My Demo Trades — Performance tab names the book it shows", () => {
  it("live trading mode: does not present the live-trade book as demo performance", async () => {
    stub({ days: [], isEmpty: true, source: "live_trades" }, emptySummary("live_trades"));
    await openPerformance();
    const notice = screen.getByTestId("performance-not-demo").textContent ?? "";
    expect(notice).toContain("closed live trades");
    expect(document.body.textContent).not.toContain("Close a demo trade to see your day appear here");
  });

  it("live-shared mode: the withheld book is not an empty demo record", async () => {
    stub({ days: [], isEmpty: true, source: "withheld_live_shared" }, emptySummary("withheld_live_shared"));
    await openPerformance();
    expect(screen.getByTestId("performance-not-demo").textContent).toContain("live-shared mode");
    expect(document.body.textContent).not.toContain("Close a demo trade to see your day appear here");
  });

  it("a failed calendar request reads 'could not be loaded', not an empty calendar", async () => {
    stub(null, emptySummary("paper_trades"));
    await openPerformance();
    expect(screen.getByTestId("performance-not-demo").textContent).toContain("could not be loaded");
    expect(document.body.textContent).not.toContain("will populate after your first closed trade");
  });

  it("demo record: shows the demo calendar", async () => {
    stub({ days: [], isEmpty: true, source: "paper_trades" }, emptySummary("paper_trades"));
    await openPerformance();
    expect(screen.queryByTestId("performance-not-demo")).toBeNull();
    expect(document.body.textContent).toContain("Close a demo trade to see your day appear here");
  });
});
