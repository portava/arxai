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
    expect(screen.getByTestId("analytics-snapshot-state").textContent).toMatch(/could not load/i);
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
    expect(screen.getAllByText(/could not be loaded/i).length).toBe(4);
  });
});
