// Truth: the Trade Journal's Win Rate counts only entries with a recorded
// outcome (BUY/SELL with a P&L). WAIT entries and entries with no P&L are not
// losses. Totals over the server's 100-row page say they cover that page.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import JournalPage from "./journal";

type Entry = { direction: "BUY" | "SELL" | "WAIT"; pnl: number | null };
function rows(list: Entry[]) {
  return list.map((e, i) => ({
    id: i + 1, symbol: "EURUSD", direction: e.direction, strategy: "Trend Continuation", entryIdea: "idea",
    actualOutcome: null, pnl: e.pnl, emotionTag: null, mistakeTag: null, lessonLearned: null,
    screenshotUrl: null, createdAt: "2026-10-27T10:00:00Z",
  }));
}
async function renderWith(list: Entry[]) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => rows(list) } as Response));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><JournalPage /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByText(/Entries/).parentElement?.textContent).toContain(String(list.length)));
}
function stat(label: string): string {
  const el = screen.getByText(label);
  return el.parentElement?.textContent ?? "";
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Trade Journal win rate", () => {
  it("excludes WAIT and no-P&L entries from the denominator", async () => {
    await renderWith([
      { direction: "BUY", pnl: 10 }, { direction: "SELL", pnl: 5 }, { direction: "BUY", pnl: 3 }, { direction: "BUY", pnl: 1 },
      { direction: "WAIT", pnl: null }, { direction: "WAIT", pnl: null },
      { direction: "BUY", pnl: null }, { direction: "SELL", pnl: null },
    ]);
    const wr = stat("Win Rate");
    expect(wr).not.toContain("50%");
    expect(wr).toContain("100%");
    expect(wr).toContain("4 with a result");
  });

  it("shows no win rate when no entry has a recorded result", async () => {
    await renderWith([{ direction: "WAIT", pnl: null }, { direction: "BUY", pnl: null }]);
    const wr = stat("Win Rate");
    expect(wr).not.toContain("0%");
    expect(wr).toContain("—");
  });

  it("labels totals as covering the latest 100 entries when the page is full", async () => {
    await renderWith(Array.from({ length: 100 }, () => ({ direction: "BUY" as const, pnl: 1 })));
    expect(screen.queryByText("Total P&L")).toBeNull();
    expect(screen.getByText("P&L (latest 100 entries)")).toBeTruthy();
  });
});
