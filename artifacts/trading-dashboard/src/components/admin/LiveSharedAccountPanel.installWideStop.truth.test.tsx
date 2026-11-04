// Truth regression for the /admin/live-shared panel: the safety-core kill switch.
//
// There are two install-wide stops. emergencyKillSwitch is only the platform
// emergency stop (global_trading_settings). The safety-core kill switch shows
// up only in platformStopSources / platformStopDetail (platformStopReport()),
// and the live pipeline's dispatch pre-check refuses new live risk on it too
// (and on a safety_core row it could not read). The panel read only
// emergencyKillSwitch, so with every switch on and the safety core engaged or
// unreadable it showed "Live trading: Active", "Kill switch: released" and a
// Kill Switch tab badge of "Released" while new live orders were refused.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveSharedAccountPanel } from "./LiveSharedAccountPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Every switch the header's "Live trading" badge reads is on; both stops released.
function allOnBody(stop: Record<string, unknown> = {
  platformStopEngaged: false, platformStopSources: [], platformStopReason: null,
  platformStopReadable: true, platformStopDetail: {},
}) {
  return {
    ok: true,
    architecture: { model: "EA_PULL", summary: "EA pulls commands.", brokerCredentialsOnServer: false },
    globalSwitches: {
      serverMasterSwitchEnabled: true, serverMasterSwitchEnvOnly: true,
      liveBrokerExecutionArmedDb: true, platformMode: "LIVE", liveEnabled: true,
      accountRoutingMode: "SHARED_MASTER_MT5", sharedLiveTradingEnabled: true,
      masterBridgeLiveEnabled: true, complianceReviewFlag: false,
      emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
      ...stop,
    },
    liveAccount: { pinnedBridge: null, detector: { detected: false }, gate: { decision: "BLOCKED" } },
    approvedUsers: { approvedCount: 1, activeCount: 1, rows: [] },
    openExposure: { totalOpenLots: 0, totalFloatingPlUsd: 0, openPositionsCount: 0 },
    recentCommands: [], recentAudit: [], arxLiveCommandsCount: 0,
  };
}

const SAFETY_CORE_ENGAGED = {
  platformStopEngaged: true,
  platformStopSources: ["safety_core_kill_switch"],
  platformStopReason: "The safety-core kill switch is engaged. (drawdown breach)",
  platformStopReadable: true,
  platformStopDetail: { safety_core_kill_switch: "drawdown breach" },
};

// readSafetyCoreSwitch() threw: readable:false, engaged:true, "state unreadable".
// The settings were read, so there is no platform_emergency_stop detail.
const SAFETY_CORE_UNREAD = {
  platformStopEngaged: true,
  platformStopSources: ["safety_core_kill_switch"],
  platformStopReason: "The safety-core kill switch is engaged. (state unreadable)",
  platformStopReadable: false,
  platformStopDetail: { safety_core_kill_switch: "state unreadable" },
};

function stub(readiness: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/admin/live-shared/readiness")) return new Response(JSON.stringify(readiness), { status: 200 });
    if (u.endsWith("/api/admin/master-bridge/current")) return new Response(JSON.stringify({ ok: false, primaryReason: "NO_BRIDGE" }), { status: 200 });
    return new Response(JSON.stringify({ ok: false }), { status: 403 });
  }));
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><LiveSharedAccountPanel /></QueryClientProvider>);
}

function openKillTab() {
  const trigger = document.querySelector('[data-tab-value="kill"]') as HTMLElement;
  fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
}

async function loaded() {
  await waitFor(() => expect(screen.getByText(/Live trading:/)).toBeTruthy());
}

describe("LiveSharedAccountPanel — safety-core kill switch", () => {
  it("engaged: never shows live trading active or an unqualified released kill switch", async () => {
    stub(allOnBody(SAFETY_CORE_ENGAGED));
    renderPanel();
    await loaded();
    expect(screen.queryByText(/Live trading: Active/)).toBeNull();
    expect(screen.getByText(/Live trading: Not active — the safety-core kill switch is engaged/)).toBeTruthy();
    expect(screen.queryByText(/Kill switch: released/)).toBeNull();
    expect(screen.getByText(/Platform emergency stop: released/)).toBeTruthy();
    expect(screen.getByText(/Safety-core kill switch: engaged \(drawdown breach\)/)).toBeTruthy();
    // The release switch is only the platform emergency stop.
    expect(screen.getByText(/does not release the safety-core kill switch/)).toBeTruthy();

    openKillTab();
    const state = await waitFor(() => screen.getByTestId("kill-tab-emergency-stop-state"));
    expect(state.textContent).toContain("Platform emergency stop:");
    expect(state.textContent).not.toMatch(/Current state:/);
    const core = screen.getByTestId("kill-tab-safety-core-state");
    expect(core.textContent).toContain("Safety-core kill switch:");
    expect(core.textContent).toContain("ENGAGED");
    expect(core.textContent).toContain("drawdown breach");
  });

  it("unreadable: says it could not be read and treats it as engaged", async () => {
    stub(allOnBody(SAFETY_CORE_UNREAD));
    renderPanel();
    await loaded();
    expect(screen.queryByText(/Live trading: Active/)).toBeNull();
    expect(screen.getByText(/Live trading: Not active — the safety-core kill switch could not be read/)).toBeTruthy();
    expect(screen.queryByText(/Kill switch: released/)).toBeNull();
    expect(screen.getByText(/Safety-core kill switch: could not be read \(state unreadable\) — treated as engaged/)).toBeTruthy();
    // The platform settings were read, so their switches are still readings.
    expect(screen.queryByTestId("live-shared-settings-unread")).toBeNull();
    expect(screen.getByText(/Trading mode: Live/)).toBeTruthy();

    openKillTab();
    const core = await waitFor(() => screen.getByTestId("kill-tab-safety-core-state"));
    expect(core.textContent).toContain("Could not be read (state unreadable) — treated as engaged");
    expect(core.textContent).not.toContain("ENGAGED");
  });

  it("not reported: does not claim live trading is active", async () => {
    stub(allOnBody({}));
    renderPanel();
    await loaded();
    expect(screen.queryByText(/Live trading: Active/)).toBeNull();
    expect(screen.getByText(/Live trading: Not confirmed — the safety-core kill switch was not reported/)).toBeTruthy();
    expect(screen.queryByText(/Kill switch: released/)).toBeNull();
    expect(screen.getByText(/Safety-core kill switch: not reported/)).toBeTruthy();
  });

  it("both stops released and read: live trading active, kill switch released", async () => {
    stub(allOnBody());
    renderPanel();
    await loaded();
    expect(screen.getByText(/Live trading: Active/)).toBeTruthy();
    expect(screen.getByText(/Kill switch: released/)).toBeTruthy();
    expect(screen.queryByText(/Safety-core kill switch/)).toBeNull();

    openKillTab();
    const state = await waitFor(() => screen.getByTestId("kill-tab-emergency-stop-state"));
    expect(state.textContent).toContain("Current state:");
    expect(state.textContent).toContain("Released");
    expect(screen.queryByTestId("kill-tab-safety-core-state")).toBeNull();
  });
});
