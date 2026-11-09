// Truth regression: a reconciliation detector that could not run, or a
// reconciliation feed that could not be loaded, must never read as "no issues".
// EA Health, Bridge Diagnostics, the Reconciliation Center and the Operator
// Command Center all show what was not checked instead of a clean state.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import AdminEaHealthPage from "./ea-health";
import BridgeDiagnosticsPage from "./bridge-diagnostics";
import AdminReconciliationCenter from "./reconciliation-center";
import OperatorCommandCenter from "./operator-command-center";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const COMPUTED_AT = "2026-10-28T11:00:00.000Z";
const FAILED = {
  check: "orphan_broker", type: "ORPHAN_BROKER_POSITION", severity: "critical",
  error: "connect ECONNREFUSED 127.0.0.1:5432",
};

function healthRow(recon: Record<string, unknown>) {
  return {
    connection: {
      id: 9, userId: 4, connectionName: "Main bridge", status: "ACTIVE", accountType: "demo",
      broker: "B", server: "S", eaVersion: "1.0", tokenLast4: "abcd",
      lastHeartbeatAt: COMPUTED_AT, heartbeatAgeSeconds: 5,
    },
    liveness: "fresh", conditions: [], heartbeatAgeSeconds: 5, accountType: "demo", eaVersion: "1.0",
    capabilitiesReportedAt: null, featureSupport: {},
    eaInputs: { readOnlyMode: null, enableLiveExecution: null, terminalConnected: null, algoTradingAllowed: null },
    allowOrderExecution: false, liveLocked: true,
    clockDrift: { seconds: null, severity: null }, lastCommand: null, commandPollAgeSeconds: null,
    lastReconciliationResult: {
      issueCount: 0, criticalCount: 0, types: [], latest: null, computedAt: COMPUTED_AT, ...recon,
    },
    selfUpdateSupported: false,
    update: { currentVersion: "1.0", latestApprovedVersion: null, updateAvailable: false, decision: "none", reason: null, manualBootstrapRequired: false },
    lastUpdateReport: null,
  };
}
function eaHealth(recon: Record<string, unknown>) {
  return { ok: true, evaluatedAt: COMPUTED_AT, counts: { total: 1, fresh: 1, stale: 0, offline: 0 }, rows: [healthRow(recon)] };
}

describe("EA Health — last reconciliation result", () => {
  it("does not show the green 'no open issues' state when checks failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(eaHealth({
      checksComplete: false, uncheckedTypes: ["ORPHAN_BROKER_POSITION"],
    }))));
    render(<AdminEaHealthPage />); await settle();
    expect(screen.queryByTestId("recon-clean-9")).toBeNull();
    expect(screen.queryByText(/No open reconciliation issues for this bridge/)).toBeNull();
    const box = screen.getByTestId("recon-unchecked-9");
    expect(box.textContent).toMatch(/could not be fully checked/i);
    expect(box.textContent).toContain("ORPHAN_BROKER_POSITION");
  });

  it("still shows the clean state when every check ran", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(eaHealth({ checksComplete: true, uncheckedTypes: [] }))));
    render(<AdminEaHealthPage />); await settle();
    expect(screen.getByTestId("recon-clean-9").textContent).toMatch(/No open reconciliation issues for this bridge/);
  });
});

function bridgeFetch(recon: { body: unknown; status?: number }) {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/api/admin/ea/reconciliation-issues")) return response(recon.body, recon.status ?? 200);
    if (url.endsWith("/api/admin/bridge/connections")) return response({ ok: true, connections: [] });
    if (url.endsWith("/api/admin/bridge/watchdog")) return response({ ok: true, verdicts: [] });
    if (url.endsWith("/api/admin/ea/retcodes")) return response({ ok: true, retcodes: [] });
    if (url.endsWith("/api/admin/ea/symbol-capabilities")) return response({ ok: true, symbols: [] });
    return response({ ok: false }, 404);
  });
}

