// Truth regressions for the Live Shared Activation cockpit.
//
// Smoke test: a row the server marks "not_checked" (it runs nothing that could
// fail) is never shown as a green pass or counted in "N/11 pass", and a smoke
// request that fails says "could not be loaded" instead of crashing on a
// missing summary.
//
// Readiness: a degraded readiness body (a server query failed; its kill switch,
// counts and exposure are fail-closed stand-ins) or a failed request shows
// "readiness could not be loaded", never "KILL SWITCH ACTIVE", "Approved users
// 0" or a definite checklist failure.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminLiveSharedActivationPage from "./live-shared-activation";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function readinessBody(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    globalSwitches: {
      serverMasterSwitchEnabled: false, serverMasterSwitchEnvOnly: false, liveBrokerExecutionArmedDb: false,
      liveBrokerExecutionArmedAt: null, liveBrokerExecutionArmedBy: null, liveBrokerExecutionArmedBridgeId: null,
      platformMode: "LIVE", liveEnabled: true, accountRoutingMode: "SHARED_MASTER_MT5",
      sharedLiveTradingEnabled: true, masterBridgeLiveEnabled: true,
      emergencyKillSwitch: false, killSwitchEngagedAt: null, killSwitchReason: null,
    },
    liveAccount: {
      pinnedBridge: null, detector: { detected: false, primaryReason: "NO_BRIDGE" },
      detectedAccountNumber: null, detectedBrokerName: null, detectedServerName: null,
      gate: { decision: "BLOCKED", primaryReason: "NO_PINNED_BRIDGE" },
    },
    approvedUsers: { approvedCount: 1, activeCount: 1, rows: [] },
    openExposure: { totalOpenLots: 0.3, totalFloatingPlUsd: 12, openPositionsCount: 2 },
    recentCommands: [], recentAudit: [],
    constants: { MIN_LIVE_EA_VERSION: "1.27", LIVE_HEARTBEAT_MAX_AGE_SEC: 15 },
    requiredConfirmationPhrases: { activate: "ACTIVATE", killSwitch: "KILL" },
    ...over,
  };
}

function stubApi(routes: Record<string, () => Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    for (const [path, make] of Object.entries(routes)) if (String(url).endsWith(path)) return make();
    return response({ ok: false, error: "UNSTUBBED" }, 404);
  }));
}

async function runSmoke() {
  render(<AdminLiveSharedActivationPage />);
  await settle();
  fireEvent.mouseDown(screen.getByTestId("tab-smoke"), { button: 0, ctrlKey: false });
  await settle();
  fireEvent.click(screen.getByTestId("smoke-run"));
  await settle();
}

const check = (id: string, status: string, pass: boolean) => ({ id, label: id, pass, status, detail: `${id} detail` });

describe("activation smoke test", () => {
  it("shows not-checked rows as not checked, never as pass, and leaves them out of the pass count", async () => {
    stubApi({
      "/api/admin/live-shared/readiness": () => response(readinessBody()),
      "/api/admin/live-shared/activation-smoke-test": () => response({
        ok: true,
        summary: { total: 4, passed: 2, failed: 0, notChecked: 2 },
        checks: [
          check("C1_readiness", "pass", true),
          check("C5_validate_endpoint", "not_checked", false),
          check("C6_execute_blocked_when_master_off", "not_checked", false),
          check("C11_audit_log_write", "pass", true),
        ],
        bridgeGate: { decision: "BLOCKED" },
      }),
    });
    await runSmoke();
    await waitFor(() => expect(screen.getByTestId("smoke-result")).toBeTruthy());
    expect(screen.getByTestId("smoke-result").textContent).toMatch(/2\/4 pass · 2 not checked/);
    const c5 = screen.getByTestId("smoke-check-C5_validate_endpoint");
    expect(c5.getAttribute("data-status")).toBe("not_checked");
    expect(c5.textContent).toMatch(/not checked/);
  });

  it("an older server's pass:false row reads as a fail, not a pass", async () => {
    stubApi({
      "/api/admin/live-shared/readiness": () => response(readinessBody()),
      "/api/admin/live-shared/activation-smoke-test": () => response({
        ok: true,
        summary: { total: 2, passed: 1, failed: 1 },
        checks: [{ id: "A", label: "A", pass: true, detail: "" }, { id: "B", label: "B", pass: false, detail: "" }],
        bridgeGate: { decision: "BLOCKED" },
      }),
    });
    await runSmoke();
    await waitFor(() => expect(screen.getByTestId("smoke-result")).toBeTruthy());
    expect(screen.getByTestId("smoke-result").textContent).toMatch(/1\/2 pass · 1 fail/);
  });

  it("a failed smoke request says it could not be loaded", async () => {
    stubApi({
      "/api/admin/live-shared/readiness": () => response(readinessBody()),
      "/api/admin/live-shared/activation-smoke-test": () => response({ ok: false, error: "INTERNAL_ERROR" }, 500),
    });
    await runSmoke();
    await waitFor(() => expect(screen.getByTestId("smoke-error")).toBeTruthy());
    expect(screen.getByTestId("smoke-error").textContent).toMatch(/could not be loaded: INTERNAL_ERROR/);
    expect(screen.queryByTestId("smoke-result")).toBeNull();
  });
});

