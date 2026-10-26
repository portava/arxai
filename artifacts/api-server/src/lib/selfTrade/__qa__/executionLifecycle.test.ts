import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ArxLiveCommand, SelfTradeAgentExecution } from "@workspace/db";
import {
  resolveEntryEvidence,
  resolvePendingManagement,
  confirmedCloseTime,
  isOwnedManagementCommand,
  stopAtLeastAsProtective,
  managementNote,
  type PendingManagement,
} from "../executionLifecycle.js";

const stamp = new Date("2026-10-25T23:59:58Z");
const execution = {
  id: 1,
  agentId: 5,
  decisionId: 7,
  executingUserId: 9,
  commandId: "entry-1",
  symbol: "EURUSD",
  side: "BUY",
  brokerTicket: "123",
} as SelfTradeAgentExecution;
const entry = {
  commandId: "entry-1",
  userId: 9,
  selfTradeAgentId: 5,
  selfTradeDecisionId: 7,
  commandType: "PLACE_LIVE_MARKET_ORDER",
  symbol: "EURUSD",
  side: "BUY",
  status: "LIVE_FILLED",
  fillPrice: 1.1,
  brokerTicket: "123",
  filledAt: stamp,
} as ArxLiveCommand;
const pending: PendingManagement = {
  claimId: "claim-1",
  commandId: "modify-1",
  action: "MOVE_TO_BE",
  stopLoss: 1.1,
  requestedAt: stamp.toISOString(),
};
const modify = {
  commandId: "modify-1",
  userId: 9,
  commandType: "MODIFY_LIVE_SLTP",
  symbol: "EURUSD",
  side: "BUY",
  status: "LIVE_FILLED",
  filledAt: stamp,
  stopLoss: 1.1,
  payload: { brokerTicket: "123" },
} as ArxLiveCommand;

describe("entry evidence", () => {
  it("recognizes a human-confirmed prepared entry and preserves actual fill day", () => {
    const result = resolveEntryEvidence(
      { ...execution, status: "PENDING_TICKET" },
      entry,
    );
    assert.deepEqual(result, {
      status: "FILLED",
      fillPrice: 1.1,
      brokerTicket: "123",
      filledAt: stamp,
    });
  });
  it("never treats acceptance, partial execution or uncertainty as a full fill", () => {
    for (const status of [
      "SENT_TO_MT5_LIVE",
      "LIVE_ACKNOWLEDGED",
      "LIVE_PARTIALLY_FILLED",
      "LIVE_UNKNOWN",
      "LIVE_RECONCILIATION_REQUIRED",
    ]) {
      assert.equal(
        resolveEntryEvidence(execution, { ...entry, status })?.status,
        "DISPATCHED",
      );
    }
    for (const status of [
      "LIVE_DRAFT",
      "LIVE_CONFIRMATION_REQUIRED",
      "LIVE_APPROVED",
      "NEW_UNKNOWN_STATE",
    ]) {
      assert.equal(resolveEntryEvidence(execution, { ...entry, status }), null);
    }
  });
  it("does not invent missing fill evidence", () => {
    for (const patch of [
      { brokerTicket: null },
      { brokerTicket: "  " },
      { fillPrice: NaN },
      { fillPrice: 0 },
      { fillPrice: Infinity },
      { fillPrice: null },
      { filledAt: null },
      { filledAt: new Date(NaN) },
    ]) {
      assert.equal(
        resolveEntryEvidence(execution, { ...entry, ...patch }),
        null,
      );
    }
  });
  it("refuses mislinked account, agent, decision, symbol, side or command type", () => {
    for (const patch of [
      { userId: 99 },
      { selfTradeAgentId: 99 },
      { selfTradeDecisionId: 99 },
      { symbol: "GBPUSD" },
      { side: "SELL" },
      { commandId: "other" },
      { commandType: "MODIFY_LIVE_SLTP" },
    ]) {
      assert.equal(
        resolveEntryEvidence(execution, { ...entry, ...patch }),
        null,
      );
    }
  });
  it("does not erase a partially filled entry when its remainder is cancelled", () => {
    assert.equal(
      resolveEntryEvidence(execution, {
        ...entry,
        status: "LIVE_CANCELLED",
        executedVolume: 0.05,
      }),
      null,
    );
  });
  it("releases a cancelled draft without pretending it traded", () => {
    assert.deepEqual(
      resolveEntryEvidence(execution, { ...entry, status: "LIVE_CANCELLED" }),
      { status: "BLOCKED", blockReason: "LIVE_CANCELLED" },
    );
  });
});

