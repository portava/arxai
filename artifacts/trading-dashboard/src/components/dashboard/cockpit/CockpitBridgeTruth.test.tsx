// Cockpit / trade room / onboarding — account-mode blockers are not bridge
// observations, and bridge connectivity is never inferred from the envelope.
//
// `cleanBlockedReason` comes only from computeAccountModePrecedence (operator
// pause, tradingMode, live confirmation, master switch, assignment pending).
// None of those branches reads a heartbeat, so no surface may label it
// "Bridge Disconnected", and its absence is not evidence of "Connected".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

type AllocationView = {
  bridgeAvailability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE";
  bridgeMessage: string;
  hasAllocation: boolean;
  assignedAllocation: number;
  availableAllocation: number;
  reservedRisk: number;
  openFloatingLoss: number;
  isOverAllocated: boolean;
};

const h = vi.hoisted(() => ({
  mode: {} as Record<string, unknown>,
  summary: undefined as undefined | { ok: boolean; accounts: unknown[]; allocationView: unknown; masterMt5: unknown },
  summaryLoading: false,
}));

vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useLocation: () => ["/", () => {}],
}));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => h.mode }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/lib/symbol-context", () => ({ useActiveSymbol: () => ({ active: "EURUSD" }) }));
vi.mock("@/hooks/useLiveAccountSnapshotContext", () => ({ useLiveAccountSnapshotCtx: () => ({}) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMeSharedAccountSummary: () => ({ data: h.summary, isLoading: h.summaryLoading }),
  getGetMeSharedAccountSummaryQueryKey: () => ["/api/me/shared-account/summary"],
}));

import { EnvironmentPill } from "./EnvironmentPill";
import { TradingPermissionSummaryCard } from "./CockpitCards";
import { describeOnboardingTradingStatus } from "@/components/onboarding/OnboardingProvider";
import { resolveTradeRoomStatus } from "@/components/dashboard/trade/tradeRoomStatus";

const OPERATOR_PAUSED = "Your operator has paused trading on your account. Live dispatch will remain blocked until trading is re-enabled.";
const CONFIRM_LIVE = "Complete live confirmation to start placing live orders. Your operator can enable Full Live Activation on your behalf.";

function envelope(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    currentAccountMode: "LIVE_SHARED",
    cleanBlockedReason: null,
    userApprovalStatus: "APPROVED",
    accountShellStatus: { accountMode: "SHARED_MASTER_MT5", tradingMode: "LIVE", tradingModeLabel: "Live", approvalStatus: "APPROVED", tradingStatus: "ACTIVE" },
    userRiskCaps: { maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: null, allowedSymbols: null, requireStopLoss: false },
    ...over,
  };
}

function setMode(over: Record<string, unknown> = {}) {
  const cleanBlockedReason = (over["cleanBlockedReason"] as string | null | undefined) ?? null;
  h.mode = {
    isLoading: false,
    isError: false,
    isLiveShared: true,
    isDemo: false,
    isPaper: false,
    isFrozen: false,
    canManualTrade: cleanBlockedReason == null,
    cleanModeLabel: "Live (Shared Master MT5)",
    cleanUserMessage: "Your account is approved for trading.",
    cleanBlockedReason,
    envelope: envelope({ cleanBlockedReason }),
    ...over,
  };
}

function allocationView(over: Partial<AllocationView> = {}): AllocationView {
  return {
    bridgeAvailability: "HEALTHY",
    bridgeMessage: "Live bridge is healthy.",
    hasAllocation: true,
    assignedAllocation: 1000,
    availableAllocation: 1000,
    reservedRisk: 0,
    openFloatingLoss: 0,
    isOverAllocated: false,
    ...over,
  };
}

function setSummary(view: AllocationView | null) {
  h.summary = { ok: true, accounts: [], allocationView: view, masterMt5: null };
}

function bridgeRow(): string {
  const card = screen.getByTestId("cockpit-trading-permission");
  const dt = within(card).getByText("Bridge");
  return dt.parentElement!.querySelector("dd")!.textContent ?? "";
}

beforeEach(() => {
  setMode();
  setSummary(allocationView());
  h.summaryLoading = false;
});
afterEach(() => cleanup());

describe("account-mode blocker is labelled as a block, never as a bridge disconnect", () => {
  it("EnvironmentPill names the block and carries the server's reason (operator paused, heartbeat fresh)", () => {
    setMode({ cleanBlockedReason: OPERATOR_PAUSED });
    render(<EnvironmentPill />);
    const pill = screen.getByTestId("cockpit-env-pill");
    expect(pill.textContent).not.toMatch(/bridge/i);
    expect(pill.textContent).toContain("Trading blocked");
    expect(pill.textContent).toContain(OPERATOR_PAUSED);
  });

  it("Trading Permission status label does not say 'Bridge disconnected' for an arming blocker", () => {
    setMode({ cleanBlockedReason: CONFIRM_LIVE });
    render(<TradingPermissionSummaryCard />);
    const status = screen.getByTestId("permission-status");
    expect(status.textContent).not.toMatch(/bridge/i);
    expect(status.textContent).toBe("Trading blocked");
  });

  it("onboarding status names the block and shows the reason, not 'Bridge connection unavailable'", () => {
    setMode({ cleanBlockedReason: OPERATOR_PAUSED });
    const { platform } = describeOnboardingTradingStatus(h.mode as never);
    expect(platform.title).toBe("Trading blocked");
    expect(platform.title + platform.note).not.toMatch(/bridge/i);
    expect(platform.note).toBe(OPERATOR_PAUSED);
  });

  it("trade room mode label / blocked label / risk governor status name the block", () => {
    setMode({ cleanBlockedReason: OPERATOR_PAUSED });
    const s = resolveTradeRoomStatus(h.mode as never);
    expect(s.canTrade).toBe(false);
    expect(s.modeLabel).toBe("Trading blocked");
    expect(s.blockedLabel).toBe("Trading blocked");
    expect(s.gatesLabel).toBe(OPERATOR_PAUSED);
    expect(s.rgStatus.label).toBe("Trading blocked");
    for (const v of [s.modeLabel, s.blockedLabel, s.gatesLabel, s.rgStatus.label]) expect(v).not.toMatch(/bridge/i);
  });
});
