// Demo sandbox — after one good load, a failed 5s/6s refresh (503 no quote,
// 500) used to leave Balance, Equity, P&L vs start and the performance totals
// on screen unchanged, with no "as of" time and no stale marker. A failed
// refresh must say the figures are from the last successful read, and when.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperAccountCard } from "./PaperAccountCard";
import { PaperPerformanceSummary } from "./PaperPerformanceSummary";

const VALUED_AT = "2026-10-28T10:15:30.000Z";
const ACCOUNT = {
  id: 4, accountName: "Practice", startingBalance: 10000, currentBalance: 10150, equity: 10200, marginUsed: 100,
  isActive: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: VALUED_AT,
};
const HISTORY = { orders: [], closedCount: 4, wins: 3, losses: 1, winRate: 0.75, netPnl: 150 };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("demo sandbox refresh failure", () => {
  it("account card: shows when the account was valued, and marks a failed refresh", async () => {
    const fetchMock = vi.fn(async () => json(200, { account: ACCOUNT }));
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PaperAccountCard /></QueryClientProvider>);
    await screen.findByText("10200.00");
    expect(screen.getByTestId("paper-account-valued-at").textContent).toContain(new Date(VALUED_AT).toLocaleTimeString());
    expect(screen.queryByTestId("paper-account-refresh-failed")).toBeNull();

    fetchMock.mockImplementation(async () => json(503, { error: "Paper account valuation unavailable: a current real quote is required" }));
    await act(async () => { await qc.refetchQueries({ queryKey: ["paper-active"] }).catch(() => undefined); });

    const note = await screen.findByTestId("paper-account-refresh-failed");
    expect(note.textContent).toMatch(/last successful/i);
    expect(note.textContent).toContain(new Date(VALUED_AT).toLocaleTimeString());
    expect(note.textContent).toContain("a current real quote is required");
    // The stale P&L is not coloured as a live gain.
    expect(screen.getByTestId("paper-account-pnl").className).not.toContain("text-green-400");
  });

  it("performance summary: marks a failed refresh instead of showing old totals as current", async () => {
    const fetchMock = vi.fn(async () => json(200, HISTORY));
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PaperPerformanceSummary accountId={4} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText("75.0%")).toBeTruthy());
    expect(screen.queryByTestId("paper-performance-refresh-failed")).toBeNull();

    fetchMock.mockImplementation(async () => json(500, { error: "Failed to load history" }));
    await act(async () => { await qc.refetchQueries({ queryKey: ["paper-history", 4] }).catch(() => undefined); });

    const note = await screen.findByTestId("paper-performance-refresh-failed");
    expect(note.textContent).toMatch(/last successful read/i);
  });
});
