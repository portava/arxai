// Protective Auto-Close: the engine's hard-coded product locks (it never uses
// the MT5 bridge and live execution is locked in code) are not shown as a
// measured "MT5 bridge is not connected" reading. The page never checks the
// user's bridge, so it must not claim to know the bridge's state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { default: ProtectiveAutoClosePage } = await import("./protective-auto-close");

const SETTINGS = {
  enabled: true, inactivityThresholdMin: 15, mode: "AUTO_IF_INACTIVE", closeType: "FULL",
  partialClosePercent: 50, maxAutoClosesPerTrade: 1, cooldownMin: 5, minConfidence: "HIGH",
  requireMultiSignal: true, protectProfitEnabled: false, protectProfitGivebackPct: 30,
  maxLossProtectionEnabled: false, maxLossProtectionPct: 50, killSwitchEngaged: false,
};

function renderPage() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, settings: SETTINGS, activity: { status: "INACTIVE", reason: "No pings.", inactiveDurationMs: 30 * 60_000 } }),
  })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ProtectiveAutoClosePage /></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Protective Auto-Close gate labels", () => {
  it("does not claim the MT5 bridge is not connected (the page never measures it)", async () => {
    renderPage();
    await screen.findByText("Required gates");
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/MT5 bridge is not connected/i);
    expect(screen.queryByText("Broker bridge connected")).toBeNull();
    const lock = screen.getByTestId("pac-lock-broker-close");
    expect(lock.textContent).toMatch(/product lock/i);
    expect(lock.textContent).toMatch(/does not check your MT5 bridge/i);
    expect(lock.textContent).not.toMatch(/BLOCKED/);
  });

  it("the live-execution row is labelled as a product lock, not a measured gate", async () => {
    renderPage();
    await screen.findByText("Required gates");
    expect(screen.queryByText("Live execution unlocked")).toBeNull();
    const lock = screen.getByTestId("pac-lock-live-execution");
    expect(lock.textContent).toMatch(/LOCKED/);
    expect(lock.textContent).not.toMatch(/BLOCKED/);
    // ALERT_ONLY is attributed to the product lock, not to a bridge reading.
    expect(screen.getByTestId("pac-alert-only-reason").textContent).toMatch(/product lock/i);
  });
});
