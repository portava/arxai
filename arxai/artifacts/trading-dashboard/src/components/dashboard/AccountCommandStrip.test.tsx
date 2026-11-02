import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  performance: { data: { todayPnl: 74.6 }, isLoading: false, isError: false },
  live: {
    snapshot: { accountMode: "LIVE_SHARED" },
    live: { liveEquity: 2104, freeMargin: 890 },
    freshness: "fresh", lastUpdatedMs: 1_000, isEstimate: false, isRefreshing: false, isUnavailable: false, connectionStatus: "live",
  },
  mode: { isLiveShared: true, isLoading: false, isError: false, cleanModeLabel: "LIVE · Shared Master MT5" },
  risk: { data: { dailyRiskLimit: 400, dailyRiskUsed: 50 }, isLoading: false, isError: false },
}));

vi.mock("@workspace/api-client-react", () => ({ useGetPerformanceSummary: () => state.performance }));
vi.mock("@/hooks/useLiveAccountSnapshotContext", () => ({ useLiveAccountSnapshotCtx: () => state.live }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => state.mode }));
vi.mock("@/hooks/useRiskBudgetSnapshot", () => ({ useRiskBudgetSnapshot: () => state.risk }));

import { AccountCommandStrip } from "./AccountCommandStrip";

afterEach(() => cleanup());

describe("account command strip", () => {
  it("groups canonical account values, daily realized P/L, account-scoped risk, and actual mode", () => {
    render(<AccountCommandStrip/>);
    expect(screen.getByText("$2,104.00")).toBeTruthy();
    expect(screen.getByText("$74.60")).toBeTruthy();
    expect(screen.getByText("$890.00")).toBeTruthy();
    expect(screen.getByText("12.5%")).toBeTruthy();
    expect(screen.getByText("LIVE · Shared Master MT5")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Account overview" })).toBeTruthy();
  });

  it("renders missing figures honestly and retains loading/error copy", () => {
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
