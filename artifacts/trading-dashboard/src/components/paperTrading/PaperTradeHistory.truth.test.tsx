// Truth: paper_orders.profit_loss cannot be empty, so the paper monitor
// stores 0 when it cannot size an exit (no contract size or USD conversion,
// e.g. gold or a synthetic index). The history printed that placeholder as
// "+0.00" in green — a breakeven result that never happened. A 0 on an exit
// that moved from entry now reads "not sized"; a genuinely flat exit reads
// "0.00" without a sign.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperTradeHistory } from "./PaperTradeHistory";

const base = { direction: "BUY", lotSize: 1, openedAt: "2026-10-28T00:00:00Z", closedAt: "2026-10-28T01:00:00Z" };
const orders = [
  { ...base, id: 1, symbol: "EURUSD", entryPrice: 1.085, exitPrice: 1.095, status: "CLOSED_TP", profitLoss: 1000 },
  { ...base, id: 2, symbol: "XAUUSD", entryPrice: 2380, exitPrice: 2370, status: "CLOSED_SL", profitLoss: 0 },
  { ...base, id: 3, symbol: "GBPUSD", entryPrice: 1.27, exitPrice: 1.27, status: "CLOSED_MANUAL", profitLoss: 0 },
  { ...base, id: 4, symbol: "USDJPY", entryPrice: 150, exitPrice: 149, status: "CLOSED_SL", profitLoss: -6.67 },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PaperTradeHistory P&L cell", () => {
  it("shows an unsized placeholder 0 as 'not sized', never '+0.00'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders }), { status: 200 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PaperTradeHistory accountId={1} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText("XAUUSD")).toBeTruthy());
    expect(screen.getByTestId("paper-history-pnl-1").textContent).toBe("+1000.00");
    const unsized = screen.getByTestId("paper-history-pnl-2");
    expect(unsized.textContent).toBe("not sized");
    expect(unsized.getAttribute("title")).toMatch(/not a breakeven result/);
    expect(unsized.className).not.toMatch(/green/);
    expect(screen.getByTestId("paper-history-pnl-3").textContent).toBe("0.00");
    expect(screen.getByTestId("paper-history-pnl-4").textContent).toBe("-6.67");
    expect(document.body.textContent).not.toContain("+0.00");
  });
});
