// Demo performance — with no account, a pending read or a failed read the card
// showed "Closed 0, Win rate 0.0% (red), Net P&L 0.00 (green)"; with zero
// closed trades the server's winRate 0 read as a 0.0% win rate. None of those
// is a measured result.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperPerformanceSummary } from "./PaperPerformanceSummary";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(accountId: number | null, fetchImpl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperPerformanceSummary accountId={accountId} /></QueryClientProvider>);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("PaperPerformanceSummary states", () => {
  it("no account: says so, shows no zero stats", () => {
    mount(null, async () => json(200, {}));
    expect(screen.getByTestId("paper-performance-state").textContent).toMatch(/No demo account/);
    expect(document.body.textContent).not.toContain("0.0%");
    expect(document.body.textContent).not.toContain("0.00");
  });

  it("loading: says loading, shows no zero stats", () => {
    mount(4, () => new Promise(() => {}));
    expect(screen.getByTestId("paper-performance-state").textContent).toMatch(/Loading/);
    expect(document.body.textContent).not.toContain("0.0%");
  });

  it("a failed first read: could not be loaded, no zero stats", async () => {
    mount(4, async () => json(500, { error: "Failed to load history" }));
    const state = await screen.findByTestId("paper-performance-state");
    await vi.waitFor(() => expect(state.textContent).toMatch(/could not be loaded/i));
    expect(document.body.textContent).not.toContain("0.0%");
  });

  it("zero closed trades: win rate is not 0.0% and not red", async () => {
    mount(4, async () => json(200, { orders: [], closedCount: 0, wins: 0, losses: 0, winRate: 0, netPnl: 0 }));
    const rate = await screen.findByTestId("paper-performance-winrate");
    expect(rate.textContent).not.toContain("0.0%");
    expect(rate.textContent).toContain("—");
    expect(rate.className).not.toContain("text-red-400");
    expect(screen.getByTestId("paper-performance-netpnl").className).not.toContain("text-green-400");
  });

  it("measured results still show", async () => {
    mount(4, async () => json(200, { orders: [], closedCount: 4, wins: 3, losses: 1, winRate: 0.75, netPnl: 150 }));
    const rate = await screen.findByTestId("paper-performance-winrate");
    expect(rate.textContent).toBe("75.0%");
    expect(screen.getByTestId("paper-performance-netpnl").textContent).toBe("150.00");
  });
});