// The body GET /admin/live-shared/readiness returns from its catch block.
function degradedBody() {
  const b = readinessBody({
    degraded: true,
    degradedReason: "READINESS_QUERY_FAILED",
    message: "Live Shared readiness could not be loaded (a server query failed).",
    approvedUsers: { readable: false, approvedCount: 0, activeCount: 0, rows: [] },
    openExposure: { readable: false, totalOpenLots: 0, totalFloatingPlUsd: 0, openPositionsCount: 0 },
  });
  return {
    ...b,
    globalSwitches: { ...b.globalSwitches, readable: false, platformMode: "UNKNOWN", emergencyKillSwitch: true, serverMasterSwitchEnabled: false },
  };
}

describe("activation readiness that could not be loaded", () => {
  it("a degraded body shows 'could not be loaded', not KILL SWITCH ACTIVE or 'Approved users 0'", async () => {
    stubApi({ "/api/admin/live-shared/readiness": () => response(degradedBody()) });
    render(<AdminLiveSharedActivationPage />);
    await settle();
    await waitFor(() => expect(screen.getByTestId("banner-load-failed")).toBeTruthy());
    expect(screen.getByTestId("banner-load-failed").textContent).toMatch(/a server query failed/);
    expect(screen.queryByTestId("banner-kill-switch")).toBeNull();
    expect(screen.queryByTestId("mode-chip-kill")).toBeNull();
    expect(screen.getByTestId("mode-chip-not-loaded")).toBeTruthy();
    expect(screen.queryByText("Approved users")).toBeNull();
    expect(screen.queryByText(/Kill switch engaged/)).toBeNull();
    expect(screen.queryByText("Activation checklist")).toBeNull();
    expect(screen.getByTestId("readiness-unavailable")).toBeTruthy();
  });

  it("a failed request shows 'could not be loaded' instead of loading forever", async () => {
    stubApi({ "/api/admin/live-shared/readiness": () => response({ ok: false, error: "INTERNAL_ERROR" }, 500) });
    render(<AdminLiveSharedActivationPage />);
    await settle();
    await waitFor(() => expect(screen.getByTestId("banner-load-failed")).toBeTruthy());
    expect(screen.getByTestId("banner-load-failed").textContent).toMatch(/INTERNAL_ERROR/);
    expect(screen.queryByText("loading…")).toBeNull();
  });

  it("a failed refresh does not keep showing the earlier readiness as current", async () => {
    let fail = false;
    stubApi({
      "/api/admin/live-shared/readiness": () => (fail ? response(degradedBody()) : response(readinessBody())),
    });
    render(<AdminLiveSharedActivationPage />);
    await settle();
    await waitFor(() => expect(screen.getByText("Approved users")).toBeTruthy());
    fail = true;
    fireEvent.click(screen.getByTestId("act-refresh"));
    await settle();
    await waitFor(() => expect(screen.getByTestId("banner-load-failed")).toBeTruthy());
    expect(screen.queryByText("Approved users")).toBeNull();
  });
});

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

describe("live shared activation — checklist rows nothing checked", () => {
  function minimal(): Json {
    return readiness({
      globalSwitches: {
        platformMode: "DEMO", liveEnabled: false, accountRoutingMode: "USER_OWNED_MT5",
        sharedLiveTradingEnabled: false, masterBridgeLiveEnabled: false,
      },
      liveAccount: {
        pinnedBridge: null,
        detector: { detected: false, primaryReason: "NO_LIVE_BRIDGE" },
        detectedAccountNumber: null, detectedBrokerName: null, detectedServerName: null,
      },
    });
  }

  it("rows the page never checks read 'not checked', not passed", async () => {
    const r = minimal();
    r.approvedUsers = { approvedCount: 0, activeCount: 0, rows: [] };
    await renderWith(r);
    for (const id of ["audit", "queue_reachable", "attribution_reachable", "demo_works"]) {
      const el = checkRow(id);
      expect(el.dataset.state, id).toBe("not-checked");
      expect(el.textContent, id).toMatch(/not checked/);
    }
  });

  it("the passed/total badge does not count unchecked rows", async () => {
    const r = minimal();
    r.approvedUsers = { approvedCount: 0, activeCount: 0, rows: [] };
    await renderWith(r);
    // 21 rows, 4 never checked here. Passing: operator authenticated (the
    // admin-only readiness endpoint answered) and both stops released.
    expect(screen.getByTestId("checklist-badge").textContent).toBe("2/17 passed · 4 not checked");
  });

  it("operator authentication cites the server's admin check, not a constant", async () => {
    await renderWith(minimal());
    const el = checkRow("operator_auth");
    expect(el.dataset.state).toBe("pass");
    expect(el.textContent).toMatch(/readiness endpoint accepted this session as admin\/owner/);
  });
});

