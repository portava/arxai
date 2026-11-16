// /admin/live-test-readiness send summary: a gate that was not checked keeps
// the send button disabled, so the summary must count it, never read
// "0 gate(s) not passing" while sending is blocked.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { State } from "./live-test-readiness";

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { id: 1, role: "OWNER" } }),
}));
vi.mock("@/components/readiness/FeedCompletenessDebugPanel", () => ({
  FeedCompletenessDebugPanel: () => null,
}));

const { default: FinalLiveTestPage } = await import("./live-test-readiness");

function state(c: Partial<State["panelC_operatorAccess"]>): State {
  return {
    ok: true,
    panelA_currentConnectedBridge: {
      bridgeConnectionId: 1, bridgeKind: "REAL_LIVE", accountType: "live", accountNumber: "1",
      brokerName: null, serverName: null, eaVersion: null, lastHeartbeatAt: null,
      heartbeatAgeSeconds: 2, readOnlyMode: false, enableLiveExecution: true,
      terminalConnected: true, algoTradingAllowed: true, maxLiveLot: 0.01,
    },
    panelB_masterLiveGates: {
      masterSwitchEnabled: true, platformMode: "LIVE", liveEnabled: true,
      sharedLiveTradingEnabled: true, masterBridgeLiveEnabled: true,
      accountRoutingMode: "SHARED_MASTER_MT5", emergencyKillSwitch: false,
      killSwitchEngagedAt: null, killSwitchReason: null, queueDepth: 0, currentOpenExposureLots: 0,
    },
    panelC_operatorAccess: {
      adminUserId: 1, adminEmail: null, role: "OWNER", approvedForMasterLive: true,
      masterLiveTradingEnabled: true, masterLiveStatus: "APPROVED",
      riskDisclosureAcceptedAt: "2026-10-01T00:00:00Z", riskSettingsConfiguredAt: null,
      maxLot: 0.01, maxOpenPositions: 1, maxExposurePerSymbolLots: null,
      requireStopLoss: true, scannerLiveEnabled: false, allowedSymbols: ["EURUSD"],
      userArmed: true, userKillSwitchEngaged: false,
      ...c,
    },
    panelD_controlledTestPreview: {
      symbol: "EURUSD", side: "BUY", volume: 0.01, orderType: "MARKET",
      stopLossRequired: true, takeProfitOptional: true, source: "X",
      bridgeConnectionId: 1, accountNumber: "1", warning: "", requiredConfirmationPhrase: "",
    },
  };
}

async function renderPage(s: State) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => s, text: async () => "",
  }) as unknown as Response));
  render(<FinalLiveTestPage />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("live-test readiness send summary", () => {
  it("counts a not-checked gate instead of reading 0 not passing", async () => {
    // requireTakeProfit not sent: every other gate passes.
    await renderPage(state({}));
    const summary = await screen.findByTestId("gates-not-passing");
    expect(summary.textContent).toMatch(/1 gate\(s\) not passing/);
    expect(summary.textContent).toMatch(/1 not checked/);
    expect(summary.textContent).not.toMatch(/\b0 gate\(s\)/);
  });

  it("counts failing and not-checked gates together", async () => {
    await renderPage(state({ requireStopLoss: false }));
    const summary = await screen.findByTestId("gates-not-passing");
    expect(summary.textContent).toMatch(/2 gate\(s\) not passing/);
    expect(summary.textContent).toMatch(/1 not checked/);
  });
});
