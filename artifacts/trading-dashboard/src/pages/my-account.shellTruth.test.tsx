// Regression: My Account must render what /api/me/account-shell actually
// measured. A figure the server reports as unknown (null) is "Not measured" /
// "Not available", never $0 or 0.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ envelope: null }) }));
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({ useLiveAccountSnapshot: () => ({ live: null }) }));
vi.mock("@/components/account/CanonicalBalancePanel", () => ({ CanonicalBalancePanel: () => null }));
vi.mock("@/components/mt5/OneClickToggleCard", () => ({ OneClickToggleCard: () => null }));

const { default: MyAccountPage } = await import("./my-account");

type Shell = Record<string, any>;
function shell(patch: (s: Shell) => void = () => {}): Shell {
  const s: Shell = {
    ok: true, userId: 41, accountMode: "DEMO", approvalStatus: "NOT_REQUIRED", tradingStatus: "ACTIVE",
    accountTradingStatus: "ACTIVE",
    accountTradingStatusReason: "The platform mode, your trading mode, your approval and your allocation allow trading. Your kill switch and risk limits are checked on every order and are not part of this status.",
    tradingMode: "SIMULATED", tradingModeLabel: "Paper Mode — simulated only.",
    allocation: {
      assignedStartingBalance: 1000, currentBalance: 1000, equity: 1000, marginUsed: null,
      balanceSource: "user_slot_allocation",
      balanceNote: "From the allocation your operator assigned you, plus the realized P/L booked to it.",
      marginNote: "Not measured: no margin figure is recorded for your account in this view.",
      totalAllocation: 1000, manualAllocation: 1000, aiSleeveAllocation: 0, aiSleeveEnabled: false,
      aiAutoTradingEnabled: false, aiStrategyMode: null, currency: "USD", availableCapacity: 1000,
      allocationPending: false, frozen: false, freezeMessage: null,
    },
    pnl: {
      openPnl: null, openPnlSource: null,
      openPnlNote: "Not measured: floating P/L is only read for live positions on the shared master account, not for your account here.",
      closedPnlToday: null, closedPnlWeek: null, closedPnlTotal: null,
      tradesToday: null, winsToday: null, lossesToday: null, closedMeasured: false,
      closedNote: "Not measured: this card has no source for your closed trades yet, so today's P/L, closed P/L and trade counts are not shown.",
    },
    risk: {
      availableRiskAmount: 10, dailyLossRemaining: null,
      dailyLossRemainingNote: "Not measured: today's closed P/L is not available here, so the loss left under your daily limit cannot be worked out.",
      openExposureLots: null, openExposureSource: null,
      openExposureNote: "Not measured: positions on your own MT5 account are not read here.",
      maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: 100,
      maxExposurePerSymbolLots: null, allowedSymbols: null, requireStopLoss: false, limits: {},
    },
    notes: { needsReviewItems: 0, sharedMasterAccountAssigned: false },
  };
  patch(s);
  return s;
}

function stub(body: Shell) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/me/account-shell")) return new Response(JSON.stringify(body), { status: 200 });
    return new Response("{}", { status: 503 });
  }));
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MyAccountPage /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("My Account — measured figures only", () => {
  it("unmeasured closed P/L and trade counts read 'Not measured', never $0 / 0, and say why", async () => {
    stub(shell());
    renderPage();
    await waitFor(() => expect(screen.getByTestId("my-pnl-card")).toBeTruthy());
    for (const id of ["my-pnl-today", "my-pnl-week", "my-pnl-total", "my-trades-today", "my-wins-today", "my-losses-today"]) {
      expect(screen.getByTestId(id).textContent).toBe("Not measured");
    }
    expect(screen.getByTestId("my-pnl-closed-note").textContent).toMatch(/no source for your closed trades/);
    expect(screen.getByTestId("my-daily-loss-remaining").textContent).toBe("Not measured");
    expect(screen.getByTestId("my-daily-loss-remaining-note").textContent).toMatch(/cannot be worked out/);
  });

  it("no allocation and no virtual account: balance and equity read 'Not available' and say why; margin is 'Not measured'", async () => {
    stub(shell((s) => {
      s.allocation = {
        ...s.allocation, assignedStartingBalance: null, currentBalance: null, equity: null, marginUsed: null,
        totalAllocation: null, manualAllocation: null, aiSleeveAllocation: null, availableCapacity: null,
        balanceSource: null,
        balanceNote: "Not available: no shared-account allocation or virtual account is recorded for you, so this card has no balance to show.",
      };
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("my-balance-card")).toBeTruthy());
    expect(screen.getByTestId("my-balance").textContent).toBe("Not available");
    expect(screen.getByTestId("my-equity").textContent).toBe("Not available");
    expect(screen.getByTestId("my-margin-used").textContent).toBe("Not measured");
    expect(screen.getByTestId("my-allocation").textContent).toBe("—");
    expect(screen.getByTestId("my-balance-source").textContent).toMatch(/no shared-account allocation or virtual account/);
    expect(within(screen.getByTestId("my-balance-card")).queryByText("$0")).toBeNull();
  });

  it("Open P/L that was not measured reads 'Not measured' and says why; unread exposure is not 0.00", async () => {
    stub(shell());
    renderPage();
    await waitFor(() => expect(screen.getByTestId("my-pnl-card")).toBeTruthy());
    expect(screen.getByTestId("my-pnl-open").textContent).toBe("Not measured");
    expect(screen.getByTestId("my-pnl-open-note").textContent).toMatch(/only read for live positions/);
    expect(screen.getByTestId("my-open-exposure").textContent).toBe("Not measured");
    expect(screen.getByTestId("my-open-exposure-note").textContent).toMatch(/own MT5 account are not read/);
  });

  it("journal exposure is labelled as journal lots", async () => {
    stub(shell((s) => {
      s.risk.openExposureLots = 0.3;
      s.risk.openExposureSource = "paper_trades";
      s.risk.openExposureNote = "Lots of the open entries in your trade journal, not positions read from a broker.";
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("my-open-exposure").textContent).toBe("0.30"));
    expect(screen.getByText("Open Exposure (journal lots)")).toBeTruthy();
  });

  it("the status badge is not ACTIVE when the user's own mode is DISABLED, and it says why", async () => {
    stub(shell((s) => {
      s.tradingMode = "DISABLED";
      s.tradingModeLabel = "Your operator has not enabled trading.";
      s.accountTradingStatus = "RESTRICTED";
      s.accountTradingStatusReason = "Your operator has not enabled trading on your account.";
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("trading-status-badge")).toBeTruthy());
    expect(screen.getByTestId("trading-status-badge").textContent).not.toMatch(/active/i);
    expect(screen.getByTestId("trading-status-badge").textContent).toBe("RESTRICTED");
    expect(screen.getByTestId("trading-status-reason").textContent).toMatch(/not enabled trading/);
  });

  it("equity that was not marked to market reads 'Not available' and says why", async () => {
    stub(shell((s) => {
      s.allocation.equity = null;
      s.allocation.equityNote = "Not marked to market: floating P/L of open positions is not read for your account here, so equity is not shown.";
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("my-equity").textContent).toBe("Not available"));
    expect(screen.getByTestId("my-balance").textContent).toBe("$1,000");
    expect(screen.getByTestId("my-equity-note").textContent).toMatch(/Not marked to market/);
  });
});
