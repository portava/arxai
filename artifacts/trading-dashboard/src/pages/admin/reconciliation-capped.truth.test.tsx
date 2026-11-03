// Truth regression: reconciliation detectors cap their lists (50 rows, 25 per
// blocked queue). When a list was cut, the counts are "at least N", never the
// total — and "no issues for this bridge" is not a clean result, because the
// bridge's issue may sit past the cap.
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
const ORPHAN_CUT = { check: "orphan_broker", type: "ORPHAN_BROKER_POSITION", severity: "critical", limit: 50 };

function orphan(i: number) {
  return {
    id: `o${i}`, type: "ORPHAN_BROKER_POSITION", severity: "critical", userId: i, bridgeConnectionId: null,
    commandId: null, brokerTicket: String(i), symbol: "EURUSD", status: "OPEN_AT_BROKER",
    reason: "Open broker position has no matching arx_live_commands row.", recommendedAction: "Review.",
    createdAt: null, updatedAt: null, metadata: {},
  };
}

describe("Reconciliation Center — capped lists", () => {
  it("marks capped counts as 'at least' and names the cut lists", async () => {
    const issues = Array.from({ length: 50 }, (_, i) => orphan(i + 1));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      ok: true, issues, total: 75, computedAt: COMPUTED_AT,
      countsByType: { ORPHAN_BROKER_POSITION: 50, MISSING_ATTRIBUTION: 25 },
      countsBySeverity: { critical: 50, high: 25, medium: 0, low: 0 },
      complete: true, uncheckedTypes: [], failedChecks: [],
      truncated: true, truncatedChecks: [ORPHAN_CUT], truncatedTypes: ["ORPHAN_BROKER_POSITION"], truncatedSeverities: ["critical"],
    })));
    render(<AdminReconciliationCenter />); await settle();
    expect(screen.queryByText("total 75")).toBeNull();
    expect(screen.getByText(/at least 75/)).toBeTruthy();
    expect(screen.getByTestId("recon-sev-critical").textContent).toMatch(/50\+/);
    expect(screen.getByTestId("recon-sev-high").textContent).not.toMatch(/\+/);
    expect(screen.getByTestId("recon-type-ORPHAN_BROKER_POSITION").textContent).toMatch(/50\+/);
    expect(screen.getByTestId("recon-type-MISSING_ATTRIBUTION").textContent).not.toMatch(/\+/);
    expect(screen.getByTestId("recon-capped").textContent).toContain("ORPHAN_BROKER_POSITION");
  });
});

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
      issueCount: 0, criticalCount: 0, types: [], latest: null, computedAt: COMPUTED_AT,
      checksComplete: true, uncheckedTypes: [], ...recon,
    },
    selfUpdateSupported: false,
    update: { currentVersion: "1.0", latestApprovedVersion: null, updateAvailable: false, decision: "none", reason: null, manualBootstrapRequired: false },
    lastUpdateReport: null,
  };
}

describe("EA Health — capped lists", () => {
  it("does not call a bridge clean when a list was cut", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      ok: true, evaluatedAt: COMPUTED_AT, counts: { total: 1, fresh: 1, stale: 0, offline: 0 },
      rows: [healthRow({ truncatedTypes: ["STALE_HEARTBEAT"] })],
    })));
    render(<AdminEaHealthPage />); await settle();
    expect(screen.queryByTestId("recon-clean-9")).toBeNull();
    expect(screen.getByTestId("recon-unchecked-9").textContent).toMatch(/STALE_HEARTBEAT.*cap/i);
  });

  it("shows 'at least N open' when a list was cut", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      ok: true, evaluatedAt: COMPUTED_AT, counts: { total: 1, fresh: 1, stale: 0, offline: 0 },
      rows: [healthRow({ issueCount: 2, types: ["STALE_HEARTBEAT"], truncatedTypes: ["STALE_HEARTBEAT"] })],
    })));
    render(<AdminEaHealthPage />); await settle();
    expect(screen.getByTestId("recon-issues-9").textContent).toMatch(/at least 2 open/);
  });
});

function bridgeFetch(body: unknown) {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith("/api/admin/ea/reconciliation-issues")) return response(body);
    if (url.endsWith("/api/admin/bridge/connections")) return response({ ok: true, connections: [] });
    if (url.endsWith("/api/admin/bridge/watchdog")) return response({ ok: true, verdicts: [] });
    if (url.endsWith("/api/admin/ea/retcodes")) return response({ ok: true, retcodes: [] });
    if (url.endsWith("/api/admin/ea/symbol-capabilities")) return response({ ok: true, symbols: [] });
    return response({ ok: false }, 404);
  });
}

describe("Bridge Diagnostics — capped lists", () => {
  it("says the orphan list shows only the first rows", async () => {
    vi.stubGlobal("fetch", bridgeFetch({
      ok: true, issues: Array.from({ length: 50 }, (_, i) => orphan(i + 1)), total: 50, computedAt: COMPUTED_AT,
      complete: true, uncheckedTypes: [], failedChecks: [],
      truncated: true, truncatedChecks: [ORPHAN_CUT], truncatedTypes: ["ORPHAN_BROKER_POSITION"], truncatedSeverities: ["critical"],
    }));
    render(<BridgeDiagnosticsPage />); await settle();
    expect(screen.getByTestId("orphans-capped").textContent).toMatch(/first 50.*more/i);
  });
});

describe("Operator Command Center — capped lists", () => {
  it("marks capped totals as lower bounds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      ok: true, generatedAt: COMPUTED_AT, tookMs: 1,
      systemStatus: { appOnline: true, apiOk: true, databaseOk: true, cacheMode: "x", activeUserCount: 0, currentAppMode: "PAPER", latestQaStatus: "x" },
      bridgeStatus: null,
      tradingMode: { modeLabel: "PAPER", platformMasterBridgeConnectionId: null, sharedLiveTradingEnabled: false, masterLiveUserApprovalRequired: true, liveBrokerExecutionEnabled: false },
      safetyControls: { platformMode: "PAPER", killSwitchEngaged: false, killSwitchReason: null, liveBrokerExecutionEnabled: false, paperOnlyHardLockActive: true, sharedLiveTradingEnabled: false, oneClickPolicy: "off", stopLossRequiredDefault: true, maxLotDefault: 0.01, queueDepth: 0, openLiveCommandsNonTerminal: 0 },
      userApprovals: { total: 0, approvedForMasterLive: 0, pendingReview: 0, disabled: 0, suspended: 0, riskLocked: 0, notApproved: 0, withDisclosureAccepted: 0, sample: [] },
      liveTestReadiness: { currentLiveBridgeDetected: false, currentLiveBridgePrimaryReason: null, operatorDisclosureAccepted: false, operatorArmed: false, operatorKillSwitchEngaged: false, preflightOnly: true, autoFireDisabled: true, preflightEndpoint: "/x" },
      reconciliationSummary: {
        total: 75, critical: 50, high: 25, medium: 0, low: 0, byType: {}, complete: true, uncheckedTypes: [],
        truncated: true, truncatedTypes: ["ORPHAN_BROKER_POSITION"], truncatedSeverities: ["critical"],
      },
    })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><OperatorCommandCenter /></QueryClientProvider>); await settle();
    const panel = await screen.findByTestId("panel-reconciliation");
    expect(panel.textContent).toContain("Total: 75+");
    expect(panel.textContent).toContain("Critical: 50+");
    expect(panel.textContent).toContain("High: 25");
    expect(panel.textContent).not.toContain("High: 25+");
    expect(panel.textContent).toMatch(/ORPHAN_BROKER_POSITION/);
  });
});