describe("management evidence", () => {
  it("requires both a settled command and observed protective stop", () => {
    assert.equal(
      resolvePendingManagement(execution, pending, modify, 1.1),
      "CONFIRMED",
    );
    assert.equal(
      resolvePendingManagement(execution, pending, modify, 1.095),
      "WAIT",
    );
    for (const status of [
      "SENT_TO_MT5_LIVE",
      "LIVE_ACKNOWLEDGED",
      "LIVE_PARTIALLY_FILLED",
      "LIVE_UNKNOWN",
      "LIVE_RECONCILIATION_REQUIRED",
    ]) {
      assert.equal(
        resolvePendingManagement(
          execution,
          pending,
          { ...modify, status },
          1.1,
        ),
        "WAIT",
      );
    }
  });
  it("retains uncertain or unlinked submissions, and rejects known non-execution", () => {
    assert.equal(
      resolvePendingManagement(
        execution,
        { ...pending, commandId: undefined },
        modify,
        1.1,
      ),
      "WAIT",
    );
    assert.equal(
      resolvePendingManagement(execution, pending, undefined, 1.1),
      "WAIT",
    );
    for (const status of [
      "LIVE_REJECTED",
      "LIVE_FAILED",
      "LIVE_CANCELLED",
      "LIVE_EXPIRED",
      "LIVE_BLOCKED",
    ]) {
      assert.equal(
        resolvePendingManagement(
          execution,
          pending,
          { ...modify, status },
          1.1,
        ),
        "REJECTED",
      );
    }
  });
  it("will not complete against another position, account, action or requested stop", () => {
    for (const patch of [
      { payload: { brokerTicket: "456" } },
      { userId: 99 },
      { commandType: "CLOSE_LIVE_POSITION" },
      { stopLoss: 1.09 },
      { filledAt: null },
    ]) {
      assert.equal(
        resolvePendingManagement(
          execution,
          pending,
          { ...modify, ...patch },
          1.1,
        ),
        "WAIT",
      );
    }
  });
  it("recognizes stronger real protection for both sides, including manual moves", () => {
    assert.equal(stopAtLeastAsProtective("BUY", 1.11, 1.1), true);
    assert.equal(stopAtLeastAsProtective("SELL", 1.09, 1.1), true);
    assert.equal(stopAtLeastAsProtective("SELL", 1.11, 1.1), false);
    assert.equal(stopAtLeastAsProtective("BUY", NaN, 1.1), false);
    assert.equal(stopAtLeastAsProtective("BUY", null, 1.1), false);
  });
  it("requires a real close fill and event timestamp on the owned position", () => {
    const close = {
      ...modify,
      commandType: "CLOSE_LIVE_POSITION",
      fillPrice: 1.12,
    };
    assert.equal(isOwnedManagementCommand(execution, close, "EXIT"), true);
    assert.equal(confirmedCloseTime(close), stamp);
    for (const patch of [
      { fillPrice: NaN },
      { fillPrice: 0 },
      { fillPrice: null },
      { status: "LIVE_PARTIALLY_FILLED" },
      { filledAt: null },
    ]) {
      assert.equal(confirmedCloseTime({ ...close, ...patch }), null);
    }
  });
});

describe("operator visibility", () => {
  it("shows pending stop/close and ambiguous unlinked requests without releasing them", () => {
    const row = {
      status: "FILLED",
      managementState: { pendingManagement: pending },
    };
    assert.equal(
      managementNote(row),
      "Stop change awaiting broker confirmation.",
    );
    const unlinked = {
      ...row,
      managementState: {
        pendingManagement: { ...pending, commandId: undefined },
      },
    };
    assert.equal(
      managementNote(unlinked, stamp.getTime() + 10_000),
      "Management request being prepared.",
    );
    assert.match(
      managementNote(unlinked, stamp.getTime() + 31_000) ?? "",
      /needs review/,
    );
    assert.equal(managementNote({ ...row, status: "CLOSED" }), null);
    assert.equal(
      managementNote({
        status: "FILLED",
        managementState: { closeCommandId: "legacy" },
      }),
      "Close awaiting broker confirmation.",
    );
  });
});
