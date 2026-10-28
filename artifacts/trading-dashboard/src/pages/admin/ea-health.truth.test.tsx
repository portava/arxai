// EA Health truth regressions.
//
// "Command-poll age" was the age of the user's latest command pick (per user,
// any bridge), not how recently the EA polled: a healthy EA polling every
// second read "Command-poll age 259200s". It now reads "Last command picked"
// and says it is not a poll time.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: ReactNode }) => <>{children}</>,
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
