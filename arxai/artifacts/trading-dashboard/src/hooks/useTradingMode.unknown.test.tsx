// Truth regression: when /api/me/account-mode fails, the user's mode is
// UNKNOWN. It is neither "Loading…" nor demo/paper, and no surface may tell a
// possibly-live user that "no real broker order is placed".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useTradingMode } from "./useTradingMode";
import { EnvironmentPill } from "@/components/dashboard/cockpit/EnvironmentPill";
import { LiveChartModeNotice } from "@/components/charts/LiveChartModeNotice";

function liveEnvelope() {
  return {
    ok: true,
    userId: 1,
    currentAccountMode: "LIVE_SHARED",
    cleanModeLabel: "Live (shared)",
    cleanUserMessage: "",
    cleanBlockedReason: null,
    role: "USER",
    isAdmin: false,
    isAdminPreviewingUserMode: false,
    adminDiagnosticsAvailable: false,
    liveExecutionArmed: true,
    userSharedMasterAssignment: { attached: true },
    accountShellStatus: { accountMode: "SHARED_MASTER_MT5", tradingMode: "LIVE", tradingModeLabel: "Live", approvalStatus: "approved", tradingStatus: "ok" },
    userAllocation: { hasAllocation: true, currentBalance: 1000, assignedStartingBalance: 1000, equity: 1000, marginUsed: 0 },
    userRiskCaps: { maxLotSize: 1, maxOpenTrades: 3, maxDailyLossAmount: 100, allowedSymbols: null, requireStopLoss: true },
    userFrozenStatus: { isFrozen: false, freezeMessage: null },
    userApprovalStatus: "approved",
    userCanManualTrade: true,
    userCanAutoTrade: true,
    aiSleeveStatus: { enabled: true, autoEnabled: false },
    demoAvailable: true,
    paperAvailable: false,
    modeSwitchOptions: [],
    adminDiagnostics: null,
  };
}

let client: QueryClient;
let status = 200;

beforeEach(() => {
  status = 200;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("fetch", vi.fn(async () =>
    status === 200
      ? new Response(JSON.stringify(liveEnvelope()), { status: 200 })
      : new Response("{}", { status }),
  ));
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

function Probe() {
  const mode = useTradingMode();
  return (
    <div>
      <EnvironmentPill />
      <LiveChartModeNotice mode={mode} />
      <span data-testid="label">{mode.cleanModeLabel}</span>
    </div>
  );
}

describe("account mode check failure", () => {
  it("after a failed refresh the hook reports an unknown mode, not demo copy or Loading…", async () => {
    const { result } = renderHook(() => useTradingMode(), { wrapper });
    await waitFor(() => expect(result.current.isLiveShared).toBe(true));
    status = 500;
    await act(async () => { await client.invalidateQueries({ queryKey: ["me", "account-mode"] }); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isModeUnknown).toBe(true);
    expect(result.current.cleanModeLabel).not.toBe("Loading…");
    expect(result.current.shouldShowDemoPaperCopy).toBe(false);
  });

  it("the live-chart notice and environment pill never claim no real broker order is placed", async () => {
    render(<Probe />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("label").textContent).toBe("Live (shared)"));
    status = 502;
    await act(async () => { await client.invalidateQueries({ queryKey: ["me", "account-mode"] }); });
    await waitFor(() => expect(screen.getByTestId("label").textContent).not.toBe("Live (shared)"));
    expect(document.body.textContent).not.toContain("no real broker order is placed");
    expect(document.body.textContent).not.toContain("Loading…");
    expect(document.body.textContent).toMatch(/could not be checked/i);
  });

  it("a mode that fails on first load is unknown too", async () => {
    status = 401;
    render(<Probe />, { wrapper });
    await waitFor(() => expect(document.body.textContent).toMatch(/could not be checked/i));
    expect(document.body.textContent).not.toContain("no real broker order is placed");
  });
});
