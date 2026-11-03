// Regression: Trading Intelligence showed "Win Rate 0% / Total P/L $0 / Avg
// Win $0 / Avg Loss $0" for an import with no closed trade (the server sent 0
// and the page's null checks never fired), prefixed every P/L with "$" though
// it is in the account's own currency ("$-12.5"), called uploaded files
// "Sources — connected", and titled a trade-count ordering "Top Symbols".
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby", isLoading: false, isDefault: true }) }));
const { DnaTab, TradeHistoryTab, formatAccountPnl } = await import("./trading-intelligence");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
function serve(summary: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/summary")) return new Response(JSON.stringify(summary), { status });
    return new Response(JSON.stringify({ ok: true, imports: [] }), { status: 200 });
  }));
}

// An older server's shape for an import with only open trades: zeros, not nulls.
const OPEN_ONLY_OLD = {
  ok: true, hasTrades: true, count: 12, closedCount: 0, winRate: 0, totalNetPnl: 0, avgWin: 0, avgLoss: 0,
  topSymbols: [], sessions: {}, sources: ["MT5_CSV"], dateFrom: "2026-10-01T10:00:00Z", dateTo: "2026-10-03T10:00:00Z",
};
const OPEN_ONLY_NEW = { ...OPEN_ONLY_OLD, winRate: null, totalNetPnl: null, avgWin: null, avgLoss: null, withoutOutcomeCount: 12, importCount: 1, sourcesKind: "IMPORTED_FILES" };

describe("Trading Intelligence truth", () => {
  it("formats P/L without a currency symbol, sign first", () => {
    expect(formatAccountPnl(-12.5)).toBe("-12.50");
    expect(formatAccountPnl(7)).toBe("+7.00");
    expect(formatAccountPnl(null)).toBeNull();
  });

  for (const [label, body] of [["older server (zeros)", OPEN_ONLY_OLD], ["current server (nulls)", OPEN_ONLY_NEW]] as const) {
    it(`Strategy DNA with no closed trade does not show 0% or $0 — ${label}`, async () => {
      serve(body);
      mount(<DnaTab />);
      await waitFor(() => expect(screen.getByTestId("dna-stats")).toBeTruthy());
      const stats = screen.getByTestId("dna-stats").textContent ?? "";
      expect(stats).not.toMatch(/0%/);
      expect(stats).not.toContain("$");
      expect(stats).not.toMatch(/\b0(\.00)?\b/);
      expect(screen.getByTestId("dna-no-outcome").textContent).toMatch(/not measured/);
      expect(screen.getByTestId("dna-built-from").textContent).toMatch(/12 imported trades, 0 closed with a recorded P\/L/);
      expect(screen.getByTestId("dna-coverage").textContent).toMatch(/2026-10-01 to 2026-10-03.*uploaded MT5 CSV history files \(not a live connection\)/);
    });

    it(`Trade History tab with no closed trade does not show 0% or $0, nor 'connected' — ${label}`, async () => {
      serve(body);
      mount(<TradeHistoryTab />);
      await waitFor(() => expect(screen.getByTestId("history-stats")).toBeTruthy());
      const stats = screen.getByTestId("history-stats").textContent ?? "";
      expect(stats).not.toMatch(/0%/);
      expect(stats).not.toContain("$");
      expect(stats).not.toMatch(/connected/);
      expect(stats).toMatch(/uploaded files, not a live connection/);
      expect(screen.getByTestId("history-no-outcome").textContent).toMatch(/not measured/);
    });
  }

  it("a closed record shows account-currency P/L without '$' and names the symbol ordering", async () => {
    serve({ ...OPEN_ONLY_NEW, closedCount: 2, winRate: 50, totalNetPnl: -12.5, avgWin: 5, avgLoss: -17.5,
      topSymbols: [{ symbol: "EURUSD", count: 2, wins: 1, netPnl: -12.5, winRate: 50 }] });
    mount(<DnaTab />);
    await waitFor(() => expect(screen.getByTestId("dna-stats")).toBeTruthy());
    const stats = screen.getByTestId("dna-stats").textContent ?? "";
    expect(stats).toContain("-12.50");
    expect(stats).not.toContain("$");
    expect(screen.getByTestId("dna-symbols-order").textContent).toMatch(/number of closed trades, not by performance/);
    expect(screen.queryByText("Top Symbols")).toBeNull();
  });

  it("a failed summary read says it could not be loaded, not 'No trading history yet'", async () => {
    serve({ ok: false, error: "SUMMARY_FAILED" }, 500);
    mount(<DnaTab />);
    await waitFor(() => expect(screen.getByTestId("dna-unavailable")).toBeTruthy());
    expect(screen.queryByText("No trading history yet")).toBeNull();
  });
});
