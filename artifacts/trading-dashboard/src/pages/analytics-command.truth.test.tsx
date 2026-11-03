// Analytics Command Center truth: when snapshot generation fails the page says
// so. It never shows "Computing your first analytics snapshot…" while nothing
// is computing, and it does not loop POST /analytics/snapshot after a failure.
// A failed section read says it could not be loaded, never "No closed trades
// yet." or another empty state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/analytics", () => ({
  EquityCurveChart: ({ points }: { points: unknown[] }) => <div data-testid="equity-chart">{points.length === 0 ? "No closed trades yet." : "curve"}</div>,
  DrawdownChart: () => null,
  StrategyAnalyticsTable: ({ rows }: { rows: unknown[] }) => <div>{rows.length === 0 ? "No strategy data." : "table"}</div>,
  SessionHeatmap: () => <div data-testid="session-heatmap" />,
  EmotionalTrendGraph: ({ trend }: { trend: unknown[] }) => <div>{trend.length === 0 ? "No emotional data yet." : "trend"}</div>,
  RiskExposureGraph: () => null,
  ConsistencyTrendCard: () => null,
}));

const { default: AnalyticsCommandCenter } = await import("./analytics-command");

type Route = { status: number; body: unknown };
let routes: Record<"snapshot" | "post" | "strategy" | "session" | "emotional" | "drawdown", Route>;
let postCalls = 0;

const SNAPSHOT = {
  totalTrades: 3, netProfitLoss: 12, winRate: 0.5, averageRr: 1.2, expectancy: 4, profitFactor: 1.5,
  maxDrawdown: 10, strongestStrategy: null, weakestStrategy: null,
  strongestMarketCondition: null, weakestMarketCondition: null,
};

function jsonResponse({ status, body }: Route): Response {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text } as unknown as Response;
}

