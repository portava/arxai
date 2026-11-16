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
  isLiveShared: false, isDemo: false, isFrozen: false, canManualTrade: false, cleanBlockedReason: null, envelope: null,
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
    const s = resolveTradeRoomStatus({ isLiveShared: false, isDemo: true, isFrozen: false, canManualTrade: true, cleanBlockedReason: null, cleanModeLabel: "Demo Mode", envelope: { userApprovalStatus: "APPROVED" } }, obs);
    expect(s.connStatus).toBe("Demo");
    expect(s.approval).toBe("Approved");
  });

  it("the page passes the failed state to the risk caps row and takes Approval from the helper", () => {
    const page = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../pages/trade-command-room.tsx"), "utf8");
    expect(page).toMatch(/riskCapsStatus\(tradingMode\.envelope, \{ failed: tradingMode\.isModeUnknown \}\)/);
    expect(page).not.toMatch(/canManualTrade \? "Approved" : "Pending"/);
  });
});

// The envelope was read: the user is not frozen, has no blocker, and
// userCanManualTrade is false (account status not ACTIVE or items need review).
// No risk lock was read, and the status bar already calls this state
// "Waiting for approval" — the Risk Governor must not call it "Risk lock active".
describe("Trade Command Room — read envelope, not yet approved, no blocker", () => {
  it("Risk Governor names the same not-approved state as the status bar", () => {
    const s = resolveTradeRoomStatus({ isLiveShared: true, isDemo: false, isFrozen: false, canManualTrade: false, cleanBlockedReason: null, cleanModeLabel: "Live (Shared Master MT5)", envelope: {} }, obs);
    expect(s.rgStatus.label).not.toBe("Risk lock active");
    expect(s.rgStatus).toEqual({ label: "Waiting for approval", tone: "warning" });
    expect(s.gatesLabel).toBe(s.rgStatus.label);
    expect(s.canTrade).toBe(false);
  });
});

// React Query v5 sets isLoading = isPending && isFetching. Offline at mount,
// the account-mode query is pending with fetchStatus "paused": isLoading
// false, isError false, envelope null. The branch keyed on isLoading, so the
// room fell through to "Sim" / "Waiting for approval" / "Pending" for a user
// who may be LIVE_SHARED. No envelope now always means nothing was read.
describe("Trade Command Room — account-mode query paused (offline), no envelope", () => {
  const s = resolveTradeRoomStatus({ ...noEnvelope, envelope: null, isLoading: false, isModeUnknown: false, cleanModeLabel: "Loading…" }, obs);

  it("says it is checking instead of 'Sim' / 'Waiting for approval' / 'Pending'", () => {
    expect(s.connStatus).not.toBe("Sim");
    expect(s.connStatus).toBe("Checking");
    expect(s.gatesLabel).not.toBe("Waiting for approval");
    expect(s.gatesLabel).toBe("Checking account mode…");
    expect(s.rgStatus).toEqual({ label: "Checking", tone: "warning" });
    expect(s.approval).toBe("Checking");
    expect(s.canTrade).toBe(false);
  });
});

// userCanManualTrade is tradingStatus ACTIVE + no review + no blocker. An
// APPROVED trader under the maintenance blocker, or with tradingMode
// DISABLED, has canManualTrade false, and the Approval row read "Pending"
// although the envelope's userApprovalStatus said APPROVED. The row now shows
// the approval status that was read.
describe("Trade Command Room — Approval row is the read approval status", () => {
  const live = { isLiveShared: true, isDemo: false, isFrozen: false, cleanModeLabel: "Live (Shared Master MT5)" };

  it("approved trader blocked by maintenance: 'Approved', with the block on the status rows", () => {
    const s = resolveTradeRoomStatus({
      ...live, canManualTrade: false,
      cleanBlockedReason: "Live execution is currently paused for maintenance",
      envelope: { userApprovalStatus: "APPROVED" },
    }, obs);
    expect(s.approval).not.toBe("Pending");
    expect(s.approval).toBe("Approved");
    expect(s.rgStatus.label).toBe("Trading blocked");
    expect(s.canTrade).toBe(false);
  });

  it("approved trader whose trading mode is DISABLED (frozen): 'Approved', status 'Trading paused'", () => {
    const s = resolveTradeRoomStatus({ ...live, isFrozen: true, canManualTrade: false, cleanBlockedReason: null, envelope: { userApprovalStatus: "APPROVED" } }, obs);
    expect(s.approval).toBe("Approved");
    expect(s.rgStatus.label).toBe("Trading paused");
  });

  it("names each other read status, and an unrecognised one as unknown", () => {
    const approvalOf = (userApprovalStatus: string | undefined) =>
      resolveTradeRoomStatus({ ...live, canManualTrade: false, cleanBlockedReason: null, envelope: { userApprovalStatus } }, obs).approval;
    expect(approvalOf("NOT_APPROVED")).toBe("Not approved");
    expect(approvalOf("NOT_REQUIRED")).toBe("Not required");
    expect(approvalOf("SUSPENDED")).toBe("Suspended");
    expect(approvalOf("RISK_LOCKED")).toBe("Risk locked");
    expect(approvalOf("DISABLED")).toBe("Disabled");
    expect(approvalOf("PENDING")).toBe("Pending");
    expect(approvalOf("SOMETHING_NEW")).toBe("Unknown");
    expect(approvalOf(undefined)).toBe("Unknown");
  });
});
