import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PerformanceScorecard from "./performance-scorecard";
import { routePanelLayoutKey } from "@/components/layout/shellLayoutModel";

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { id: 101 } }),
}));
vi.mock("@/lib/assistant-name", () => ({
  useAssistantName: () => ({ name: "Eleanor" }),
}));

const scorecard = {
  headline: { totalTrades: 2, totalPnl: 12, winRate: 50 },
  environments: {
    PAPER: { trades: 1, wins: 1, pnl: 20, winRate: 100 },
    DEMO: { trades: 1, losses: 1, pnl: -8, winRate: 0 },
  },
  bestSymbol: "EURUSD", worstSymbol: "GBPUSD",
  strategyRanking: [], mistakeDistribution: {}, gradeDistribution: {},
  dataSource: "fixture", generatedAt: "2026-11-04T00:00:00Z",
};

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockReports(heat: object = { snapshotCount: 3, windowDays: 1 }) {
  const fetcher = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes("scorecard") ? scorecard : heat,
  }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("Performance saved panels", () => {
  it("restores summary and review independently while keeping environment evidence visible", async () => {
    const fetcher = mockReports();
    const view = render(<PerformanceScorecard />);
    fireEvent.click(await screen.findByRole("button", { name: "Close Performance summary" }));
    await waitFor(() => expect(screen.getByText("Total Trades").closest("[hidden]")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Open Performance summary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Performance review" })).toBeTruthy();
    expect(screen.getByText("Environment Separation")).toBeTruthy();
    expect(screen.getByText("PAPER")).toBeTruthy();
    expect(screen.getByText("DEMO")).toBeTruthy();
    expect(screen.getByText(/Advisory only — never an execution gate/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pin Performance review" }));
    expect(screen.getByRole("button", { name: "Close Performance review" }).hasAttribute("disabled")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(routePanelLayoutKey(101, "/testing-lab/backtesting"))).toBeNull();
    view.unmount();
    render(<PerformanceScorecard />);
    expect(await screen.findByRole("button", { name: "Open Performance summary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unpin Performance review" })).toBeTruthy();
  });

  it("does not introduce a heat panel when heat evidence is unavailable", async () => {
    mockReports({ honestEmpty: true });
    render(<PerformanceScorecard />);
    await screen.findByRole("button", { name: "Close Performance summary" });
    expect(screen.queryByRole("region", { name: "Heat learning" })).toBeNull();
  });

  it("preserves the report error without rendering empty panels", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "Report unavailable" }) })));
    render(<PerformanceScorecard />);
    expect(await screen.findByText("Report unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Close Performance/ })).toBeNull();
  });
});
