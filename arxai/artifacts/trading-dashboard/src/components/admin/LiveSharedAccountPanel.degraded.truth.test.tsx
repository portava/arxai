// Truth regression for the /admin/live-shared panel.
//
// When a readiness query fails the server answers 200 {ok:true, degraded:true}
// with fail-closed stand-ins (kill switch "engaged", 0 users, 0 exposure,
// 0 pending commands) and readable:false on each section. Those are not
// readings: the panel must say readiness could not be loaded, and must not
// show "Kill switch: engaged", zero counts or a release toggle built from them.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveSharedAccountPanel } from "./LiveSharedAccountPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const DEGRADED_MESSAGE =
  "Live Shared readiness could not be loaded (a server query failed). The kill switch, arm state, bridge, approved users and open exposure are unknown, not zero. This report does not block or allow live dispatch; each dispatch runs its own gates.";

function degradedBody() {
  return {
    ok: true,
    degraded: true,
    degradedReason: "READINESS_QUERY_FAILED",
    message: DEGRADED_MESSAGE,
    architecture: { model: "EA_PULL", brokerCredentialsOnServer: false },
    globalSwitches: {
      readable: false,
      serverMasterSwitchEnabled: false, serverMasterSwitchEnvOnly: false,
      liveBrokerExecutionArmedDb: false, platformMode: "UNKNOWN", liveEnabled: false,
      accountRoutingMode: "USER_OWNED_MT5", sharedLiveTradingEnabled: false,
      masterBridgeLiveEnabled: false, complianceReviewFlag: false,
      emergencyKillSwitch: true, killSwitchEngagedAt: null, killSwitchReason: null,
      platformStopEngaged: true,
      platformStopSources: ["platform_emergency_stop", "safety_core_kill_switch"],
      platformStopReason: null,
    },
    liveAccount: {
      readable: false, pinnedBridge: null,
      detector: { detected: false, primaryReason: "READINESS_DEGRADED" },
      gate: { decision: "BLOCKED", primaryReason: "READINESS_DEGRADED" },
    },
    approvedUsers: { readable: false, approvedCount: 0, activeCount: 0, rows: [] },
    openExposure: { readable: false, totalOpenLots: 0, totalFloatingPlUsd: 0, openPositionsCount: 0 },
    recentCommands: [], recentAudit: [], arxLiveCommandsCount: 0,
  };
}

function healthyBody() {
  return {
    ok: true,
    architecture: { model: "EA_PULL", summary: "EA pulls commands.", brokerCredentialsOnServer: false },
    globalSwitches: {
      serverMasterSwitchEnabled: false, serverMasterSwitchEnvOnly: false,
      liveBrokerExecutionArmedDb: false, platformMode: "DEMO", liveEnabled: false,
      accountRoutingMode: "USER_OWNED_MT5", sharedLiveTradingEnabled: false,
      masterBridgeLiveEnabled: false, complianceReviewFlag: false,
      emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
      // The route always sends both install-wide stops (platformStopReport()).
      platformStopEngaged: false, platformStopSources: [], platformStopReason: null,
      platformStopReadable: true, platformStopDetail: {},
    },
    liveAccount: { pinnedBridge: null, detector: { detected: false }, gate: { decision: "BLOCKED" } },
    approvedUsers: { approvedCount: 2, activeCount: 1, rows: [] },
    openExposure: { totalOpenLots: 0.2, totalFloatingPlUsd: 3, openPositionsCount: 1 },
    recentCommands: [], recentAudit: [], arxLiveCommandsCount: 4,
  };
}

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

