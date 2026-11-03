// Truth: Ruby's Memory tab is built from the paper book. For a LIVE_SHARED
// account the server withholds it (commandCenter null + modeNote); the tab must
// show that note, not demo win rate / P&L under a LIVE account strip. A failed
// load is "could not be loaded", never "No memory snapshot yet". The figures
// say which book and which window they cover.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby", isLoading: false, isDefault: true }) }));
vi.mock("@/components/scanner/SelectedMarketPanel", () => ({ SelectedMarketPanel: () => null }));
vi.mock("@/components/ruby/RubyAccountHealthStrip", () => ({ RubyAccountHealthStrip: () => null }));
vi.mock("recharts", () => {
  const Stub = ({ children }: { children?: unknown }) => <div>{children as never}</div>;
  return { LineChart: Stub, Line: () => null, XAxis: () => null, YAxis: () => null, ResponsiveContainer: Stub, Tooltip: () => null };
});

const { MemoryTab } = await import("./ai-command-center");

const LIVE_NOTE = "This is a live account. Ruby's memory is built from paper trades only and live trades are not totalled here, so no win rate, P&L or equity curve is shown. They are not zero.";

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function renderTab(handler: (url: string) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => handler(String(input))));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryTab /></QueryClientProvider>);
}

const paperCc = {
  winRate: 60, netPnl: 12.5, totalClosedTrades: 5,
  learningStats: { improvementScore: 1, learningEvents: 0, strategyEdgesUpdated: 0, mistakePatternsTracked: 0, learningConfidence: 0 },
  aiDecisionStats: { decisionsCreated: 0, buyCount: 0, sellCount: 0, holdCount: 0, blockedCount: 0, decisionToTradeRate: 0, decisionToWinRate: 0, avgConfidence: 0, avgRiskScore: 0, avgEdgeScore: 0 },
  insights: [], nextBestActions: [], warnings: [],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Ruby Memory tab — truth", () => {
  it("LIVE_SHARED: shows the server's live note, not paper win rate or P&L", async () => {
    renderTab((url) => {
      if (url.startsWith("/api/performance/ai-command-center")) {
        return json({ ok: true, commandCenter: null, autopilot: null, currentAccountMode: "LIVE_SHARED", modeScopeApplied: true, liveAggregation: "NOT_AVAILABLE", modeNote: LIVE_NOTE });
      }
      if (url.startsWith("/api/performance/equity-curve")) {
        return json({ ok: true, equityCurve: null, currentAccountMode: "LIVE_SHARED", modeNote: LIVE_NOTE });
      }
      return json({ ok: true, decisionQuality: null });
    });
    expect((await screen.findByTestId("memory-mode-note")).textContent).toBe(LIVE_NOTE);
    expect(screen.queryByText(/No memory snapshot yet/)).toBeNull();
    expect(screen.queryByTestId("memory-net-pnl")).toBeNull();
    expect(screen.queryByTestId("button-rebuild-memory")).toBeNull();
  });

  it("a 500 is 'could not be loaded', not 'No memory snapshot yet'", async () => {
    renderTab(() => json({ ok: false, error: "boom" }, 500));
    expect((await screen.findByTestId("memory-load-error")).textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText(/No memory snapshot yet/)).toBeNull();
  });

  it("PAPER: tiles say paper + all closed trades; the curve says last 30 days; a failed curve is not 'no trades'", async () => {
    renderTab((url) => {
      if (url.startsWith("/api/performance/ai-command-center")) {
        return json({ ok: true, commandCenter: paperCc, autopilot: {}, currentAccountMode: "PAPER", modeScopeApplied: true, dataSource: "paper_orders" });
      }
      if (url.startsWith("/api/performance/equity-curve")) return json({ ok: false, error: "x" }, 500);
      return json({ ok: true, decisionQuality: null });
    });
    expect((await screen.findByTestId("memory-net-pnl")).textContent).toBe("12.50");
    expect(screen.getByText("Net Paper P&L")).toBeTruthy();
    expect(screen.getByTestId("memory-net-pnl-scope").textContent).toMatch(/all closed paper trades/i);
    expect(screen.getByText(/Paper Equity Curve \(last 30 days\)/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("memory-equity-error").textContent).toMatch(/could not be loaded/i));
    expect(screen.queryByText(/No closed (demo|paper) trades in this range yet/)).toBeNull();
  });

  // The server reads paper_orders only (dataSource "paper_orders", "built from
  // paper trades only"). DEMO is a separate account mode (the user's MT5 demo
  // account), so a DEMO-mode user must not see simulator P&L called their demo
  // P&L "in demo account units".
  it("DEMO-mode user: paper_orders figures are labelled paper, never demo or demo account units", async () => {
    renderTab((url) => {
      if (url.startsWith("/api/performance/ai-command-center")) {
        return json({ ok: true, commandCenter: paperCc, autopilot: {}, currentAccountMode: "DEMO", modeScopeApplied: true, dataSource: "paper_orders" });
      }
      if (url.startsWith("/api/performance/equity-curve")) return json({ ok: true, equityCurve: { points: [] }, dataSource: "paper_orders" });
      return json({ ok: true, decisionQuality: null });
    });
    expect((await screen.findByTestId("memory-net-pnl")).textContent).toBe("12.50");
    expect(screen.getByText("Paper Win Rate")).toBeTruthy();
    expect(screen.getByText("Net Paper P&L")).toBeTruthy();
    expect(screen.getByText("Closed Paper Trades")).toBeTruthy();
    const scope = screen.getByTestId("memory-net-pnl-scope").textContent ?? "";
    expect(scope).toMatch(/paper simulator/i);
    expect(scope).not.toMatch(/demo account units/i);
    await waitFor(() => expect(screen.getByText(/No closed paper trades in this range yet/)).toBeTruthy());
    expect(screen.queryByText(/Demo Win Rate|Net Demo P&L|Closed Demo Trades|Demo Equity Curve/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/closed demo trades/i);
  });

  it("LIVE_SHARED with no server note: the fallback says paper trades, as the server does", async () => {
    renderTab((url) => {
      if (url.startsWith("/api/performance/ai-command-center")) {
        return json({ ok: true, commandCenter: null, autopilot: null, currentAccountMode: "LIVE_SHARED", modeScopeApplied: true });
      }
      return json({ ok: true, decisionQuality: null });
    });
    const note = (await screen.findByTestId("memory-mode-note")).textContent ?? "";
    expect(note).toMatch(/built from paper trades only/);
    expect(note).not.toMatch(/demo/i);
  });

  it("PAPER with no closed trades: win rate is not measured, not 0.0%", async () => {
    renderTab((url) => {
      if (url.startsWith("/api/performance/ai-command-center")) {
        return json({ ok: true, commandCenter: { ...paperCc, winRate: 0, netPnl: 0, totalClosedTrades: 0 }, autopilot: {}, currentAccountMode: "PAPER" });
      }
      if (url.startsWith("/api/performance/equity-curve")) return json({ ok: true, equityCurve: { points: [] } });
      return json({ ok: true, decisionQuality: null });
    });
    expect((await screen.findByTestId("memory-win-rate")).textContent).toBe("—");
    expect(screen.getByTestId("memory-net-pnl").textContent).toBe("—");
  });

  // The card said "in demo account units" for every close, and the server's
  // netPnlBasis (how each close was booked, and what is left out) was never
  // shown. A close the paper venue could not size is left out of Net P&L.
  it("Net P&L shows the server's basis, not a hard-coded 'demo account units' line", async () => {
    const basis = "Sum of the P&L the paper venue booked on each closed demo trade. Closes are now booked in USD at the instrument's contract size. 1 of 5 closed trades (V75) could not be sized for the instrument.";
    renderTab((url) => {
      if (url.startsWith("/api/performance/ai-command-center")) {
        return json({ ok: true, commandCenter: { ...paperCc, netPnlBasis: basis, unsizedClosedTrades: 1 }, autopilot: {}, currentAccountMode: "PAPER" });
      }
      if (url.startsWith("/api/performance/equity-curve")) return json({ ok: true, equityCurve: { points: [] } });
      return json({ ok: true, decisionQuality: null });
    });
    expect((await screen.findByTestId("memory-net-pnl")).textContent).toBe("12.50");
    expect(screen.getByTestId("memory-net-pnl-scope").textContent).toBe(basis);
    expect(document.body.textContent).not.toMatch(/demo account units/);
  });

  it("when no closed trade could be sized, Net P&L is not measured (not 0.00) and the curve says why it has no points", async () => {
    const note = "P&L not measured: none of the 2 closed trades (V75) could be sized for the instrument (no contract size or currency conversion).";
    renderTab((url) => {
      if (url.startsWith("/api/performance/ai-command-center")) {
        return json({ ok: true, commandCenter: { ...paperCc, winRate: 0, netPnl: 0, totalClosedTrades: 2, unsizedClosedTrades: 2 }, autopilot: {}, currentAccountMode: "PAPER" });
      }
      if (url.startsWith("/api/performance/equity-curve")) return json({ ok: true, equityCurve: { points: [], unsized_trades: 2, pnl_note: note } });
      return json({ ok: true, decisionQuality: null });
    });
    expect((await screen.findByTestId("memory-net-pnl")).textContent).toBe("Not measured");
    expect((await screen.findByTestId("memory-equity-pnl-note")).textContent).toBe(note);
    expect(screen.queryByText(/No closed (demo|paper) trades in this range yet/)).toBeNull();
  });
});
