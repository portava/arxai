// Safety Core — Control Tower (/emergency): every headline says what the
// server reported, and nothing reads as healthy when a stop halts trading or
// the status could not be read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Q = { data?: unknown; isLoading?: boolean; isError?: boolean; dataUpdatedAt?: number; errorUpdatedAt?: number; refetch?: () => void };
const h = vi.hoisted(() => ({ status: {} as Q, vault: {} as Q }));
const mutation = () => ({ mutate: () => undefined, isPending: false });

vi.mock("@workspace/api-client-react", () => ({
  useGetSystemStatus: () => h.status,
  useSetSystemMode: mutation,
  useEngageKillSwitch: mutation,
  useResetKillSwitch: mutation,
  useGetSystemVault: () => h.vault,
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

beforeEach(() => {
  h.status = { data: baseStatus(), isLoading: false, isError: false, dataUpdatedAt: Date.now() };
  h.vault = { data: { events: [] }, isLoading: false, isError: false };
});
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

// PAPER_TRADING is simulated execution in the safety core, not an MT5 demo
// account. The EXEC badge is the global state's profile permission, which no
// order path reads (tradeGate, its only reader, has no caller), and the
// operational mode is not read by the governed order pipeline either.
describe("Control Tower — mode and execution labels", () => {
  it("does not label PAPER_TRADING as executing on a demo account", () => {
    renderPage();
    const paper = screen.getByTestId("button-mode-PAPER_TRADING").textContent ?? "";
    expect(paper).not.toMatch(/Execute on demo account/);
    expect(paper).not.toMatch(/^DEMO/);
    expect(paper).toMatch(/^PAPER/);
    expect(paper).toMatch(/not a demo account/);
  });

  it("does not show EXEC: FULL as the execution state while the mode is OBSERVE_ONLY", () => {
    h.status.data = baseStatus({ operationalMode: "OBSERVE_ONLY", effectiveProfile: { executionPermission: "FULL" } });
    renderPage();
    const badge = screen.getByTestId("state-profile-exec").textContent ?? "";
    expect(badge).not.toMatch(/^EXEC: FULL/);
    expect(badge).toMatch(/STATE PROFILE: FULL · advisory/);
    expect(screen.getByTestId("state-profile-exec").getAttribute("title")).toMatch(/no order path reads it/);
  });

  it("says what the operational mode does and does not control", () => {
    renderPage();
    const scope = screen.getByTestId("mode-scope").textContent ?? "";
    expect(scope).not.toMatch(/governs which mode is allowed/);
    expect(scope).toMatch(/governed order pipeline \(paper, demo and live tickets\)\s+does not read it/);
    expect(scope).toMatch(/use the kill switch to halt them/);
  });
});

// A failed /system/status read is "could not be loaded", never an endless
// skeleton; a failed poll after a good read keeps the last status but marks it
// as not current and never headlines it as an all-clear.
describe("Control Tower — status read failures", () => {
  it("shows an error, not skeletons, when the first status read fails", () => {
    const refetch = vi.fn();
    h.status = { data: undefined, isLoading: false, isError: true, refetch };
    const { container } = renderPage();
    expect(screen.getByTestId("status-load-error").textContent).toMatch(/could not be loaded/);
    expect(container.querySelector(".animate-pulse")).toBeNull();
    screen.getByTestId("button-retry-status").click();
    expect(refetch).toHaveBeenCalled();
  });

  it("marks the last status as not current when a later poll fails", () => {
    const readAt = new Date("2026-10-28T11:00:00Z").getTime();
    h.status = { data: baseStatus(), isLoading: false, isError: true, dataUpdatedAt: readAt, errorUpdatedAt: readAt + 10_000 };
    renderPage();
    const stale = screen.getByTestId("status-stale").textContent ?? "";
    expect(stale).toMatch(/latest status read failed/);
    expect(stale).toMatch(new RegExp(new Date(readAt).toLocaleTimeString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(headline()).not.toMatch(/Safety Core Online/);
    expect(headline()).toBe("Safety core status not current");
  });

  it("keeps a halt headline from the last read (a warning is never upgraded) and still marks it stale", () => {
    h.status = { data: baseStatus({ killSwitchEngaged: true }), isLoading: false, isError: true, dataUpdatedAt: Date.now() };
    renderPage();
    expect(headline()).toBe("KILL SWITCH ENGAGED");
    expect(screen.getByTestId("status-stale")).toBeTruthy();
  });

  it("a failed vault read is 'could not be loaded', not 'No vault events yet.'", () => {
    h.vault = { data: undefined, isLoading: false, isError: true };
    renderPage();
    expect(screen.getByTestId("vault-load-error").textContent).toMatch(/could not be loaded/);
    expect(document.body.textContent).not.toMatch(/No vault events yet/);
  });

  it("no stale marker on a successful read", () => {
    renderPage();
    expect(screen.queryByTestId("status-stale")).toBeNull();
  });
});
