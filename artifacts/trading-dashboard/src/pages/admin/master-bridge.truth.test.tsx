import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The embedded panels have their own data hooks; they are not under test here.
vi.mock("@/components/admin/MasterLiveUserAccessTable", () => ({ MasterLiveUserAccessTable: () => null }));
vi.mock("@/components/admin/LiveGatesDiagnosticPanel", () => ({ LiveGatesDiagnosticPanel: () => null }));
vi.mock("@/pages/admin/one-click-controls", () => ({ OneClickControlsContent: () => null }));

import AdminMasterBridgePage from "./master-bridge";

type Reply = { status?: number; body?: unknown; reject?: boolean };
type Routes = Record<string, Reply>;

const settingsOn = {
  readable: true,
  platformMode: "LIVE",
  accountRoutingMode: "SHARED_MASTER_MT5",
  sharedLiveTradingEnabled: true,
  masterBridgeLiveEnabled: true,
  platformMasterBridgeConnectionId: 41,
  readAt: "2026-10-28T11:00:00.000Z",
};

function current(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    detected: false,
    primaryReason: "NO_BRIDGE_REGISTERED",
    latestHint: null,
    liveBrokerExecutionEnabled: false,
    masterLiveSettings: settingsOn,
    ...over,
  };
}

const okLists: Routes = {
  "/api/admin/shared-master/overview": { body: { ok: true, masters: [] } },
  "/api/admin/shared-master/virtual-accounts": { body: { ok: true, rows: [] } },
  "/api/admin/shared-master/attributions": { body: { ok: true, rows: [] } },
  "/api/admin/shared-master/unattributed": { body: { ok: true, rows: [] } },
  "/api/admin/master-bridge/gate": {
    body: { ok: true, verdict: { decision: "BLOCKED", primaryReason: "NO_BRIDGE_REGISTERED", blockReasons: ["NO_BRIDGE_REGISTERED"] } },
  },
};

function stubFetch(routes: Routes) {
  const fn = vi.fn(async (url: string) => {
    const path = String(url).split("?")[0]!;
    const r = routes[path];
    if (!r || r.reject) throw new TypeError("Failed to fetch");
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function renderPage(routes: Routes) {
  stubFetch({ ...okLists, ...routes });
  render(<AdminMasterBridgePage />);
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Master Bridge live banner follows the stored flags", () => {
  it("says shared live and master-bridge live are ON when they are, never 'disabled'", async () => {
    await renderPage({ "/api/admin/master-bridge/current": { body: current() } });
    expect(screen.queryByText(/Live trading via master bridge is disabled/)).toBeNull();
    expect(screen.queryByText(/remains\s+OFF/)).toBeNull();
    expect(screen.queryByText(/demo routing/i)).toBeNull();
    const alert = screen.getByTestId("alert-master-live-settings");
    expect(alert.textContent).toContain("Shared live and master-bridge live are ON.");
    expect(alert.textContent).toContain("shared_live_trading_enabled = true");
    expect(alert.textContent).toContain("master_bridge_live_enabled = true");
  });

  it("says live via master bridge is off when the flags are off", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": {
        body: current({ masterLiveSettings: { ...settingsOn, sharedLiveTradingEnabled: false, masterBridgeLiveEnabled: false } }),
      },
    });
    const alert = screen.getByTestId("alert-master-live-settings");
    expect(alert.textContent).toContain("Live trading via master bridge is off.");
    expect(alert.textContent).toContain("shared_live_trading_enabled = false");
  });

  it("says the settings could not be read when the server could not read them or the load failed", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": {
        body: current({ masterLiveSettings: { ...settingsOn, readable: false, sharedLiveTradingEnabled: null, masterBridgeLiveEnabled: null } }),
      },
    });
    expect(screen.getByTestId("alert-master-live-settings").textContent).toContain("could not be read");
    cleanup();
    await renderPage({ "/api/admin/master-bridge/current": { reject: true } });
    const alert = screen.getByTestId("alert-master-live-settings");
    expect(alert.textContent).toContain("could not be read");
    expect(alert.textContent).not.toMatch(/is off|are ON/);
  });
});

