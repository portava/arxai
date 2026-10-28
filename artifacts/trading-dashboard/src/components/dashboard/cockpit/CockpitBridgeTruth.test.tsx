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
vi.mock("@/hooks/useLiveAccountSnapshotContext", () => ({ useLiveAccountSnapshotCtx: () => ({ snapshot: null, live: null, freshness: "unavailable", connectionStatus: "unavailable", lastUpdatedMs: null, notLiveReason: null, isEstimate: false, isStale: false, isUnavailable: true, warnings: [], reload: () => {} }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMeSharedAccountSummary: () => ({ data: h.summary, isLoading: h.summaryLoading }),
  getGetMeSharedAccountSummaryQueryKey: () => ["/api/me/shared-account/summary"],
}));

import { EnvironmentPill } from "./EnvironmentPill";
import { TradingPermissionSummaryCard, AccountSnapshotCard } from "./CockpitCards";
import { describeOnboardingTradingStatus } from "@/components/onboarding/OnboardingProvider";
import { resolveTradeRoomStatus } from "@/components/dashboard/trade/tradeRoomStatus";
import { TradeHero } from "@/components/dashboard/trade/TradePanels";
import { describeBridgeObservation } from "./bridgeObservation";

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
    const s = resolveTradeRoomStatus(h.mode as never, describeBridgeObservation({ onSharedRoute: true, allocationView: allocationView() }));
    expect(s.canTrade).toBe(false);
    expect(s.modeLabel).toBe("Trading blocked");
    expect(s.blockedLabel).toBe("Trading blocked");
    expect(s.gatesLabel).toBe(OPERATOR_PAUSED);
    expect(s.rgStatus.label).toBe("Trading blocked");
    for (const v of [s.modeLabel, s.blockedLabel, s.gatesLabel, s.rgStatus.label]) expect(v).not.toMatch(/bridge/i);
  });
});

describe("bridge connectivity comes from a heartbeat-derived observation, not the envelope", () => {
  it("Case A: approved LIVE_SHARED, no blocker, shared master bridge offline → Bridge row is not 'Connected'", () => {
    setMode();
    setSummary(allocationView({ bridgeAvailability: "UNAVAILABLE", bridgeMessage: "Live bridge is offline." }));
    render(<TradingPermissionSummaryCard />);
    expect(bridgeRow()).not.toBe("Connected");
    expect(bridgeRow()).toBe("Unavailable");
    expect(screen.getByTestId("permission-bridge").getAttribute("title")).toBe("Live bridge is offline.");
  });

  it("Case B: arming blocker while the shared master heartbeat is fresh → Bridge row is 'Online', not 'Disconnected'", () => {
    setMode({ cleanBlockedReason: CONFIRM_LIVE });
    setSummary(allocationView({ bridgeAvailability: "HEALTHY" }));
    render(<TradingPermissionSummaryCard />);
    expect(bridgeRow()).not.toBe("Disconnected");
    expect(bridgeRow()).toBe("Online");
  });

  it("no bridge observation (summary unreadable) → says it was not checked, never 'Connected'", () => {
    setMode();
    setSummary(null);
    render(<TradingPermissionSummaryCard />);
    expect(bridgeRow()).toBe("Not checked");
  });

  it("not on the shared master route → the shared bridge is not presented as the user's bridge", () => {
    setMode({ isLiveShared: false, isDemo: true, envelope: envelope({ currentAccountMode: "DEMO", accountShellStatus: { accountMode: "PERSONAL_MT5", tradingMode: "DEMO", tradingModeLabel: "Demo", approvalStatus: "APPROVED", tradingStatus: "ACTIVE" } }) });
    setSummary(allocationView({ bridgeAvailability: "HEALTHY" }));
    render(<TradingPermissionSummaryCard />);
    expect(bridgeRow()).toBe("Not checked here");
  });

  it("onboarding: no 'Connected' chip and no 'connected through the active trading route' without a heartbeat", () => {
    setMode();
    const ok = describeOnboardingTradingStatus(h.mode as never);
    expect(ok.bridgeChip.label).not.toBe("Connected");
    expect(ok.platform.note).not.toMatch(/connected through/i);
    setMode({ cleanBlockedReason: CONFIRM_LIVE });
    const blocked = describeOnboardingTradingStatus(h.mode as never);
    expect(blocked.bridgeChip.label).not.toBe("Unavailable");
    expect(blocked.bridgeChip.label).toBe("Not checked here");
  });

  it("trade room: blocker → connection pill is not 'Disconnected'; Risk Governor bridge follows the observation", () => {
    setMode({ cleanBlockedReason: CONFIRM_LIVE });
    const online = describeBridgeObservation({ onSharedRoute: true, allocationView: allocationView() });
    const s = resolveTradeRoomStatus(h.mode as never, online);
    expect(s.connStatus).not.toBe("Disconnected");
    expect(s.bridge).toBe("Online");
    setMode();
    const offline = describeBridgeObservation({ onSharedRoute: true, allocationView: allocationView({ bridgeAvailability: "UNAVAILABLE", bridgeMessage: "Live bridge is offline." }) });
    const s2 = resolveTradeRoomStatus(h.mode as never, offline);
    expect(s2.bridge).not.toBe("Connected");
    expect(s2.bridge).toBe("Unavailable");
  });

  it("trade room connection card shows the bridge observation and does not paint LIVE green when the bridge is offline", () => {
    const offline = describeBridgeObservation({ onSharedRoute: true, allocationView: allocationView({ bridgeAvailability: "UNAVAILABLE", bridgeMessage: "Live bridge is offline." }) });
    render(<TradeHero description="d" connStatus="LIVE" isLive bridge={offline} broker="—" account="—" />);
    expect(screen.getByTestId("trade-connection-bridge").textContent).toBe("Bridge: Unavailable");
  });
});

