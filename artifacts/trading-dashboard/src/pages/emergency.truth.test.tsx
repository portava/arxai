// Safety Core — Control Tower (/emergency): every headline says what the
// server reported, and nothing reads as healthy when a stop halts trading or
// the status could not be read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Q = { data?: unknown; isLoading?: boolean; isError?: boolean; dataUpdatedAt?: number; errorUpdatedAt?: number; refetch?: () => void };
const h = vi.hoisted(() => ({ status: {} as Q }));
const mutation = () => ({ mutate: () => undefined, isPending: false });

vi.mock("@workspace/api-client-react", () => ({
  useGetSystemStatus: () => h.status,
  useSetSystemMode: mutation,
  useEngageKillSwitch: mutation,
  useResetKillSwitch: mutation,
  useGetSystemVault: () => ({ data: { events: [] }, isLoading: false }),
  useGetSystemStateTransitions: () => ({ data: { transitions: [] }, isLoading: false }),
  getGetSystemStatusQueryKey: () => ["/api/system/status"],
  getGetSystemVaultQueryKey: () => ["/api/system/vault"],
  getGetSystemStateTransitionsQueryKey: () => ["/api/system/state-transitions"],
}));

const { default: Emergency } = await import("./emergency");

const baseStatus = (over: Record<string, unknown> = {}) => ({
  operationalMode: "PAPER_TRADING",
  globalState: "NORMAL",
  effectiveProfile: { executionPermission: "FULL", description: "Normal conditions." },
  killSwitchEngaged: false,
  killSwitchEngagedAt: null,
  killSwitchReason: null,
  mt5LinkHealth: "DOWN",
  lastMt5HeartbeatAt: null,
  secondsSinceMt5Heartbeat: null,
  lastModeChangeAt: null,
  lastModeChangedBy: null,
  reasons: [],
  blockers: [],
  allowedModes: ["OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING"],
  activeHalts: [],
  activeHaltReasons: [],
  activeHaltsCheckedAt: "2026-10-28T11:00:00.000Z",
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Emergency /></QueryClientProvider>);
}
const headline = () => screen.getByTestId("safety-core-headline").textContent ?? "";

beforeEach(() => { h.status = { data: baseStatus(), isLoading: false, isError: false, dataUpdatedAt: Date.now() }; });
afterEach(() => cleanup());

describe("Control Tower — stops other than the safety-core switch", () => {
  it("does not say 'Safety Core Online' while the platform emergency stop halts trading", () => {
    h.status.data = baseStatus({
      activeHalts: ["platform_emergency_stop"],
      activeHaltReasons: ["The platform emergency stop is engaged by an operator. (news spike)"],
    });
    renderPage();
    expect(headline()).not.toMatch(/Safety Core Online/);
    expect(headline()).toMatch(/halted/i);
    const halts = screen.getByTestId("safety-core-halts").textContent ?? "";
    expect(halts).toMatch(/platform emergency stop/);
    expect(halts).toMatch(/news spike/);
    // The kill-switch panel says the safety-core switch is separate from the halt.
    expect(screen.getByTestId("kill-switch-other-halts").textContent).toMatch(/already halted by the platform emergency stop/);
  });

  it("names the trader's own kill switch", () => {
    h.status.data = baseStatus({
      activeHalts: ["trader_kill_switch"],
      activeHaltReasons: ["Your kill switch is engaged. Release it to trade again."],
    });
    renderPage();
    expect(headline()).not.toMatch(/Safety Core Online/);
    expect(screen.getByTestId("safety-core-halts").textContent).toMatch(/your kill switch/);
  });

  it("does not claim all clear when the other stops were not reported", () => {
    h.status.data = baseStatus({ activeHalts: null, activeHaltReasons: [] });
    renderPage();
    expect(headline()).not.toMatch(/Safety Core Online/);
    expect(screen.getByTestId("safety-core-halts").textContent).toMatch(/could not be checked/);
  });

  it("says 'Safety Core Online' only when every stop was checked and none is engaged", () => {
    renderPage();
    expect(headline()).toBe("Safety Core Online");
    expect(screen.getByTestId("safety-core-halts").textContent).toMatch(/No stop is engaged/);
  });

  it("still headlines the safety-core kill switch when it is engaged, and lists the other stop too", () => {
    h.status.data = baseStatus({
      killSwitchEngaged: true,
      activeHalts: ["platform_emergency_stop", "safety_core_kill_switch"],
      activeHaltReasons: ["The platform emergency stop is engaged by an operator.", "The safety-core kill switch is engaged."],
    });
    renderPage();
    expect(headline()).toBe("KILL SWITCH ENGAGED");
    expect(screen.getByTestId("safety-core-halts").textContent).toMatch(/platform emergency stop/);
  });
});
