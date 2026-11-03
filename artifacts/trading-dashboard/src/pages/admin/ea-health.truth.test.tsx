// EA Health truth regressions.
//
// "Command-poll age" was the age of the user's latest command pick (per user,
// any bridge), not how recently the EA polled: a healthy EA polling every
// second read "Command-poll age 259200s". It now reads "Last command picked"
// and says it is not a poll time.
//
// Nothing reported is not "no": with no EA version, "Update available" is
// unknown; with no capabilities report, features and self-update read "not
// reported", never "unsupported" / "no".
//
// A heartbeat dated after the server's evaluation time has no verifiable age:
// it reads "unknown — dated in the future", never "0s" (older servers clamped
// it to 0).
//
// EA-reported flags (terminal, AlgoTrading, EnableLiveExecution, ReadOnlyMode,
// clock drift) are current only while the bridge is fresh and the report is
// recent; otherwise they read "last reported", with the report time.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    isLoading: false,
    envelope: {},
    shouldShowAdminDiagnostics: true,
    isAdminPreviewingUserMode: false,
  }),
}));

import AdminEaHealthPage from "./ea-health";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const NOW = "2026-10-28T11:00:00.000Z";

function healthRow(over: Record<string, unknown> = {}) {
  return {
    connection: {
      id: 9, userId: 4, connectionName: "Main bridge", status: "ACTIVE", accountType: "live",
      broker: "B", server: "S", eaVersion: "1.27", tokenLast4: "abcd",
      lastHeartbeatAt: NOW, heartbeatAgeSeconds: 1,
    },
    liveness: "fresh", conditions: [], heartbeatAgeSeconds: 1, accountType: "live", eaVersion: "1.27",
    capabilitiesReportedAt: NOW, featureSupport: { supportsSelfUpdate: "SUPPORTED" },
    eaInputs: { readOnlyMode: false, enableLiveExecution: true, terminalConnected: true, algoTradingAllowed: true },
    allowOrderExecution: true, liveLocked: false,
    clockDrift: { seconds: null, severity: null },
    lastCommand: null, commandPollAgeSeconds: null,
    lastReconciliationResult: {
      issueCount: 0, criticalCount: 0, types: [], latest: null, computedAt: NOW,
      checksComplete: true, uncheckedTypes: [], truncatedTypes: [],
    },
    selfUpdateSupported: true,
    update: { currentVersion: "1.27", latestApprovedVersion: "1.27", updateAvailable: false, decision: "NO_UPDATE", reason: null, manualBootstrapRequired: false },
    lastUpdateReport: null,
    ...over,
  };
}

function stub(rows: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => response({
    ok: true, evaluatedAt: NOW, counts: { total: rows.length, fresh: rows.length, stale: 0, offline: 0 }, rows,
  })));
}

const pickedCommand = (over: Record<string, unknown> = {}) => ({
  commandId: "c1", commandType: "PLACE_LIVE_MARKET_ORDER", status: "LIVE_FILLED", symbol: "EURUSD", side: "BUY",
  mt5Retcode: 10009, rejectionReason: null, pickedByEaAt: "2026-10-25T11:00:00.000Z",
  resultRecordedAt: null, createdAt: "2026-10-25T10:59:55.000Z", ...over,
});

