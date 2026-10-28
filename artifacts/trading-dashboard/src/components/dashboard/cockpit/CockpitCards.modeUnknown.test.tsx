// Cockpit cards when /api/me/account-mode could not be checked.
//
// useTradingMode then reports isModeUnknown=true with envelope=null,
// isFrozen=false and canManualTrade=false. Nothing about the account was read:
// not the pause flag, not the approval state, not the mode. The Trading
// Permission card used to say "Not paused" and "Waiting for approval", and the
// account snapshot footer fell through to "SIM" for a user who may be live,
// while EnvironmentPill on the same page said "Mode unknown".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({
  mode: {} as Record<string, unknown>,
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
  useGetMeSharedAccountSummary: () => ({ data: { ok: true, accounts: [{ status: "pending", masterBrokerName: "Broker", masterAccountNumberMasked: "****12" }], allocationView: null, masterMt5: null }, isLoading: false }),
  getGetMeSharedAccountSummaryQueryKey: () => ["/api/me/shared-account/summary"],
}));

import { TradingPermissionSummaryCard, AccountSnapshotCard } from "./CockpitCards";
import { EnvironmentPill } from "./EnvironmentPill";

function unknownMode(over: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isError: true,
    isModeUnknown: true,
    envelope: null,
    isLiveShared: false,
    isDemo: false,
    isPaper: false,
    isLiveArmed: false,
    isFrozen: false,
    isAdmin: false,
    isAdminPreviewingUserMode: false,
    shouldShowAdminDiagnostics: false,
    canManualTrade: false,
    canAutoTrade: false,
    cleanModeLabel: "Mode unknown",
    cleanUserMessage: "Your account mode could not be checked just now. ARX will check again.",
    cleanBlockedReason: null,
    shouldShowDemoPaperCopy: false,
    ...over,
  };
}

function rowValue(testId: string): string {
  return screen.getByTestId(testId).querySelector("dd")!.textContent ?? "";
}

beforeEach(() => {
  h.mode = unknownMode();
});
afterEach(() => cleanup());

describe("Trading Permission card — account-mode check failed", () => {
  it("does not claim 'Not paused' when the pause flag was never read", () => {
    render(<TradingPermissionSummaryCard />);
    const pause = rowValue("permission-pause");
    expect(pause).not.toBe("Not paused");
    expect(pause).toBe("Could not be checked");
  });

  it("does not claim 'Waiting for approval' when the approval state was never read", () => {
    render(<TradingPermissionSummaryCard />);
    const status = screen.getByTestId("permission-status").textContent ?? "";
    expect(status).not.toBe("Waiting for approval");
    expect(status).toBe("Could not be checked");
    const card = screen.getByTestId("cockpit-trading-permission").textContent ?? "";
    expect(card).toContain("Your account mode could not be checked just now.");
    expect(card).not.toContain("Your account is approved for trading.");
  });

  it("a read envelope still says 'Not paused' / 'Waiting for approval' (the state was observed)", () => {
    h.mode = unknownMode({
      isError: false,
      isModeUnknown: false,
      envelope: { userRiskCaps: { maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: null, allowedSymbols: null, requireStopLoss: false } },
      isDemo: true,
      cleanModeLabel: "Demo Mode",
      cleanUserMessage: "Demo mode — practice only. No real money is at risk.",
    });
    render(<TradingPermissionSummaryCard />);
    expect(rowValue("permission-pause")).toBe("Not paused");
    expect(screen.getByTestId("permission-status").textContent).toBe("Waiting for approval");
  });
});

describe("Account snapshot footer — account-mode check failed", () => {
  it("does not label a possibly-live account 'SIM'; agrees with EnvironmentPill", () => {
    render(<AccountSnapshotCard />);
    const card = screen.getByTestId("cockpit-account-snapshot");
    const label = screen.getByTestId("cockpit-account-mode-label").textContent ?? "";
    expect(label).not.toBe("SIM");
    expect(label).toBe("Mode unknown");
    expect(card.textContent).not.toMatch(/\bSIM\b/);
    cleanup();
    render(<EnvironmentPill />);
    expect(screen.getByTestId("cockpit-env-pill").textContent).toContain("Mode unknown");
  });

  it("while the mode is still loading the footer says it is checking, not 'SIM'", () => {
    h.mode = unknownMode({ isLoading: true, isError: false, isModeUnknown: false, cleanModeLabel: "Loading…", cleanUserMessage: "" });
    render(<AccountSnapshotCard />);
    expect(screen.getByTestId("cockpit-account-mode-label").textContent).toBe("Checking mode");
  });

  it("a read PAPER / DEMO / LIVE mode keeps its label", () => {
    h.mode = unknownMode({ isError: false, isModeUnknown: false, envelope: {}, isPaper: true, cleanModeLabel: "Paper Mode" });
    render(<AccountSnapshotCard />);
    expect(screen.getByTestId("cockpit-account-mode-label").textContent).toBe("SIM");
    cleanup();
    h.mode = unknownMode({ isError: false, isModeUnknown: false, envelope: {}, isDemo: true, cleanModeLabel: "Demo Mode" });
    render(<AccountSnapshotCard />);
    expect(screen.getByTestId("cockpit-account-mode-label").textContent).toBe("DEMO");
  });
});
