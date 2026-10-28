// One account-mode envelope, one "Risk caps" verdict on every surface.
//
// The cockpit Trading Permission card used describeRiskCaps (lot / open-trade /
// daily-loss only) and the Trade Command Room Risk Governor used riskCapsStatus.
// For the same envelope they disagreed:
//   - allowedSymbols only: cockpit "None set", trade room "Caps assigned";
//   - frozen account:      cockpit "<n> set" / "None set", trade room "Lock active";
//   - envelope missing:    cockpit "Not loaded — could not be read" (even while
//                          loading), trade room "Checking — have not loaded yet"
//                          (even after the check failed).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { riskCapsStatus, type RiskCapsEnvelopeSlice } from "@/lib/riskCapsStatus";

const h = vi.hoisted(() => ({ mode: {} as Record<string, unknown> }));

vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
  useLocation: () => ["/", () => {}],
}));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => h.mode }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@/lib/symbol-context", () => ({ useActiveSymbol: () => ({ active: "EURUSD" }) }));
vi.mock("@/hooks/useLiveAccountSnapshotContext", () => ({ useLiveAccountSnapshotCtx: () => ({ snapshot: null, isUnavailable: true, isEstimate: false, freshness: "unavailable", lastUpdatedMs: null }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMeSharedAccountSummary: () => ({ data: { ok: true, accounts: [], allocationView: null, masterMt5: null }, isLoading: false }),
  getGetMeSharedAccountSummaryQueryKey: () => ["/api/me/shared-account/summary"],
}));

import { TradingPermissionSummaryCard } from "./CockpitCards";

const NO_CAPS = { maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: null, allowedSymbols: null, requireStopLoss: false };

function envelope(caps: Record<string, unknown>, isFrozen = false) {
  return {
    ok: true,
    currentAccountMode: "DEMO",
    cleanBlockedReason: null,
    accountShellStatus: { accountMode: "DEMO", tradingMode: "DEMO", tradingModeLabel: "Demo", approvalStatus: "APPROVED", tradingStatus: isFrozen ? "PAUSED" : "ACTIVE" },
    userRiskCaps: { ...NO_CAPS, ...caps },
    userFrozenStatus: { isFrozen, freezeMessage: isFrozen ? "Trading is paused on your account." : null },
  };
}

function setMode(env: ReturnType<typeof envelope> | null, state: { isModeUnknown?: boolean; isLoading?: boolean } = {}) {
  h.mode = {
    isLoading: state.isLoading ?? false,
    isError: state.isModeUnknown ?? false,
    isModeUnknown: state.isModeUnknown ?? false,
    envelope: env,
    isLiveShared: false,
    isDemo: env != null,
    isPaper: false,
    isFrozen: env?.userFrozenStatus.isFrozen === true,
    canManualTrade: env != null && !env.userFrozenStatus.isFrozen,
    cleanModeLabel: env ? "Demo Mode" : state.isModeUnknown ? "Mode unknown" : "Loading…",
    cleanUserMessage: "",
    cleanBlockedReason: null,
  };
}

/** What the Trade Command Room page passes to its Risk Governor card. */
function tradeRoomVerdict(): { label: string; detail: string } {
  const m = h.mode as { envelope: RiskCapsEnvelopeSlice | null; isModeUnknown: boolean };
  const { label, detail } = riskCapsStatus(m.envelope, { failed: m.isModeUnknown });
  return { label, detail };
}

function cockpitVerdict(): { label: string; detail: string } {
  render(<TradingPermissionSummaryCard />);
  const row = screen.getByTestId("permission-risk-caps");
  const out = { label: row.querySelector("dd")!.textContent ?? "", detail: row.getAttribute("title") ?? "" };
  cleanup();
  return out;
}

afterEach(() => cleanup());

describe("cockpit and trade room give the same Risk caps verdict for the same envelope", () => {
  it("allowedSymbols only: a symbol restriction is a cap, not 'None set'", () => {
    setMode(envelope({ allowedSymbols: ["EURUSD"] }));
    const c = cockpitVerdict();
    expect(c.label).not.toBe("None set");
    expect(c).toEqual(tradeRoomVerdict());
    expect(c.label).toBe("Caps assigned");
    expect(c.detail).toContain("EURUSD");
  });

  it("frozen account: both surfaces say the lock, not a cap count", () => {
    setMode(envelope({ maxLotSize: 0.1 }, true));
    const c = cockpitVerdict();
    expect(c.label).not.toMatch(/set$/);
    expect(c).toEqual(tradeRoomVerdict());
    expect(c.label).toBe("Lock active");
  });

  it("check failed: both say it could not be loaded (not 'Checking')", () => {
    setMode(null, { isModeUnknown: true });
    const c = cockpitVerdict();
    expect(c).toEqual(tradeRoomVerdict());
    expect(c.label).toBe("Could not be loaded");
  });

  it("no caps and assigned caps: same words on both surfaces", () => {
    setMode(envelope({}));
    const none = cockpitVerdict();
    expect(none).toEqual(tradeRoomVerdict());
    expect(none.label).toBe("No caps assigned");
    setMode(envelope({ maxLotSize: 0.1, maxDailyLossAmount: 50 }));
    const some = cockpitVerdict();
    expect(some).toEqual(tradeRoomVerdict());
    expect(some.detail).toBe("Account caps: max lot 0.1, daily loss limit $50.");
  });

  it("still loading: the shared helper says 'Checking', never 'could not be read'", () => {
    expect(riskCapsStatus(null).label).toBe("Checking");
    expect(riskCapsStatus(null).detail).not.toMatch(/could not/);
  });
});