describe("Bridge Diagnostics — reconciliation & command health", () => {
  it("says orphan positions could not be checked when that detector failed", async () => {
    vi.stubGlobal("fetch", bridgeFetch({ body: {
      ok: true, issues: [], total: 0, computedAt: COMPUTED_AT,
      complete: false, uncheckedTypes: ["ORPHAN_BROKER_POSITION"], failedChecks: [FAILED],
    } }));
    render(<BridgeDiagnosticsPage />); await settle();
    expect(screen.queryByTestId("orphans-none")).toBeNull();
    expect(screen.getByTestId("orphans-unchecked").textContent).toMatch(/could not be checked/i);
    // The stale-command detectors ran, so their empty state is honest.
    expect(screen.getByTestId("stale-none")).toBeTruthy();
  });

  it("says the feed could not be loaded when the request failed", async () => {
    vi.stubGlobal("fetch", bridgeFetch({ body: { ok: false, error: "reconciliation_failed" }, status: 500 }));
    render(<BridgeDiagnosticsPage />); await settle();
    expect(screen.queryByTestId("orphans-none")).toBeNull();
    expect(screen.queryByTestId("stale-none")).toBeNull();
    expect(screen.getByTestId("recon-load-failed").textContent).toMatch(/could not be loaded/i);
  });
});

describe("Reconciliation Center", () => {
  it("does not read a failed load as 'total 0 / no open issues'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ok: false, error: "reconciliation_failed", reason: "boom" }, 500)));
    render(<AdminReconciliationCenter />); await settle();
    expect(screen.queryByText(/No open reconciliation issues/)).toBeNull();
    expect(screen.queryByText("total 0")).toBeNull();
    expect(screen.getByText(/could not be loaded/i)).toBeTruthy();
  });

  it("names the unchecked types and does not claim 'no open issues'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      ok: true, issues: [], total: 0, computedAt: COMPUTED_AT,
      countsByType: { ORPHAN_BROKER_POSITION: 0, MISSING_ATTRIBUTION: 0 },
      countsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      complete: false, uncheckedTypes: ["ORPHAN_BROKER_POSITION"], failedChecks: [FAILED],
    })));
    render(<AdminReconciliationCenter />); await settle();
    expect(screen.queryByText(/^No open reconciliation issues\.$/)).toBeNull();
    expect(screen.getByTestId("recon-unchecked").textContent).toContain("ORPHAN_BROKER_POSITION");
    // The per-type row for an unchecked type is "not checked", never 0.
    expect(screen.getByTestId("recon-type-ORPHAN_BROKER_POSITION").textContent).toMatch(/not checked/i);
    expect(screen.getByTestId("recon-type-MISSING_ATTRIBUTION").textContent).toMatch(/0/);
  });
});

describe("Operator Command Center — reconciliation summary", () => {
  it("discloses unchecked types instead of a bare zero total", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      ok: true, generatedAt: COMPUTED_AT, tookMs: 1,
      systemStatus: { appOnline: true, apiOk: true, databaseOk: false, cacheMode: "x", activeUserCount: 0, currentAppMode: "PAPER", latestQaStatus: "x" },
      bridgeStatus: null,
      tradingMode: { modeLabel: "PAPER", platformMasterBridgeConnectionId: null, sharedLiveTradingEnabled: false, masterLiveUserApprovalRequired: true, liveBrokerExecutionEnabled: false },
      safetyControls: { platformMode: "PAPER", killSwitchEngaged: false, killSwitchReason: null, liveBrokerExecutionEnabled: false, paperOnlyHardLockActive: true, sharedLiveTradingEnabled: false, oneClickPolicy: "off", stopLossRequiredDefault: true, maxLotDefault: 0.01, queueDepth: 0, openLiveCommandsNonTerminal: 0 },
      userApprovals: { total: 0, approvedForMasterLive: 0, pendingReview: 0, disabled: 0, suspended: 0, riskLocked: 0, notApproved: 0, withDisclosureAccepted: 0, sample: [] },
      liveTestReadiness: { currentLiveBridgeDetected: false, currentLiveBridgePrimaryReason: null, operatorDisclosureAccepted: false, operatorArmed: false, operatorKillSwitchEngaged: false, preflightOnly: true, autoFireDisabled: true, preflightEndpoint: "/x" },
      reconciliationSummary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, byType: {}, complete: false, uncheckedTypes: ["COMMAND_RESULT_MISMATCH"] },
    })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><OperatorCommandCenter /></QueryClientProvider>); await settle();
    const panel = await screen.findByTestId("panel-reconciliation");
    expect(panel.textContent).toMatch(/could not be fully checked/i);
    expect(panel.textContent).toContain("COMMAND_RESULT_MISMATCH");
  });
});
