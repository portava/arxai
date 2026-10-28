import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminLiveSharedActivationPage from "./live-shared-activation";

// A readiness response in which every pre-arm check passes (fresh live pinned
// bridge, EA inputs reported true, platform/routing/bridge live, one approved
// capped user, both install-wide stops released). Each test changes only what
// it is about.
type Json = Record<string, unknown>;
function readiness(over: { globalSwitches?: Json; liveAccount?: Json } = {}): Json {
  return {
    ok: true,
    globalSwitches: {
      serverMasterSwitchEnabled: false,
      serverMasterSwitchEnvOnly: false,
      liveBrokerExecutionArmedDb: false,
      liveBrokerExecutionArmedAt: null,
      liveBrokerExecutionArmedBy: null,
      liveBrokerExecutionArmedBridgeId: null,
      platformMode: "LIVE",
      liveEnabled: true,
      accountRoutingMode: "SHARED_MASTER_MT5",
      sharedLiveTradingEnabled: true,
      masterBridgeLiveEnabled: true,
      emergencyKillSwitch: false,
      killSwitchEngagedAt: null,
      killSwitchReason: null,
      platformStopEngaged: false,
      platformStopSources: [],
      platformStopReason: null,
      ...(over.globalSwitches ?? {}),
    },
    liveAccount: {
      pinnedBridge: {
        connectionId: 7, mode: "live", accountType: "live", accountNumberMasked: "••••1234",
        brokerName: "Broker", eaVersion: "1.27", lastHeartbeatAt: new Date().toISOString(),
        heartbeatAgeSeconds: 2, readOnlyMode: false,
      },
      // The server sends maskBridgeEvidenceForUser(): flat EA-input fields.
      detector: {
        detected: true,
        bridge: {
          bridgeId: 7, brokerName: "Broker", accountNumberMasked: "••34", eaVersion: "1.27",
          heartbeatAgeSec: 2, accountType: "live", mode: "live", readOnlyMode: false,
          enableLiveExecution: true, enableDemoExecution: false, terminalConnected: true,
          algoTradingAllowed: true, maxLiveLot: 0.01,
        },
      },
      detectedAccountNumber: "12341234",
      detectedBrokerName: "Broker",
      detectedServerName: "Broker-Live",
      gate: { decision: "ALLOW" },
      ...(over.liveAccount ?? {}),
    },
    approvedUsers: {
      approvedCount: 1, activeCount: 1,
      rows: [{
        userId: 2, email: "trader@example.com", approved: true, tradingEnabled: true, status: "ACTIVE",
        maxLot: 0.01, maxOpenPositions: 1, maxExposurePerSymbolLots: 0.01, dailyLossLimitUsd: 50,
        allowedSymbols: ["EURUSD"], scannerLiveEnabled: false, approvedAt: null,
      }],
    },
    recentCommands: [],
    recentAudit: [],
    constants: { MIN_LIVE_EA_VERSION: "1.27", LIVE_HEARTBEAT_MAX_AGE_SEC: 15 },
    requiredConfirmationPhrases: { activate: "ENABLE LIVE TRADING", killSwitch: "ENGAGE KILL SWITCH" },
  };
}

async function renderWith(body: Json) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response));
  render(<AdminLiveSharedActivationPage />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function checkRow(id: string): HTMLElement {
  return screen.getByTestId(`check-${id}`);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("live shared activation — install-wide stops", () => {
  it("baseline: every pre-arm check passing and both stops released reads READY TO ARM", async () => {
    await renderWith(readiness());
    expect(screen.getByTestId("banner-ready-to-arm")).toBeTruthy();
  });

  it("an engaged safety-core kill switch is a kill-switch state, not READY TO ARM", async () => {
    await renderWith(readiness({
      globalSwitches: {
        emergencyKillSwitch: false,
        platformStopEngaged: true,
        platformStopSources: ["safety_core_kill_switch"],
        platformStopReason: "The safety-core kill switch is engaged. (drawdown breach)",
      },
    }));
    expect(screen.queryByTestId("banner-ready-to-arm")).toBeNull();
    expect(screen.queryByTestId("banner-armed")).toBeNull();
    const banner = screen.getByTestId("banner-kill-switch");
    expect(banner.textContent).toMatch(/safety-core kill switch/i);
    expect(banner.textContent).toContain("drawdown breach");
    // Wizard step 9 (POST /admin/trading/reset-kill) releases only the
    // platform emergency stop; the banner must not send the operator there
    // for the safety-core switch.
    expect(banner.textContent).toMatch(/Emergency page/);
    expect(screen.getByTestId("mode-chip-kill")).toBeTruthy();
    expect(checkRow("kill_released").dataset.state).toBe("fail");
  });

  it("an armed server with the safety-core kill switch engaged is not 'LIVE BROKER EXECUTION ENABLED'", async () => {
    await renderWith(readiness({
      globalSwitches: {
        serverMasterSwitchEnabled: true, serverMasterSwitchEnvOnly: true, liveBrokerExecutionArmedDb: true,
        platformStopEngaged: true, platformStopSources: ["safety_core_kill_switch"],
        platformStopReason: "The safety-core kill switch is engaged.",
      },
    }));
    expect(screen.queryByTestId("banner-armed")).toBeNull();
    expect(screen.getByTestId("banner-kill-switch")).toBeTruthy();
  });

  it("the Safety card names each install-wide stop separately", async () => {
    await renderWith(readiness({
      globalSwitches: { platformStopEngaged: true, platformStopSources: ["safety_core_kill_switch"] },
    }));
    const row = screen.getByTestId("safety-core-kill-row");
    expect(row.textContent).toMatch(/Safety-core kill switch engaged/);
    expect(row.textContent).toContain("true");
  });

  it("a readiness response without the install-wide stop fields cannot read as ready", async () => {
    const r = readiness();
    const g = r.globalSwitches as Json;
    delete g.platformStopEngaged; delete g.platformStopSources; delete g.platformStopReason;
    await renderWith(r);
    expect(screen.queryByTestId("banner-ready-to-arm")).toBeNull();
    const banner = screen.getByTestId("banner-locked");
    expect(within(banner).getByText(/install-wide stop state not reported/)).toBeTruthy();
  });
});

describe("live shared activation — EA-reported inputs", () => {
  it("reads the flat EA-input fields the readiness route sends (maskBridgeEvidenceForUser)", async () => {
    await renderWith(readiness());
    expect(checkRow("enable_live_execution").dataset.state).toBe("pass");
    expect(checkRow("terminal_connected").dataset.state).toBe("pass");
    expect(checkRow("algo_trading_allowed").dataset.state).toBe("pass");
  });

  it("an EA input reported false still fails", async () => {
    const r = readiness();
    const det = (r.liveAccount as Json).detector as { bridge: Json };
    det.bridge.terminalConnected = false;
    det.bridge.enableLiveExecution = null;
    await renderWith(r);
    expect(checkRow("terminal_connected").dataset.state).toBe("fail");
    expect(checkRow("enable_live_execution").dataset.state).toBe("fail");
    expect(checkRow("algo_trading_allowed").dataset.state).toBe("pass");
  });

  it("no detected bridge: the EA-input rows fail", async () => {
    await renderWith(readiness({ liveAccount: { detector: { detected: false, primaryReason: "NO_LIVE_BRIDGE" } } }));
    expect(checkRow("terminal_connected").dataset.state).toBe("fail");
    expect(checkRow("algo_trading_allowed").dataset.state).toBe("fail");
    expect(checkRow("enable_live_execution").dataset.state).toBe("fail");
  });
});