describe("Master Bridge loads that fail say so instead of showing an empty state", () => {
  it("an ok:false unattributed list is 'could not be loaded', never 'All master fills are attributed.'", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": { body: current() },
      "/api/admin/shared-master/unattributed": { status: 500, body: { ok: false, error: "unattributed_list_failed" } },
    });
    expect(screen.queryByText("All master fills are attributed.")).toBeNull();
    const errs = screen.getAllByTestId("text-list-load-error").map((e) => e.textContent ?? "");
    expect(errs.some((t) => t.includes("Unattributed master trades could not be loaded") && t.includes("unattributed_list_failed"))).toBe(true);
    expect(screen.queryByText(/Unattributed master trades \(0\)/)).toBeNull();
  });

  it("a failed overview is not 'No master accounts configured.'", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": { body: current() },
      "/api/admin/shared-master/overview": { status: 500, body: { ok: false, error: "overview_failed" } },
      "/api/admin/shared-master/virtual-accounts": { reject: true },
    });
    expect(screen.queryByText("No master accounts configured.")).toBeNull();
    expect(screen.queryByText("No virtual accounts yet.")).toBeNull();
    const errs = screen.getAllByTestId("text-list-load-error").map((e) => e.textContent ?? "");
    expect(errs.some((t) => t.includes("Master accounts could not be loaded"))).toBe(true);
    expect(errs.some((t) => t.includes("Virtual accounts could not be loaded"))).toBe(true);
    // The lists that did load still show their real empty state.
    expect(screen.getByText("All master fills are attributed.")).toBeTruthy();
  });

  it("an ok:false detector response is not 'No bridge currently registered', and the env flag is not 'false'", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": { status: 500, body: { ok: false, error: "detector_failed" } },
      "/api/admin/master-bridge/gate": { reject: true },
    });
    expect(screen.queryByText("No bridge currently registered with the system.")).toBeNull();
    expect(screen.getByTestId("text-main-bridge-load-error").textContent).toContain("could not be loaded");
    expect(screen.getByTestId("text-main-bridge-gate-error").textContent).toContain("could not be loaded");
    const env = screen.getByTestId("kv-arx-live-broker-execution-enabled").textContent ?? "";
    expect(env).toContain("could not be read");
    expect(env).not.toContain("= false");
    expect(env).not.toContain("will refuse");
  });
});

