// Truth regressions for My Account (/my-account).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InvestorLiveBalance } from "@/hooks/useLiveAccountSnapshot";

let live: InvestorLiveBalance | null = null;
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ envelope: null }) }));
vi.mock("@/hooks/useLiveAccountSnapshot", () => ({ useLiveAccountSnapshot: () => ({ live }) }));
vi.mock("@/components/mt5/OneClickToggleCard", () => ({ OneClickToggleCard: () => null }));

const { default: MyAccountPage } = await import("./my-account");

function shell(allocation: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    ok: true, userId: 9, accountMode: "DEMO", approvalStatus: "APPROVED", tradingStatus: "ACTIVE",
    allocation: {
      assignedStartingBalance: null, currentBalance: 0, equity: 0, marginUsed: 0,
      totalAllocation: null, manualAllocation: null, aiSleeveAllocation: null, aiSleeveEnabled: false,
      aiAutoTradingEnabled: false, aiStrategyMode: null, currency: "USD", availableCapacity: null,
      allocationPending: false, frozen: false, freezeMessage: null,
      ...allocation,
    },
    pnl: { openPnl: 0, closedPnlToday: 0, closedPnlWeek: 0, closedPnlTotal: 0, tradesToday: 0, winsToday: 0, lossesToday: 0 },
    risk: {
      availableRiskAmount: null, dailyLossRemaining: null, openExposureLots: 0, maxLotSize: null, maxOpenTrades: null,
      maxDailyLossAmount: null, maxExposurePerSymbolLots: null, allowedSymbols: null, requireStopLoss: false,
    },
    notes: { needsReviewItems: 0, sharedMasterAccountAssigned: false },
    ...over,
  };
}

const BRIDGE_PREF = {
  ok: true, preferredBridge: "USER_OWNED_MT5", sharedBridgeApproved: false, personalBridgeEnabled: true,
  sharedLiveDispatchAvailable: false, sharedLiveDispatchNote: "Live execution via the shared bridge is currently unavailable platform-wide.",
};

/** fetch stub: a body (200) or a status number (error) per path. */
function stubFetch(bodies: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url).split("?")[0]!;
    const b = bodies[path];
    if (b === undefined) return new Response(JSON.stringify({ error: `unmocked ${path}` }), { status: 404 });
    if (typeof b === "number") return new Response(JSON.stringify({ ok: false }), { status: b });
    return new Response(JSON.stringify(b), { status: 200 });
  }));
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MyAccountPage /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); live = null; });

describe("My Account: Assigned Allocation", () => {
  it("does not show the running balance as an assigned allocation when nothing was assigned", async () => {
    // Server today: no allocation row but a virtual account exists, so it
    // copies the running balance into assignedStartingBalance.
    stubFetch({
      "/api/me/account-shell": shell({ assignedStartingBalance: 1234.5, currentBalance: 1234.5, equity: 1234.5, totalAllocation: null }),
      "/api/me/bridge-preference": BRIDGE_PREF,
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("my-allocation")).toBeTruthy());
    expect(screen.getByTestId("my-balance").textContent).toBe("$1,234.5");
    expect(screen.getByTestId("my-allocation").textContent).not.toMatch(/\$/);
    expect(screen.getByTestId("my-allocation").textContent).toBe("Not assigned");
  });

  it("does not fall back to the current balance when the server sends no assigned figure", async () => {
    stubFetch({
      "/api/me/account-shell": shell({ assignedStartingBalance: null, currentBalance: 800, equity: 800, totalAllocation: null }),
      "/api/me/bridge-preference": BRIDGE_PREF,
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("my-allocation")).toBeTruthy());
    expect(screen.getByTestId("my-allocation").textContent).toBe("Not assigned");
  });

  it("shows the operator's allocation when one was assigned", async () => {
    stubFetch({
      "/api/me/account-shell": shell({ assignedStartingBalance: 1000, currentBalance: 1040, equity: 1040, totalAllocation: 1000, manualAllocation: 1000, aiSleeveAllocation: 0 }),
      "/api/me/bridge-preference": BRIDGE_PREF,
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("my-allocation")).toBeTruthy());
    expect(screen.getByTestId("my-allocation").textContent).toBe("$1,000");
  });
});
