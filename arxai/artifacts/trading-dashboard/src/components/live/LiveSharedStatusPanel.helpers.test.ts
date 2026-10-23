import { describe, it, expect } from "vitest";
import { isRejectedCommand, rejectionPrimaryReason } from "./LiveSharedStatusPanel";
import { categorizeReason } from "@/lib/humanize";
import type { LiveSharedCommandRow } from "@/lib/api/liveShared";

// Minimal row factory — only the fields the two helpers read matter.
function row(p: Partial<LiveSharedCommandRow>): LiveSharedCommandRow {
  return {
    commandId: "c1",
    status: "LIVE_DRAFT",
    action: null,
    symbol: "EURUSD",
    side: "BUY",
    requestedVolume: 0.01,
    stopLoss: null,
    takeProfit: null,
    sourcePage: null,
    rejectionReason: null,
    mt5Retcode: null,
    brokerMessage: null,
    confirmedAt: null,
    sentToMt5At: null,
    filledAt: null,
    brokerTicket: null,
    fillPrice: null,
    ...p,
  } as LiveSharedCommandRow;
}

describe("isRejectedCommand", () => {
  it("flags every terminal refusal status", () => {
    for (const status of ["LIVE_BLOCKED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_EXPIRED"]) {
      expect(isRejectedCommand(row({ status }))).toBe(true);
    }
  });

  it("does NOT flag success or user-cancelled terminals", () => {
    for (const status of ["LIVE_FILLED", "LIVE_CLOSED", "LIVE_CANCELLED"]) {
      expect(isRejectedCommand(row({ status }))).toBe(false);
    }
  });

  it("does NOT flag in-flight rows", () => {
    expect(isRejectedCommand(row({ status: "SENT_TO_MT5_LIVE" }))).toBe(false);
    expect(isRejectedCommand(row({ status: "LIVE_APPROVED" }))).toBe(false);
  });

  it("flags any row carrying a rejection reason", () => {
    expect(isRejectedCommand(row({ status: "LIVE_APPROVED", rejectionReason: "MISSING_STOP_LOSS" }))).toBe(true);
  });

  it("flags a non-success retcode but not the 10009 success code", () => {
    expect(isRejectedCommand(row({ mt5Retcode: 10019 }))).toBe(true);
    expect(isRejectedCommand(row({ mt5Retcode: "10027" }))).toBe(true);
    expect(isRejectedCommand(row({ mt5Retcode: 10009 }))).toBe(false);
    expect(isRejectedCommand(row({ mt5Retcode: "10009" }))).toBe(false);
  });
});

describe("rejectionPrimaryReason", () => {
  it("prefers the server-set categorized rejection reason", () => {
    expect(rejectionPrimaryReason(row({ rejectionReason: "MISSING_STOP_LOSS", mt5Retcode: 10019 })))
      .toBe("MISSING_STOP_LOSS");
  });

  it("derives an MT5:<code> token when reason is null but a broker retcode is present", () => {
    expect(rejectionPrimaryReason(row({ rejectionReason: null, mt5Retcode: 10019 })))
      .toBe("MT5:10019");
  });

  it("falls back to the status only when there is no reason and no broker retcode", () => {
    expect(rejectionPrimaryReason(row({ status: "LIVE_REJECTED", rejectionReason: null, mt5Retcode: null })))
      .toBe("LIVE_REJECTED");
  });

  it("the derived MT5:<code> token categorizes as a BROKER refusal (honest, not generic)", () => {
    const code = rejectionPrimaryReason(row({ rejectionReason: null, mt5Retcode: 10019 }));
    expect(categorizeReason(code)).toBe("BROKER");
    // a bare lifecycle status must NOT masquerade as a broker cause
    expect(categorizeReason("LIVE_REJECTED")).not.toBe("BROKER");
  });
});