describe("EA Health last command pick", () => {
  it("labels the latest command's pick age as such, not as a command-poll age", async () => {
    stub([healthRow({ lastCommand: pickedCommand({ bridgeConnectionId: null }), lastCommandPickedAgeSeconds: 259200, commandPollAgeSeconds: 259200 })]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.queryByText(/Command-poll age/)).toBeNull();
    const cell = screen.getByTestId("ea-last-command-picked-9");
    expect(cell.textContent).toMatch(/Last command picked/);
    expect(cell.textContent).toMatch(/259200s ago/);
    expect(screen.getByText(/any of their bridges/)).toBeTruthy();
    expect(screen.getByText(/Not an EA poll time/)).toBeTruthy();
  });

  it("names the bridge a command was bound to when it is another bridge of the same user", async () => {
    stub([healthRow({ lastCommand: pickedCommand({ bridgeConnectionId: 12 }), lastCommandPickedAgeSeconds: 30 })]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByText(/bound to bridge #12/)).toBeTruthy();
  });

  it("a pending latest command reads 'not picked yet', no commands reads 'no commands'", async () => {
    stub([
      healthRow({ lastCommand: pickedCommand({ pickedByEaAt: null }), lastCommandPickedAgeSeconds: null }),
      healthRow({ connection: { ...healthRow().connection, id: 10 } }),
    ]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByTestId("ea-last-command-picked-9").textContent).toMatch(/not picked yet/);
    expect(screen.getByTestId("ea-last-command-picked-10").textContent).toMatch(/no commands/);
  });
});

describe("EA Health with nothing reported", () => {
  it("no EA version: update availability reads unknown, not 'no'", async () => {
    stub([healthRow({
      eaVersion: null,
      update: { currentVersion: null, latestApprovedVersion: "1.30", updateAvailable: null, updateAvailableBasis: "EA_VERSION_NOT_REPORTED", decision: "BLOCKED", reason: null, manualBootstrapRequired: false },
    })]);
    render(<AdminEaHealthPage />);
    await settle();
    const cell = screen.getByTestId("ea-update-available-9");
    expect(cell.textContent).toMatch(/unknown — EA version not reported/);
    expect(cell.textContent).not.toMatch(/\bno\b/);
  });

  it("an older server's updateAvailable:false with no EA version still reads unknown", async () => {
    stub([healthRow({
      eaVersion: null,
      update: { currentVersion: null, latestApprovedVersion: "1.30", updateAvailable: false, decision: "BLOCKED", reason: null, manualBootstrapRequired: false },
    })]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByTestId("ea-update-available-9").textContent).toMatch(/unknown/);
  });

  it("no approved build reads 'no — no approved build'", async () => {
    stub([healthRow({
      update: { currentVersion: "1.27", latestApprovedVersion: null, updateAvailable: false, updateAvailableBasis: "NO_APPROVED_MANIFEST", decision: "NO_UPDATE", reason: null, manualBootstrapRequired: false },
    })]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByTestId("ea-update-available-9").textContent).toMatch(/no — no approved build/);
  });

  it("capabilities never reported: features and self-update read 'not reported', not 'unsupported' / 'no'", async () => {
    stub([healthRow({
      featureSupport: { supportsSelfUpdate: "UNSUPPORTED_ADMIN_WARNING", supportsWatchdog: "UNSUPPORTED_ADMIN_WARNING" },
      capabilitiesReported: false,
      featuresNotReported: ["supportsSelfUpdate", "supportsWatchdog"],
      selfUpdateSupported: false,
      selfUpdateReported: false,
    })]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByTestId("ea-caps-not-reported-9")).toBeTruthy();
    for (const k of ["supportsSelfUpdate", "supportsWatchdog"]) {
      const cell = screen.getByTestId(`ea-cap-9-${k}`);
      expect(cell.textContent).toMatch(/not reported/);
      expect(cell.textContent).not.toMatch(/unsupported/);
    }
    expect(screen.getByTestId("ea-self-update-9").textContent).toMatch(/not reported/);
  });

  it("a reported unsupported feature still reads unsupported", async () => {
    stub([healthRow({
      featureSupport: { supportsSelfUpdate: "UNSUPPORTED_ADMIN_WARNING" },
      capabilitiesReported: true, featuresNotReported: [], selfUpdateSupported: false, selfUpdateReported: true,
    })]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByTestId("ea-cap-9-supportsSelfUpdate").textContent).toMatch(/unsupported/);
  });
});

describe("EA Health heartbeat dated in the future", () => {
  const future = "2026-10-28T11:00:30.000Z"; // 30 s after evaluatedAt (NOW)
  it("a newer server's null age reads unknown, not a dash or 0s", async () => {
    stub([healthRow({
      liveness: "offline", heartbeatAgeSeconds: null,
      connection: { ...healthRow().connection, lastHeartbeatAt: future, heartbeatAgeSeconds: null },
    })]);
    render(<AdminEaHealthPage />);
    await settle();
    const cell = screen.getByTestId("ea-heartbeat-age-9");
    expect(cell.textContent).toMatch(/unknown — dated in the future/);
    expect(cell.textContent).not.toMatch(/\b0s\b/);
  });

  it("an older server's clamped 0s is downgraded to unknown", async () => {
    stub([healthRow({
      liveness: "offline", heartbeatAgeSeconds: 0,
      connection: { ...healthRow().connection, lastHeartbeatAt: future, heartbeatAgeSeconds: 0 },
    })]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByTestId("ea-heartbeat-age-9").textContent).toMatch(/unknown — dated in the future/);
  });

  it("a past heartbeat still shows its age", async () => {
    stub([healthRow()]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByTestId("ea-heartbeat-age-9").textContent).toMatch(/1s/);
  });

  it("a future-dated pick time reads 'picked, age unknown', not 'not picked yet'", async () => {
    stub([healthRow({ lastCommand: pickedCommand({ pickedByEaAt: future }), lastCommandPickedAgeSeconds: null })]);
    render(<AdminEaHealthPage />);
    await settle();
    expect(screen.getByTestId("ea-last-command-picked-9").textContent).toMatch(/picked, age unknown/);
  });
});

// ── EA-reported flags carry their report time ──────────────────────────────

type Json = Record<string, unknown>;
const NOW_MS = Date.now();
const iso = (msAgo: number) => new Date(NOW_MS - msAgo).toISOString();

function reportRow(over: Json = {}): Json {
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

describe("EA health — EA-reported flags carry their report time", () => {
  it("a fresh bridge shows its EA-reported flags as current, with the report time", async () => {
    await renderWith([reportRow()]);
    expect(screen.getByTestId("ea-terminal-11").textContent).toBe("yes");
    expect(screen.getByTestId("ea-algo-11").textContent).toBe("yes");
    expect(screen.getByTestId("ea-inputs-asof-11").textContent).toContain(new Date(iso(2_000)).toLocaleString());
  });

  it("an OFFLINE bridge's last-known flags are labelled last reported, with the time — not a plain green yes", async () => {
    const reportedAt = iso(3 * 3600_000);
    await renderWith([reportRow({
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
    await renderWith([reportRow({ capabilitiesReportedAt: reportedAt })]);
    expect(screen.getByTestId("ea-terminal-11").textContent).toMatch(/last reported yes/);
  });

  it("no report time at all: flags say the time is unknown", async () => {
    await renderWith([reportRow({ liveness: "stale", capabilitiesReportedAt: null })]);
    expect(screen.getByTestId("ea-terminal-11").textContent).toMatch(/last reported yes · time unknown/);
  });
});
