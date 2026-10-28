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
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    await waitFor(() => expect(screen.getByTestId("banner-readiness-unavailable")).toBeTruthy());
    expect(screen.getByTestId("banner-readiness-unavailable").textContent).toMatch(/a server query failed/);
    expect(screen.queryByTestId("banner-kill-switch")).toBeNull();
    expect(screen.queryByTestId("mode-chip-kill")).toBeNull();
    expect(screen.getByTestId("mode-chip-unavailable")).toBeTruthy();
    expect(screen.queryByText("Approved users")).toBeNull();
    expect(screen.queryByText(/Kill switch engaged/)).toBeNull();
    expect(screen.queryByText("Activation checklist")).toBeNull();
    expect(screen.getByTestId("readiness-unavailable")).toBeTruthy();
  });

  it("a failed request shows 'could not be loaded' instead of loading forever", async () => {
    stubApi({ "/api/admin/live-shared/readiness": () => response({ ok: false, error: "INTERNAL_ERROR" }, 500) });
    render(<AdminLiveSharedActivationPage />);
    await settle();
    await waitFor(() => expect(screen.getByTestId("banner-readiness-unavailable")).toBeTruthy());
    expect(screen.getByTestId("banner-readiness-unavailable").textContent).toMatch(/INTERNAL_ERROR/);
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
    await waitFor(() => expect(screen.getByTestId("banner-readiness-unavailable")).toBeTruthy());
    expect(screen.queryByText("Approved users")).toBeNull();
  });
});
