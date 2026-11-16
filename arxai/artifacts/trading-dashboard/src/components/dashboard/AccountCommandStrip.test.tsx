import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  performance: null as any,
  summary: null as any,
  live: null as any,
  mode: null as any,
  risk: null as any,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetPerformanceSummary: () => state.performance,
  useGetMeSharedAccountSummary: () => state.summary,
  getGetMeSharedAccountSummaryQueryKey: () => ["me", "shared-account-summary"],
}));
vi.mock("@/hooks/useLiveAccountSnapshotContext", () => ({ useLiveAccountSnapshotCtx: () => state.live }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => state.mode }));
vi.mock("@/hooks/useRiskBudgetSnapshot", () => ({ useRiskBudgetSnapshot: () => state.risk }));

import { AccountCommandStrip } from "./AccountCommandStrip";

afterEach(() => cleanup());

beforeEach(() => {
  state.performance = { data: { todayPnl: 74.6 }, isLoading: false, isError: false };
  state.summary = { data: { accounts: [] }, isLoading: false, isError: false };
  state.live = {
    snapshot: { accountMode: "LIVE_SHARED" },
    live: { liveEquity: 2104, freeMargin: 890 },
    freshness: "fresh", lastUpdatedMs: 1_000, isEstimate: false, isRefreshing: false, isUnavailable: false, connectionStatus: "live",
  };
  state.mode = { isLiveShared: true, isAdmin: false, isLoading: false, isError: false, cleanModeLabel: "LIVE · Shared Master MT5" };
  state.risk = { data: { dailyRiskLimit: 400, dailyRiskUsed: 50 }, isLoading: false, isError: false };
});

describe("account command strip", () => {
  it("groups canonical account values, daily realized P/L, account-scoped risk, and actual mode", () => {
    render(<AccountCommandStrip/>);
    expect(screen.getByText("$2,104.00")).toBeTruthy();
    expect(screen.getByText("$74.60")).toBeTruthy();
    expect(screen.getByText("$890.00")).toBeTruthy();
    expect(screen.getByText("12.5%")).toBeTruthy();
    expect(screen.getByText("canonical · fresh")).toBeTruthy();
    expect(screen.getByText("LIVE · Shared Master MT5")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Account overview" })).toBeTruthy();
  });

  it("uses the current user's virtual equity for DEMO/PAPER, never balance, headroom, or owner figures", () => {
    state.mode = { ...state.mode, isLiveShared: false, cleanModeLabel: "DEMO" };
    state.summary = {
      data: {
        accounts: [{ virtualBalance: 9900, virtualEquity: 314.28 }],
        allocationView: { availableAllocation: 125 },
        masterAccess: false,
        masterMt5: { mt5Equity: 8800 },
      },
      isLoading: false,
      isError: false,
    };
    render(<AccountCommandStrip/>);
    expect(screen.getByText("$314.28")).toBeTruthy();
    expect(screen.queryByText("$9,900.00")).toBeNull();
    expect(screen.queryByText("$125.00")).toBeNull();
    expect(screen.queryByText("$8,800.00")).toBeNull();
    expect(screen.getByText("user virtual equity")).toBeTruthy();
    expect(screen.getByText("DEMO")).toBeTruthy();
  });

  it("keeps unavailable and stale user-equity states honest", () => {
    state.mode = { ...state.mode, isLiveShared: false, cleanModeLabel: "PAPER" };
    state.summary = { data: undefined, isLoading: true, isError: false };
    const { rerender } = render(<AccountCommandStrip/>);
    expect(screen.getByText("Loading…")).toBeTruthy();

    state.summary = { data: undefined, isLoading: false, isError: true };
    rerender(<AccountCommandStrip/>);
    expect(screen.getByText("user account summary unavailable")).toBeTruthy();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2);

    state.summary = {
      data: { accounts: [{ virtualEquity: 240.55 }] },
      isLoading: false,
      isError: true,
    };
    rerender(<AccountCommandStrip/>);
    expect(screen.getByText("$240.55")).toBeTruthy();
    expect(screen.getByText("Last-known equity")).toBeTruthy();
    expect(screen.getByText("user account equity · refresh failed")).toBeTruthy();
  });

  it("keeps stale LIVE_SHARED freshness and margin labeling", () => {
    state.live.freshness = "stale";
    render(<AccountCommandStrip/>);
    expect(screen.getByText("$2,104.00")).toBeTruthy();
    expect(screen.getByText("Last-known equity")).toBeTruthy();
    expect(screen.getByText("canonical · last known")).toBeTruthy();
    expect(screen.getByText("canonical free margin · last known")).toBeTruthy();
  });

  it("does not invent DEMO/PAPER free margin from allocation or account equity", () => {
    state.mode = { ...state.mode, isLiveShared: false, cleanModeLabel: "PAPER" };
    state.summary = {
      data: {
        accounts: [{ virtualBalance: 1500, virtualEquity: 1400 }],
        allocationView: { availableAllocation: 740 },
      },
      isLoading: false,
      isError: false,
    };
    render(<AccountCommandStrip/>);
    const margin = screen.getByText("Available margin").parentElement!;
    expect(margin.textContent).toContain("Unavailable");
    expect(margin.textContent).toContain("free margin not provided by DEMO/PAPER account summary");
    expect(margin.textContent).not.toContain("$740.00");
  });

  it("renders missing performance and risk values with explicit error copy", () => {
    state.live.live.liveEquity = null as never;
    state.live.live.freeMargin = null as never;
    state.performance.isError = true;
    state.performance.data = undefined as never;
    state.risk.data = undefined as never;
    state.risk.isError = true;
    render(<AccountCommandStrip/>);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("performance data unavailable")).toBeTruthy();
    expect(screen.getByText("risk budget unavailable")).toBeTruthy();
  });
});
