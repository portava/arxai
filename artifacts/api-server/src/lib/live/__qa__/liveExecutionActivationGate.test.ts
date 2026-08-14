// Task #737 — deterministic tests for the LIVE_EXECUTION_ACTIVATION_GATE pure
// decision. These lock the additive precondition semantics WITHOUT a DB:
//
//   * PASSES ONLY when executionActivated === true (i.e. live_execution_enabled
//     === true AND live_confirmation_required === false) for an eligible human.
//   * Bots / agents / system → BOT_AGENT_NOT_ALLOWED (highest precedence).
//   * Investors → INVESTOR_NOT_ALLOWED.
//   * Not-activated human → LIVE_EXECUTION_ACTIVATION_GATE.
//
// The gate is a PRECONDITION only — it never weakens, skips, or ORs any of the
// 18 Phase B dispatch gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideLiveExecutionActivationGate,
  type ApprovedTraderLiveState,
} from "../approvedTraderLiveState.js";

function baseState(overrides: Partial<ApprovedTraderLiveState> = {}): ApprovedTraderLiveState {
  return {
    userId: 1,
    productRole: "USER",
    isHumanTrader: true,
    isInvestor: false,
    isBotAgentSystem: false,
    approvedForLive: true,
    masterLiveStatus: "APPROVED",
    liveBridgeAssigned: true,
    assignedLiveBridgeId: 7,
    liveExecutionEnabled: true,
    liveConfirmationRequired: false,
    liveConfirmationBypassedByAdmin: 4,
    liveExecutionActivationSource: "admin_full_activation",
    executionActivated: true,
    armed: true,
    killSwitchEngaged: false,
    serverLiveExecutionOn: true,
    operatorLiveArmed: true,
    emergencyKillSwitch: false,
    sharedLiveTradingEnabled: true,
    riskProfileReady: true,
    approvedSymbols: ["EURUSD"],
    maxLot: 0.01,
    dailyLossLimitUsd: 10,
    bridgeConnectionId: 9,
    bridgeConnected: true,
    bridgeHeartbeatFresh: true,
    bridgeHeartbeatAgeSeconds: 3,
    approvedTraderBridgeAssigned: true,
    intendedLiveDisplay: true,
    executionReady: true,
    blockingReasonCode: null,
    blockingReason: null,
    ...overrides,
  };
}

test("PASSES for an activated eligible human trader", () => {
  const d = decideLiveExecutionActivationGate(baseState());
  assert.equal(d.passed, true);
  assert.equal(d.reason, null);
});

test("bot/agent/system is rejected even when activated (highest precedence)", () => {
  const d = decideLiveExecutionActivationGate(
    baseState({ isBotAgentSystem: true, isInvestor: true, executionActivated: true }),
  );
  assert.equal(d.passed, false);
  assert.equal(d.reason, "BOT_AGENT_NOT_ALLOWED");
});

test("investor is rejected even when activated", () => {
  const d = decideLiveExecutionActivationGate(
    baseState({ isInvestor: true, executionActivated: true }),
  );
  assert.equal(d.passed, false);
  assert.equal(d.reason, "INVESTOR_NOT_ALLOWED");
});

test("human not activated → LIVE_EXECUTION_ACTIVATION_GATE", () => {
  const d = decideLiveExecutionActivationGate(
    baseState({ executionActivated: false }),
  );
  assert.equal(d.passed, false);
  assert.equal(d.reason, "LIVE_EXECUTION_ACTIVATION_GATE");
});

test("execution NOT activated when confirmation still required", () => {
  // executionActivated must be false whenever liveConfirmationRequired is true,
  // regardless of liveExecutionEnabled — the gate consumes the resolver flag.
  const d = decideLiveExecutionActivationGate(
    baseState({ liveExecutionEnabled: true, liveConfirmationRequired: true, executionActivated: false }),
  );
  assert.equal(d.passed, false);
  assert.equal(d.reason, "LIVE_EXECUTION_ACTIVATION_GATE");
});

test("execution NOT activated when live execution disabled", () => {
  const d = decideLiveExecutionActivationGate(
    baseState({ liveExecutionEnabled: false, liveConfirmationRequired: false, executionActivated: false }),
  );
  assert.equal(d.passed, false);
  assert.equal(d.reason, "LIVE_EXECUTION_ACTIVATION_GATE");
});
