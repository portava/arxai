// /admin/live-test-readiness gate checklist: a setting the server did not
// report (no operator access row, or a field the server never sends) is shown
// as not checked (pass = null), never as a green PASS.
import { describe, expect, it } from "vitest";
import { buildGateChecklist, type State } from "./live-test-readiness";

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

const row = (s: State, label: string) => buildGateChecklist(s, null).find((g) => g.label === label);

describe("live-test readiness gate checklist", () => {
  it("take-profit requirement the server did not send is not a PASS", () => {
    const r = row(state({}), "Take profit required");
    expect(r?.pass).toBeNull();
    expect(r?.unknown).toMatch(/could not be read/);
  });

  it("stop-loss requirement reported as null (no access row) is not a PASS", () => {
    const s = state({ requireStopLoss: null, requireTakeProfit: null, operatorAccessRowFound: false });
    expect(row(s, "Stop loss required")?.pass).toBeNull();
    expect(row(s, "Take profit required")?.pass).toBeNull();
    // An unread setting keeps the whole checklist from reading "all gates pass".
    expect(buildGateChecklist(s, null).every((g) => g.pass === true)).toBe(false);
  });

  it("stored settings are shown as stored", () => {
    const on = state({ requireStopLoss: true, requireTakeProfit: true });
    expect(row(on, "Stop loss required")?.pass).toBe(true);
    expect(row(on, "Take profit required")?.pass).toBe(true);
    const off = state({ requireStopLoss: false, requireTakeProfit: false });
    expect(row(off, "Stop loss required")?.pass).toBe(false);
    expect(row(off, "Take profit required")?.pass).toBe(false);
  });
});
