// Regression: My Account must render what /api/me/account-shell actually
// measured. A figure the server reports as unknown (null) is "Not measured" /
// "Not available", never $0 or 0.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
    tradingMode: "SIMULATED", tradingModeLabel: "Paper Mode — simulated only.",
    allocation: {
      assignedStartingBalance: 1000, currentBalance: 1000, equity: 1000, marginUsed: 0,
      totalAllocation: 1000, manualAllocation: 1000, aiSleeveAllocation: 0, aiSleeveEnabled: false,
      aiAutoTradingEnabled: false, aiStrategyMode: null, currency: "USD", availableCapacity: 1000,
      allocationPending: false, frozen: false, freezeMessage: null,
    },
    pnl: {
      openPnl: 0, closedPnlToday: null, closedPnlWeek: null, closedPnlTotal: null,
      tradesToday: null, winsToday: null, lossesToday: null, closedMeasured: false,
      closedNote: "Not measured: this card has no source for your closed trades yet, so today's P/L, closed P/L and trade counts are not shown.",
    },
    risk: {
      availableRiskAmount: 10, dailyLossRemaining: null,
      dailyLossRemainingNote: "Not measured: today's closed P/L is not available here, so the loss left under your daily limit cannot be worked out.",
      openExposureLots: 0, maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: 100,
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
});
