// Truth: a Bridge v2 card described one heartbeat age with two contradicting
// words — a "STALE" badge beside the lock text "Bridge offline". The headline
// badge now speaks the shared heartbeat vocabulary the lock text uses, and the
// v2 stream band is a separately labelled row with its range.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import AdminBridgeV2MonitorPage from "./bridge-v2-monitor";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function bridge(over: Record<string, unknown>) {
  return {
    userId: 5, bridgeConnectionId: 9, connected: false, freshness: "STALE",
    heartbeatFreshness: "offline", streamHealth: "STALE", streamImpliesExecutionReady: false,
    lastHeartbeatAt: "2026-10-28T11:58:30.000Z", heartbeatAgeSeconds: 90,
    eaVersion: "2.0", accountType: "demo", terminalConnected: true, algoTradingAllowed: true,
    readOnlyMode: false, enableLiveExecution: false, configVersion: 1, lastAckedConfigVersion: 1,
    executionAllowedServed: false, lastAccountSnapshotAt: null, lastPositionsSnapshotAt: null,
    lastQuoteAt: null, lastCandleAt: null, lastTradeTransactionAt: null, accountBalance: null,
    accountEquity: null, accountCurrency: null, openPositionsCount: null, lastSequence: 10,
    totalAccepted: 10, totalDuplicates: 0, totalGaps: 0, totalMissed: 0, totalRejected: 0, totalResets: 0,
    pendingCommandCount: 0, safetyLockReason: "Bridge offline — last heartbeat 90s ago (offline from 60 s)",
    ...over,
  };
}

function stub(b: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const body = u.includes("/status") ? { ok: true, count: 1, bridges: [b] }
      : u.includes("/streams") ? { ok: true, count: 0, streams: [] }
      : { ok: true, summary: { total: 0, accepted: 0, duplicates: 0, gaps: 0, rejected: 0 }, events: [] };
    return { ok: true, json: async () => body } as Response;
  }));
}

describe("Bridge v2 monitor heartbeat wording", () => {
  it("90 s heartbeat: the badge says offline like the lock text, never 'STALE' as the headline", async () => {
    stub(bridge({}));
    render(<AdminBridgeV2MonitorPage />);
    const badge = await screen.findByTestId("bridge-v2-heartbeat-5");
    expect(badge.textContent).toBe("Heartbeat offline");
    expect(screen.getByTestId("bridge-v2-lock-5").textContent).toContain("Bridge offline");
    expect(screen.queryByText("STALE")).toBeNull();
    expect(screen.getByTestId("bridge-v2-stream-band-5").textContent).toBe("STALE (15–120 s)");
  });

  it("an older server without heartbeatFreshness is classified from the age it sent", async () => {
    stub(bridge({ heartbeatFreshness: undefined, heartbeatAgeSeconds: 30, safetyLockReason: null }));
    render(<AdminBridgeV2MonitorPage />);
    await waitFor(() => expect(screen.getByTestId("bridge-v2-heartbeat-5").textContent).toBe("Heartbeat delayed"));
  });
});
