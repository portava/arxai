// Trade Command Room while the account mode is loading or could not be checked.
//
// useTradingMode then has envelope=null, isDemo=false, isLiveShared=false,
// canManualTrade=false and cleanBlockedReason=null. resolveTradeRoomStatus fell
// through to its last branches: the connection pill read "Sim" (a simulator
// claim for a user who may be LIVE_SHARED), the Risk Governor read a red
// "Risk lock active" (no risk lock was read), the status bar read "Waiting for
// approval" and the governor's Approval row "Pending" (the approval state was
// not read), and Risk caps stayed "Checking — have not loaded yet" after the
// check had failed.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTradeRoomStatus, resolveTradeRoomRoute } from "./tradeRoomStatus";
import { describeBridgeObservation } from "@/components/dashboard/cockpit/bridgeObservation";
import { riskCapsStatus } from "@/lib/riskCapsStatus";

const noEnvelope = {
  isLiveShared: false, isDemo: false, isFrozen: false, canManualTrade: false, cleanBlockedReason: null,
};
const obs = describeBridgeObservation({ onSharedRoute: false, allocationView: null });

describe("Trade Command Room — account mode could not be checked", () => {
  const s = resolveTradeRoomStatus({ ...noEnvelope, isModeUnknown: true, cleanModeLabel: "Mode unknown" }, obs);

  it("connection pill is not 'Sim'", () => {
    expect(s.connStatus).not.toBe("Sim");
    expect(s.connStatus).toBe("Mode unknown");
  });

  it("Risk Governor does not claim a risk lock", () => {
    expect(s.rgStatus.label).not.toBe("Risk lock active");
    expect(s.rgStatus).toEqual({ label: "Could not be checked", tone: "warning" });
  });

  it("status bar, blocked label and Approval row say the check failed, not 'Waiting for approval' / 'Pending'", () => {
    expect(s.modeLabel).toBe("Mode unknown");
    expect(s.gatesLabel).toBe("Account mode could not be checked");
    expect(s.blockedLabel).toBe("Account mode could not be checked");
    expect(s.approval).toBe("Could not be checked");
    expect(s.approval).not.toBe("Pending");
  });

  it("stays closed: no trade permission is inferred", () => {
    expect(s.canTrade).toBe(false);
  });

  it("the route heading and the risk caps row agree that nothing was read", () => {
    expect(resolveTradeRoomRoute({ isLiveShared: false, envelope: null }).heading).toBe("Account route not loaded");
    const caps = riskCapsStatus(null, { failed: true });
    expect(caps.label).toBe("Could not be loaded");
    expect(caps.detail).not.toMatch(/have not loaded yet/);
  });
});

describe("Trade Command Room — account mode still loading", () => {
  const s = resolveTradeRoomStatus({ ...noEnvelope, isLoading: true, cleanModeLabel: "Loading…" }, obs);

  it("says it is checking instead of 'Sim' / 'Risk lock active' / 'Waiting for approval' / 'Pending'", () => {
    expect(s.connStatus).toBe("Checking");
    expect(s.rgStatus).toEqual({ label: "Checking", tone: "warning" });
    expect(s.gatesLabel).toBe("Checking account mode…");
    expect(s.approval).toBe("Checking");
    expect(s.canTrade).toBe(false);
    expect(riskCapsStatus(null).label).toBe("Checking");
  });
});

describe("Trade Command Room — a read envelope keeps its labels", () => {
  it("approved demo user: 'Demo' / 'Approved'", () => {
    const s = resolveTradeRoomStatus({ isLiveShared: false, isDemo: true, isFrozen: false, canManualTrade: true, cleanBlockedReason: null, cleanModeLabel: "Demo Mode" }, obs);
    expect(s.connStatus).toBe("Demo");
    expect(s.approval).toBe("Approved");
  });

  it("the page passes the failed state to the risk caps row and takes Approval from the helper", () => {
    const page = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../pages/trade-command-room.tsx"), "utf8");
    expect(page).toMatch(/riskCapsStatus\(tradingMode\.envelope, \{ failed: tradingMode\.isModeUnknown \}\)/);
    expect(page).not.toMatch(/canManualTrade \? "Approved" : "Pending"/);
  });
});