describe("permission-only envelope never reads as 'All clear' / 'All systems operational' / risk 'Managed'", () => {
  it("approved LIVE_SHARED with the shared bridge offline and every risk cap null", () => {
    setMode();
    setSummary(allocationView({ bridgeAvailability: "UNAVAILABLE", bridgeMessage: "Live bridge is offline." }));
    render(<TradingPermissionSummaryCard />);
    const card = screen.getByTestId("cockpit-trading-permission");
    expect(card.textContent).not.toContain("All clear");
    expect(card.textContent).not.toContain("Managed");
    expect(screen.getByTestId("permission-status").textContent).toBe("Approved · bridge unavailable");
    expect(card.textContent).toContain("Live bridge is offline.");
    expect(screen.getByTestId("permission-risk-caps").querySelector("dd")!.textContent).toBe("None set");
    // No session / system health is measured here — only the pause flag.
    expect(card.textContent).not.toMatch(/Session/);
    expect(screen.getByTestId("permission-pause").querySelector("dd")!.textContent).toBe("Not paused");
  });

  it("approved with the bridge online says 'Approved to trade' (a permission statement) and counts real caps", () => {
    setMode({ envelope: envelope({ userRiskCaps: { maxLotSize: 0.1, maxOpenTrades: null, maxDailyLossAmount: 50, allowedSymbols: null, requireStopLoss: true } }) });
    setSummary(allocationView({ bridgeAvailability: "HEALTHY" }));
    render(<TradingPermissionSummaryCard />);
    expect(screen.getByTestId("permission-status").textContent).toBe("Approved to trade");
    const caps = screen.getByTestId("permission-risk-caps");
    expect(caps.querySelector("dd")!.textContent).toBe("2 set");
    expect(caps.getAttribute("title")).toBe("Account caps: max lot 0.1, daily loss limit $50.");
  });

  it("EnvironmentPill LIVE sub-line is a permission statement, not 'All systems operational'", () => {
    setMode();
    render(<EnvironmentPill />);
    const pill = screen.getByTestId("cockpit-env-pill");
    expect(pill.textContent).not.toContain("All systems operational");
    expect(pill.textContent).toContain("Approved for live trading");
  });

  it("onboarding says live trading is approved, not 'available'", () => {
    setMode();
    const { platform } = describeOnboardingTradingStatus(h.mode as never);
    expect(platform.title).toBe("Live trading approved");
  });

  it("trade room Risk Governor does not print 'Trading available' from the envelope alone", () => {
    setMode();
    const s = resolveTradeRoomStatus(h.mode as never, describeBridgeObservation({ onSharedRoute: true, allocationView: allocationView() }));
    expect(s.rgStatus.label).toBe("Approved to trade");
  });
});

describe("account snapshot 'Active' pill needs an observation, not the LIVE_SHARED mode label", () => {
  it("approved-but-unconfirmed LIVE_SHARED (display-only), allocation pending → not 'Active'", () => {
    setMode({ cleanBlockedReason: CONFIRM_LIVE });
    h.summary = { ok: true, accounts: [{ status: "pending", masterBrokerName: "Broker", masterAccountNumberMasked: "****12" }], allocationView: allocationView(), masterMt5: null };
    render(<AccountSnapshotCard />);
    const pill = screen.getByTestId("cockpit-account-active-pill");
    expect(pill.textContent).not.toBe("Active");
    expect(pill.textContent).toBe("Blocked");
  });

  it("LIVE_SHARED with no blocker but an allocation row that is not active → 'Inactive'", () => {
    setMode();
    h.summary = { ok: true, accounts: [{ status: "pending" }], allocationView: allocationView(), masterMt5: null };
    render(<AccountSnapshotCard />);
    expect(screen.getByTestId("cockpit-account-active-pill").textContent).toBe("Inactive");
  });

  it("an active allocation row with no blocker → 'Active'", () => {
    setMode();
    h.summary = { ok: true, accounts: [{ status: "active" }], allocationView: allocationView(), masterMt5: null };
    render(<AccountSnapshotCard />);
    expect(screen.getByTestId("cockpit-account-active-pill").textContent).toBe("Active");
  });
});
