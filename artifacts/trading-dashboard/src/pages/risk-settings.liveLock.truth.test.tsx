import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// "Unlock Live Mode" toasted "Live trading is now permitted." and the card
// said "When locked, switching to LIVE trading mode is disabled". The toggle
// writes risk_settings.liveLocked, which no order path reads (live dispatch
// is gated by live arming and the Risk Governor; only the permission status
// and checklists list it). The page now says what it does and does not do.

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastSpy, toasts: [], dismiss: () => {} }), toast: toastSpy }));

const { default: RiskSettings } = await import("./risk-settings");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

class NoEventSource { onmessage = null; onerror = null; addEventListener() {} removeEventListener() {} close() {} }

const SETTINGS = { riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxTradesPerDay: 5, maxOpenTrades: 2, maxLotSize: 0.1, stopAfterLosingStreak: 3, cooldownAfterLossMinutes: 30, minConfidenceScore: 75, disableDuringAbnormalVolatility: true, riskMode: "Balanced" };

function stub(liveLocked: boolean) {
  vi.stubGlobal("EventSource", NoEventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/risk/lock-live")) {
      const { locked } = JSON.parse(String(init?.body ?? "{}")) as { locked: boolean };
      return json({ locked, message: "ok" });
    }
    if (url.includes("/risk/settings")) return json({ ...SETTINGS, liveLocked });
    return json({}, 404);
  }));
}

function renderEmergency() {
  window.history.replaceState({}, "", "/risk-settings?tab=emergency");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RiskSettings /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); toastSpy.mockReset(); });

describe("Risk Control Center — live mode lock", () => {
  it("turning the lock off never says live trading is now permitted", async () => {
    stub(true);
    renderEmergency();
    fireEvent.click(await screen.findByRole("button", { name: /Turn live mode lock off/ }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const t = toastSpy.mock.calls[0]![0] as { title: string; description: string };
    expect(t.title).toBe("Live mode lock removed");
    expect(t.description).not.toMatch(/now permitted/);
    expect(t.description).toMatch(/does not enable live trading/);
  });

  it("turning the lock on says orders are not checked against it", async () => {
    stub(false);
    renderEmergency();
    fireEvent.click(await screen.findByRole("button", { name: /Turn live mode lock on/ }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const t = toastSpy.mock.calls[0]![0] as { title: string; description: string };
    expect(t.title).toBe("Live mode lock saved");
    expect(t.description).toMatch(/orders are not checked against it/);
  });

  it("the card, badge and status row describe a preference, not a gate", async () => {
    stub(true);
    renderEmergency();
    const desc = await screen.findByTestId("live-lock-description");
    expect(desc.textContent).toMatch(/Orders are not checked against it/);
    expect(desc.textContent).toMatch(/does not enable live trading/);
    expect(screen.queryByText(/switching to LIVE trading mode is disabled/)).toBeNull();
    expect(screen.queryByText("Live trading is locked")).toBeNull();
    expect(screen.queryByText(/You are about to enable live trading/)).toBeNull();
    expect(screen.getByTestId("live-lock-badge").textContent).toMatch(/preference/);
    expect(screen.getByTestId("live-lock-status").textContent).toBe("ON");
    expect(screen.queryByText("LOCKED")).toBeNull();
    expect(screen.queryByText("OPEN")).toBeNull();
  });
});