describe("live shared activation — master switch labels", () => {
  it("env var set, operator not armed: the Safety card names the env value and the effective value separately", async () => {
    await renderWith(readiness({
      globalSwitches: { serverMasterSwitchEnabled: false, serverMasterSwitchEnvOnly: true, liveBrokerExecutionArmedDb: false },
    }));
    expect(screen.queryByText("Master switch (env)")).toBeNull();
    const env = screen.getByTestId("safety-master-switch-env");
    expect(env.textContent).toContain("ARX_LIVE_BROKER_EXECUTION_ENABLED");
    expect(env.textContent).toContain("true");
    const armed = screen.getByTestId("safety-master-switch-armed");
    expect(armed.textContent).toMatch(/Operator arm/);
    expect(armed.textContent).toContain("false");
    const eff = screen.getByTestId("safety-master-switch-effective");
    expect(eff.textContent).toMatch(/effective: env AND operator arm/);
    expect(eff.textContent).toContain("false");
  });
});

describe("live shared activation — identity confirmation copy", () => {
  async function openWizard() {
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("tab-wizard"), { button: 0, ctrlKey: false });
    });
  }

  it("the wizard does not claim an identity confirmation it never collects", async () => {
    await renderWith(readiness());
    await openWizard();
    fireEvent.change(screen.getByTestId("wizard-phrase"), { target: { value: "ENABLE LIVE TRADING" } });
    expect(screen.queryByText(/confirm to proceed/i)).toBeNull();
    const ref = screen.getByTestId("wizard-detected-identity");
    expect(ref.textContent).toMatch(/not confirmed by this wizard/i);
    expect(screen.getByTestId("detected-account").textContent).toBe("12341234");
    // Only the typed phrase enables the setting steps; nothing else is asked.
    expect((screen.getByTestId("wiz-routing") as HTMLButtonElement).disabled).toBe(false);
  });

  it("the READY TO ARM banner and Arm card do not ask the operator to type what Arm sends for them", async () => {
    await renderWith(readiness());
    const banner = screen.getByTestId("banner-ready-to-arm");
    expect(banner.textContent).not.toMatch(/Confirm bridge identity/);
    expect(banner.textContent).not.toMatch(/type the activation phrase/);
    expect(banner.textContent).toMatch(/sends the detected account \/ broker \/ server/);
    const card = screen.getByTestId("arm-execution-card");
    expect(card.textContent).not.toMatch(/Type the phrase/);
    expect(card.textContent).toMatch(/nothing is typed/i);
  });

  it("LOCKED does not claim Arm is disabled (the server refuses it instead)", async () => {
    await renderWith(readiness({ liveAccount: { pinnedBridge: null } }));
    const card = screen.getByTestId("arm-execution-card");
    expect(card.textContent).not.toMatch(/Arm disabled/);
    expect(card.textContent).toMatch(/server refuses Arm/);
  });
});

describe("live shared activation — readiness that could not be loaded", () => {
  // The readiness route's catch branch answers ok:true, degraded:true with
  // fail-closed placeholders (both stops "engaged", platformMode UNKNOWN, no
  // users). Those are not observations and must not be shown as state.
  function degraded(): Json {
    return {
      ...readiness({
        globalSwitches: {
          platformMode: "UNKNOWN", emergencyKillSwitch: true, platformStopEngaged: true,
          platformStopSources: ["platform_emergency_stop", "safety_core_kill_switch"],
        },
        liveAccount: { pinnedBridge: null, detector: { detected: false, primaryReason: "READINESS_DEGRADED" } },
      }),
      degraded: true,
      degradedReason: "READINESS_QUERY_FAILED",
      message: "Live Shared readiness data is temporarily unavailable. Live dispatch remains blocked while readiness cannot be evaluated.",
      approvedUsers: { approvedCount: 0, activeCount: 0, rows: [] },
    };
  }

  it("a degraded readiness is 'could not be loaded', not an engaged kill switch or zero users", async () => {
    await renderWith(degraded());
    const banner = screen.getByTestId("banner-load-failed");
    expect(banner.textContent).toMatch(/could not be loaded/i);
    expect(banner.textContent).toMatch(/temporarily unavailable/);
    expect(screen.queryByTestId("banner-kill-switch")).toBeNull();
    expect(screen.queryByText(/safety-core kill switch is engaged/)).toBeNull();
    expect(screen.queryByTestId("checklist-badge")).toBeNull();
    expect(screen.queryByText("loading…")).toBeNull();
    expect(screen.getAllByText(/Readiness could not be loaded/).length).toBeGreaterThan(0);
  });

  it("a refused readiness request is 'could not be loaded', and does not keep the earlier state as current", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => readiness() } as Response)
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ ok: false, error: "ADMIN_REQUIRED" }) } as Response);
    vi.stubGlobal("fetch", fetcher);
    render(<AdminLiveSharedActivationPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("banner-ready-to-arm")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId("act-refresh")); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByTestId("banner-ready-to-arm")).toBeNull();
    expect(screen.getByTestId("banner-load-failed").textContent).toMatch(/ADMIN_REQUIRED/);
  });

  it("a network failure is 'could not be loaded'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(<AdminLiveSharedActivationPage />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("banner-load-failed").textContent).toMatch(/network down/);
    expect(screen.getByTestId("mode-chip-not-loaded")).toBeTruthy();
  });
});