describe("Master Bridge 'ready' is a bridge-binding verdict, not execution readiness", () => {
  const detected = {
    detected: true,
    primaryReason: undefined,
    bridge: {
      bridgeId: 41, brokerName: "Broker", accountNumberMasked: "••••1234", eaVersion: "1.50",
      heartbeatAgeSec: 2, accountType: "live", mode: "LIVE", readOnlyMode: false,
      enableLiveExecution: true, enableDemoExecution: false, terminalConnected: true,
      algoTradingAllowed: true, maxLiveLot: 0.1,
    },
    liveBrokerExecutionEnabled: true,
  };
  const pass = { body: { ok: true, verdict: { decision: "PASS", boundBridgeId: 41 } } };
  const exec = (over: Record<string, unknown> = {}) => ({
    readable: true, envEnabled: true, operatorArmed: true, effectiveEnabled: true,
    platformStopEngaged: false, platformStopSources: [], platformStopReason: null, ...over,
  });

  it("detector OK + gate PASS + env on but NOT armed: no green 'ready', no green env box", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": { body: current({ ...detected, liveExecution: exec({ operatorArmed: false, effectiveEnabled: false }) }) },
      "/api/admin/master-bridge/gate": pass,
    });
    const badge = screen.getByTestId("badge-main-bridge-binding");
    expect(badge.textContent).toContain("live dispatch blocked");
    expect(badge.textContent).not.toMatch(/^ready$/);
    const env = screen.getByTestId("kv-arx-live-broker-execution-enabled");
    expect(env.className).not.toContain("text-success");
    expect(env.textContent).toContain("not armed by an operator");
    expect(env.textContent).toContain("OFF");
    expect(screen.getByTestId("text-live-dispatch-blockers").textContent).toContain("not armed by an operator");
  });

  it("an engaged safety-core kill switch degrades the badge and is named", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": {
        body: current({ ...detected, liveExecution: exec({ platformStopEngaged: true, platformStopSources: ["safety_core_kill_switch"] }) }),
      },
      "/api/admin/master-bridge/gate": pass,
    });
    expect(screen.getByTestId("badge-main-bridge-binding").textContent).toContain("live dispatch blocked");
    expect(screen.getByTestId("text-live-dispatch-blockers").textContent).toContain("safety-core kill switch engaged");
  });

  it("an older response without the execution state never shows green", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": { body: current({ ...detected }) },
      "/api/admin/master-bridge/gate": pass,
    });
    expect(screen.getByTestId("badge-main-bridge-binding").textContent).toContain("live dispatch blocked");
    const env = screen.getByTestId("kv-arx-live-broker-execution-enabled");
    expect(env.className).not.toContain("text-success");
    expect(env.textContent).toContain("could not be read");
  });

  it("binding PASS with env on, armed and no stop: green 'bridge binding ready' (wording limited to binding)", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": { body: current({ ...detected, liveExecution: exec() }) },
      "/api/admin/master-bridge/gate": pass,
    });
    expect(screen.getByTestId("badge-main-bridge-binding").textContent).toBe("bridge binding ready");
    expect(screen.queryByTestId("text-live-dispatch-blockers")).toBeNull();
    expect(screen.getByTestId("kv-arx-live-broker-execution-enabled").textContent).toContain("effective switch (env AND arm) is ON");
  });
});

describe("A blocked detector's hint bridge is labelled as not the master bridge", () => {
  it("MOCK hint under a blocked detector is labelled non-qualifying", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": {
        body: current({
          detected: false,
          primaryReason: "MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED",
          latestHint: {
            bridgeId: 7, brokerName: "Broker", accountNumberMasked: "••••9999", eaVersion: "1.50",
            heartbeatAgeSec: 3, accountType: "demo", mode: "MOCK", readOnlyMode: null,
            enableLiveExecution: null, enableDemoExecution: null, terminalConnected: null,
            algoTradingAllowed: null, maxLiveLot: null,
          },
        }),
      },
    });
    const label = screen.getByTestId("text-bridge-hint-label");
    expect(label.textContent).toContain("Not the master bridge");
    expect(label.textContent).toContain("MASTER_BRIDGE_REAL_HEARTBEAT_REQUIRED");
    expect(screen.getByTestId("grid-bridge-hint").textContent).toContain("MOCK");
    expect(screen.queryByTestId("grid-bridge-selected")).toBeNull();
  });

  it("a detected bridge carries no hint label", async () => {
    await renderPage({
      "/api/admin/master-bridge/current": {
        body: current({
          detected: true,
          primaryReason: undefined,
          bridge: {
            bridgeId: 41, brokerName: "Broker", accountNumberMasked: "••••1234", eaVersion: "1.50",
            heartbeatAgeSec: 2, accountType: "live", mode: "LIVE", readOnlyMode: false,
            enableLiveExecution: true, enableDemoExecution: false, terminalConnected: true,
            algoTradingAllowed: true, maxLiveLot: 0.1,
          },
        }),
      },
    });
    expect(screen.queryByTestId("text-bridge-hint-label")).toBeNull();
    expect(screen.getByTestId("grid-bridge-selected")).toBeTruthy();
  });
});