describe("LiveSharedAccountPanel — degraded readiness", () => {
  it("says readiness could not be loaded and shows none of the fail-closed stand-ins as readings", async () => {
    stub(degradedBody());
    renderPanel();
    const alert = await waitFor(() => screen.getByTestId("live-shared-readiness-not-loaded"));
    expect(alert.textContent).toContain("Live Shared readiness could not be loaded");
    expect(alert.textContent).toContain("unknown, not zero");
    expect(screen.queryByText(/Kill switch: engaged/)).toBeNull();
    expect(screen.queryByText(/ENGAGED/)).toBeNull();
    expect(screen.queryByTestId("switch-release-kill")).toBeNull();
    expect(screen.queryByTestId("switch-platform-mode-live")).toBeNull();
    expect(screen.queryByText(/Pending commands: 0/)).toBeNull();
    expect(screen.queryByText(/Approved Users \(0/)).toBeNull();
    expect(screen.queryByText(/Live trading: Not active/)).toBeNull();
  });

  it("treats a section marked readable:false as not loaded even without the degraded flag", async () => {
    const body = { ...degradedBody(), degraded: undefined, message: undefined };
    stub(body);
    renderPanel();
    const alert = await waitFor(() => screen.getByTestId("live-shared-readiness-not-loaded"));
    expect(alert.textContent).toContain("Live Shared readiness could not be loaded");
    expect(screen.queryByText(/Kill switch: engaged/)).toBeNull();
    expect(screen.queryByTestId("switch-release-kill")).toBeNull();
  });

  it("still renders a readable readiness body", async () => {
    stub(healthyBody());
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Kill switch: released/)).toBeTruthy());
    expect(screen.getByText(/Pending commands: 4/)).toBeTruthy();
    expect(screen.getByTestId("switch-release-kill")).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});

// Only the global_trading_settings read failed (no row, more rows than the
// reader accepts, schema drift). loadPlatformSettings() fails closed — stop
// "engaged" with reason "settings missing" / "state unreadable", mode OFF,
// routing defaulted to USER_OWNED_MT5 — and the route still answers 200 with
// no `degraded` flag, but with platformStopReadable:false and the detail. The
// panel rendered those stand-ins as readings: "Kill switch: engaged" with an
// enabled release toggle, "Trading mode: Demo", "Routing: User-owned".
function settingsUnreadBody(detail: "settings missing" | "state unreadable") {
  const b = healthyBody();
  return {
    ...b,
    globalSwitches: {
      ...b.globalSwitches,
      platformMode: "OFF", liveEnabled: false, accountRoutingMode: "USER_OWNED_MT5",
      sharedLiveTradingEnabled: false, masterBridgeLiveEnabled: false, liveBrokerExecutionArmedDb: false,
      emergencyKillSwitch: true, killSwitchEngagedAt: null, killSwitchReason: detail,
      platformStopEngaged: true, platformStopSources: ["platform_emergency_stop"], platformStopReason: detail,
      platformStopReadable: false, platformStopDetail: { platform_emergency_stop: detail },
    },
  };
}

describe("LiveSharedAccountPanel — platform settings that could not be read", () => {
  for (const detail of ["settings missing", "state unreadable"] as const) {
    it(`(${detail}) shows no fail-closed stand-in as a reading and offers no release`, async () => {
      stub(settingsUnreadBody(detail));
      renderPanel();
      await waitFor(() => expect(screen.getByTestId("live-shared-settings-unread")).toBeTruthy());
      expect(screen.getByTestId("live-shared-settings-unread").textContent).toContain(detail);
      expect(screen.queryByText(/Kill switch: engaged/)).toBeNull();
      expect(screen.getByText(new RegExp(`Kill switch: could not be read \\(${detail}\\) — treated as engaged`))).toBeTruthy();
      for (const stand of [/Trading mode: Demo/, /Trading mode: Live/, /Routing: User-owned/, /Routing: Shared master/,
        /Shared live trading: Off/, /Master bridge: Off/, /Operator broker execution: Off/]) {
        expect(screen.queryByText(stand)).toBeNull();
      }
      expect(screen.getByText(/Trading mode: could not be read/)).toBeTruthy();
      expect(screen.getByText(/Routing: could not be read/)).toBeTruthy();
      // No toggle positioned from unread settings can be flipped.
      for (const id of ["switch-release-kill", "switch-routing-shared", "switch-master-bridge-live",
        "switch-shared-live-trading", "switch-platform-mode-live"]) {
        expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
      }
      // The server-side checks are still reported as they were read.
      expect(screen.getByText(/Pending commands: 4/)).toBeTruthy();
    });
  }

  it("a read stop with the same stored reason text is still a reading", async () => {
    const b = settingsUnreadBody("settings missing");
    stub({ ...b, globalSwitches: { ...b.globalSwitches, platformStopReadable: true, platformMode: "DEMO" } });
    renderPanel();
    await waitFor(() => expect(screen.getByText(/Kill switch: engaged/)).toBeTruthy());
    expect(screen.queryByTestId("live-shared-settings-unread")).toBeNull();
    expect((screen.getByTestId("switch-release-kill") as HTMLButtonElement).disabled).toBe(false);
  });
});