beforeEach(() => {
  postCalls = 0;
  routes = {
    snapshot: { status: 200, body: { snapshot: null } },
    post: { status: 500, body: { error: "Failed to generate analytics snapshot" } },
    strategy: { status: 200, body: { strategies: [] } },
    session: { status: 200, body: { session: {} } },
    emotional: { status: 200, body: { trend: [], totalDebriefs: 0 } },
    drawdown: { status: 200, body: { equityCurve: [], maxDrawdown: 0 } },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/analytics/snapshot" && init?.method === "POST") {
      postCalls += 1;
      return jsonResponse(routes.post);
    }
    if (url === "/api/analytics/snapshot") return jsonResponse(routes.snapshot);
    if (url === "/api/analytics/strategy") return jsonResponse(routes.strategy);
    if (url === "/api/analytics/session") return jsonResponse(routes.session);
    if (url === "/api/analytics/emotional") return jsonResponse(routes.emotional);
    if (url === "/api/analytics/drawdown") return jsonResponse(routes.drawdown);
    return jsonResponse({ status: 404, body: { error: "not found" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><AnalyticsCommandCenter /></QueryClientProvider>);
}

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

describe("Analytics Command Center failure states", () => {
  it("a failed first computation is attempted once and says it could not be computed", async () => {
    renderPage();
    await flush();
    expect(postCalls).toBe(1);
    expect(screen.queryByText(/Computing your first analytics snapshot/)).toBeNull();
    const state = screen.getByTestId("analytics-snapshot-state").textContent ?? "";
    expect(state).toMatch(/could not be computed/i);
    expect(state).toContain("Failed to generate analytics snapshot");
  });

  it("a failed snapshot read is an error, not 'computing' and not an auto-POST", async () => {
    routes.snapshot = { status: 500, body: { error: "Failed to load snapshot" } };
    renderPage();
    await flush();
    expect(postCalls).toBe(0);
    expect(screen.queryByText(/Computing your first analytics snapshot/)).toBeNull();
    expect(screen.getByTestId("analytics-snapshot-state").textContent).toMatch(/could not be loaded/i);
  });

  it("a failed section read says it could not be loaded instead of showing an empty state", async () => {
    routes.snapshot = { status: 200, body: { snapshot: SNAPSHOT } };
    routes.drawdown = { status: 500, body: { error: "x" } };
    routes.strategy = { status: 500, body: { error: "x" } };
    routes.emotional = { status: 500, body: { error: "x" } };
    routes.session = { status: 500, body: { error: "x" } };
    renderPage();
    await flush();
    expect(postCalls).toBe(0);
    expect(screen.queryByText("No closed trades yet.")).toBeNull();
    expect(screen.queryByText("No strategy data.")).toBeNull();
    expect(screen.queryByText("No emotional data yet.")).toBeNull();
    expect(screen.queryByTestId("session-heatmap")).toBeNull();
    // Four failed sections, plus the P&L coverage line: with drawdown and
    // strategy both failed, which trades could be sized could not be loaded.
    expect(screen.getAllByText(/could not be loaded/i).length).toBe(5);
    expect(screen.getByTestId("analytics-pnl-coverage").textContent).toMatch(/could not be loaded/i);
  });
});

// Regression: React Query keeps the last good snapshot when a reload fails.
// After a successful Recompute the reload of the snapshot returned 500, and the
// page showed the previous snapshot's figures as if they were the new ones,
// with no notice: the error copy rendered only when there was no snapshot.
describe("Analytics Command Center when a snapshot reload fails", () => {
  it("a successful recompute whose reload fails says the figures are the earlier snapshot, not the new one", async () => {
    const OLD = { ...SNAPSHOT, id: 7, createdAt: "2026-10-30T08:15:00.000Z" };
    routes.snapshot = { status: 200, body: { snapshot: OLD } };
    routes.post = { status: 200, body: { snapshot: { ...OLD, id: 8, createdAt: "2026-11-03T09:00:00.000Z" } } };
    renderPage();
    await flush();
    expect(screen.getByTestId("stat-trades")).toBeTruthy();
    expect(screen.queryByTestId("analytics-snapshot-reload-failed")).toBeNull();

    routes.snapshot = { status: 500, body: { error: "Failed to load snapshot" } };
    await act(async () => { screen.getByText("Recompute snapshot").click(); });
    await flush();
    expect(postCalls).toBe(1);
    const notice = screen.getByTestId("analytics-snapshot-reload-failed");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toMatch(/could not be loaded/i);
    expect(notice.textContent).toContain("Failed to load snapshot");
    expect(notice.textContent).toContain(new Date(OLD.createdAt).toLocaleString());
    expect(notice.textContent).toMatch(/not the one just computed/);
  });

  it("a failed background reload with no recompute says the figures are from the snapshot last loaded", async () => {
    const OLD = { ...SNAPSHOT, id: 7, createdAt: "2026-10-30T08:15:00.000Z" };
    routes.snapshot = { status: 200, body: { snapshot: OLD } };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><AnalyticsCommandCenter /></QueryClientProvider>);
    await flush();
    routes.snapshot = { status: 500, body: { error: "Failed to load snapshot" } };
    await act(async () => { await qc.invalidateQueries({ queryKey: ["analytics-snapshot"] }); });
    await flush();
    const notice = screen.getByTestId("analytics-snapshot-reload-failed");
    expect(notice.textContent).toMatch(/could not be reloaded/i);
    expect(notice.textContent).toContain(new Date(OLD.createdAt).toLocaleString());
    expect(notice.textContent).not.toMatch(/just computed/);
  });
});

// Regression: once the snapshot loaded, the session, emotional and strategy
// sections rendered with fallback empty data while their own reads were still
// pending: "$0 · 0 trades" per session, "No strategy data." and "No emotional
// data yet." before anything had been read. Only the drawdown section waited.
describe("Analytics Command Center while section reads are pending", () => {
  it("sections whose reads have not answered say they are loading, not empty", async () => {
    routes.snapshot = { status: 200, body: { snapshot: SNAPSHOT } };
    const answered = vi.fn(globalThis.fetch);
    const pending = new Set(["/api/analytics/session", "/api/analytics/strategy", "/api/analytics/emotional"]);
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) =>
      pending.has(url) ? new Promise<Response>(() => {}) : answered(url, init)));
    renderPage();
    await flush();
    expect(screen.getByTestId("stat-trades")).toBeTruthy();
    expect(screen.queryByTestId("session-heatmap")).toBeNull();
    expect(screen.queryByText("No strategy data.")).toBeNull();
    expect(screen.queryByText("No emotional data yet.")).toBeNull();
    expect(screen.getByText(/Loading session performance/)).toBeTruthy();
    expect(screen.getByText(/Loading strategy analytics/)).toBeTruthy();
    expect(screen.getByText(/Loading the emotional trend/)).toBeTruthy();
  });
});
