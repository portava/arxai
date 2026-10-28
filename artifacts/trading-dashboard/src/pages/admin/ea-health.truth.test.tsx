import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    isLoading: false,
    envelope: {},
    shouldShowAdminDiagnostics: true,
    isAdminPreviewingUserMode: false,
  }),
}));

import AdminEaHealthPage from "./ea-health";

type Json = Record<string, unknown>;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function healthRow(over: Json = {}): Json {
  return {
    connection: {
      id: 11, userId: 3, connectionName: "Master VPS", status: "connected", accountType: "live",
      broker: "Broker", server: "Broker-Live", eaVersion: "1.27", tokenLast4: "abcd",
      lastHeartbeatAt: iso(2_000), heartbeatAgeSeconds: 2,
    },
    liveness: "fresh",
    conditions: [],
    heartbeatAgeSeconds: 2,
    accountType: "live",
    eaVersion: "1.27",
    capabilitiesReportedAt: iso(2_000),
    featureSupport: { supportsSelfUpdate: "SUPPORTED" },
    eaInputs: { readOnlyMode: false, enableLiveExecution: true, terminalConnected: true, algoTradingAllowed: true },
    allowOrderExecution: true,
    liveLocked: false,
    clockDrift: { seconds: 0.4, severity: "OK" },
    lastCommand: null,
    commandPollAgeSeconds: null,
    lastReconciliationResult: { issueCount: 0, criticalCount: 0, types: [], latest: null, computedAt: iso(0) },
    selfUpdateSupported: true,
    update: { currentVersion: "1.27", latestApprovedVersion: "1.27", updateAvailable: false, decision: "NO_UPDATE", reason: null, manualBootstrapRequired: false },
    lastUpdateReport: null,
    ...over,
  };
}

async function renderWith(rows: Json[]) {
  const body = { ok: true, evaluatedAt: iso(0), counts: { total: rows.length, fresh: 0, stale: 0, offline: 0 }, rows };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response));
  render(<AdminEaHealthPage />);
  await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("EA health — EA-reported flags carry their report time", () => {
  it("a fresh bridge shows its EA-reported flags as current, with the report time", async () => {
    await renderWith([healthRow()]);
    expect(screen.getByTestId("ea-terminal-11").textContent).toBe("yes");
    expect(screen.getByTestId("ea-algo-11").textContent).toBe("yes");
    expect(screen.getByTestId("ea-inputs-asof-11").textContent).toContain(new Date(iso(2_000)).toLocaleString());
  });

  it("an OFFLINE bridge's last-known flags are labelled last reported, with the time — not a plain green yes", async () => {
    const reportedAt = iso(3 * 3600_000);
    await renderWith([healthRow({
      liveness: "offline", heartbeatAgeSeconds: 3 * 3600,
      capabilitiesReportedAt: reportedAt,
      clockDrift: { seconds: 1.2, severity: "OK" },
    })]);
    const when = new Date(reportedAt).toLocaleString();
    for (const id of ["ea-terminal-11", "ea-algo-11", "ea-live-11", "ea-readonly-11"]) {
      const el = screen.getByTestId(id);
      expect(el.textContent, id).not.toBe("yes");
      expect(el.textContent, id).not.toBe("no");
      expect(el.textContent, id).toMatch(/last reported (yes|no)/);
      expect(el.textContent, id).toContain(when);
      expect(el.className, id).not.toContain("text-success");
    }
    expect(screen.getByTestId("ea-inputs-asof-11").textContent).toMatch(/not current/);
    expect(screen.getByTestId("ea-clock-drift-11").textContent).toMatch(/last reported/);
  });

  it("a fresh heartbeat with an old capability report is still not current", async () => {
    const reportedAt = iso(10 * 60_000);
    await renderWith([healthRow({ capabilitiesReportedAt: reportedAt })]);
    expect(screen.getByTestId("ea-terminal-11").textContent).toMatch(/last reported yes/);
  });

  it("no report time at all: flags say the time is unknown", async () => {
    await renderWith([healthRow({ liveness: "stale", capabilitiesReportedAt: null })]);
    expect(screen.getByTestId("ea-terminal-11").textContent).toMatch(/last reported yes · time unknown/);
  });
});
