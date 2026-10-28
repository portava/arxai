// Trade Command Room status bar — "All safety gates enforced" was shown
// whenever the account-mode envelope said the user may trade manually. That
// is a permission (approval / not frozen / no blocker), not a measurement of
// any gate: no bridge heartbeat, risk-governor read or kill-switch read backs
// it, and the room's Buy / Sell go to the /live-manual capture ticket, whose
// submit runs only the tester caps. The label now says what was read.
//
// The Risk Governor card's "Bridge Connected" and constant "Risk level Low"
// were already replaced (bridge from the shared master heartbeat via
// describeBridgeObservation; caps from describeRiskCaps) — see
// components/dashboard/cockpit/CockpitBridgeTruth.test.tsx. Pinned here too.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTradeRoomStatus } from "./tradeRoomStatus";
import { describeBridgeObservation } from "@/components/dashboard/cockpit/bridgeObservation";
import { describeRiskCaps } from "@/components/dashboard/cockpit/riskCapsSummary";

const demoApproved = {
  isLiveShared: false, isDemo: true, isFrozen: false, canManualTrade: true, cleanBlockedReason: null, cleanModeLabel: "Demo",
};

describe("Trade Command Room — status labels without a measurement behind them", () => {
  it("an approved demo user with no bridge is not told 'All safety gates enforced' or 'Bridge Connected'", () => {
    const s = resolveTradeRoomStatus(demoApproved, describeBridgeObservation({ onSharedRoute: false, allocationView: null }));
    expect(s.gatesLabel).not.toMatch(/safety gates enforced/i);
    expect(s.gatesLabel).toBe("Approved to trade");
    expect(s.bridge).not.toBe("Connected");
  });

  it("risk caps are never a constant 'Low'", () => {
    // describeRiskCaps is the same verdict as riskCapsStatus (one helper for
    // cockpit and trade room): "Checking" while nothing is loaded, never "Low".
    expect(describeRiskCaps(null).label).toBe("Checking");
    expect(describeRiskCaps({ maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: null }).label).toBe("No caps assigned");
    expect(describeRiskCaps({ maxLotSize: null, maxOpenTrades: null, maxDailyLossAmount: null, allowedSymbols: ["EURUSD"] }).label).toBe("Caps assigned");
    const page = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../pages/trade-command-room.tsx"), "utf8");
    expect(page).not.toMatch(/riskLevel=["']Low["']/);
    expect(page).not.toMatch(/bridge=\{blocked \?/);
  });
});
