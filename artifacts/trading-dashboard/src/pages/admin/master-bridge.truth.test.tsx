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
