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

function stub(calendar: Record<string, unknown> | null, summary: Record<string, unknown>, failing: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as Response;
    if (failing.some((p) => u.endsWith(p))) return { ok: false, status: 500, json: async () => ({ error: "boom" }) } as Response;
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

  // Each read has its own catch (2c56a512): an unrelated failed request is
  // named on its own section, and the Performance tab does not blame "the
  // request for your demo-trade performance" when calendar and summary loaded.
  it("a failed playbooks or reviews request does not make the Performance tab say its request failed", async () => {
    stub({ days: [], isEmpty: true, source: "paper_trades" }, emptySummary("paper_trades"), ["/api/me/playbooks", "/api/me/ai-trade-reviews"]);
    await openPerformance();
    expect(screen.queryByTestId("performance-not-demo")).toBeNull();
    expect(document.body.textContent).not.toContain("The request for your demo-trade performance failed");
    expect(document.body.textContent).toContain("Close a demo trade to see your day appear here");
  });

  it("a failed summary request (calendar loaded) names the summary as the failed read", async () => {
    stub({ days: [], isEmpty: true, source: "paper_trades" }, emptySummary("paper_trades"), ["/api/me/performance-summary"]);
    await openPerformance();
    expect(screen.getByTestId("performance-not-demo").textContent).toContain("could not be loaded");
    expect(screen.getByTestId("load-error-summary").textContent).toMatch(/Your performance summary could not be loaded/);
    expect(screen.queryByTestId("load-error-calendar")).toBeNull();
  });

  it("demo record: shows the demo calendar", async () => {
    stub({ days: [], isEmpty: true, source: "paper_trades" }, emptySummary("paper_trades"));
    await openPerformance();
    expect(screen.queryByTestId("performance-not-demo")).toBeNull();
    expect(document.body.textContent).toContain("Close a demo trade to see your day appear here");
  });

  // /me/performance-calendar and /me/performance-summary send sourceNote; the
  // tab names its ledger so a reader comparing it with the Trading Calendar
  // sees that the two pages read different records.
  it("demo record: names its ledger with the server's source note", async () => {
    const note = "From the demo trades you log by hand on My Demo Trades. Simulated orders (Paper Autopilot and simulated trade tickets) are on the Trading Calendar and are not included; their P&L is computed differently, so the two pages will not match.";
    stub({ days: [], isEmpty: true, source: "paper_trades", sourceNote: note }, { ...emptySummary("paper_trades"), sourceNote: note });
    await openPerformance();
    expect(screen.getByTestId("performance-source-note").textContent).toBe(note);
  });

  it("demo record from a server with no source note: names the ledger with local copy", async () => {
    stub({ days: [], isEmpty: true, source: "paper_trades" }, emptySummary("paper_trades"));
    await openPerformance();
    const text = screen.getByTestId("performance-source-note").textContent ?? "";
    expect(text).toMatch(/demo trades you log by hand on this page/i);
    expect(text).toMatch(/Trading Calendar/);
    expect(text).toMatch(/not included/);
  });

  it("a book that is not the demo record shows no demo source note", async () => {
    stub({ days: [], isEmpty: true, source: "live_trades", sourceNote: "From your closed live trades recorded against your account." }, emptySummary("live_trades"));
    await openPerformance();
    expect(screen.queryByTestId("performance-source-note")).toBeNull();
  });
});
