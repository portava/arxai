// Task #743 Cluster D (Scopes B & C) — close-after-revocation policy + narrow
// admin-emergency-close kill-switch bypass.
//
// Run:
//   node --import tsx --test src/lib/live/__qa__/clusterDEntitlement.test.ts
//
// These are pure-unit proofs of the entitlement helpers and a real-gate proof
// that the bypass relaxes ONLY gate #5 (kill switch) and that every other gate
// still runs unchanged (gate-still-runs / narrow-CLOSE-only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClosePolicy } from "../closePolicy.js";
import {
  killSwitchCloseBypassApplies,
  effectiveKillSwitchEngaged,
  EMERGENCY_CLOSE_KILL_SWITCH_BYPASS_REASON,
  ADMIN_EMERGENCY_CLOSE_SOURCE,
} from "../killSwitchBypass.js";
import {
  evaluateLivePhaseBDispatchGate,
  type LivePhaseBGateInput,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";

// ── Scope B — honest close-after-revocation audit label ────────────────────
test("resolveClosePolicy reports CLOSE_NORMAL only when still live-approved", () => {
  assert.equal(resolveClosePolicy(true), "CLOSE_NORMAL");
});

test("resolveClosePolicy reports CLOSE_ALLOWED_AFTER_REVOCATION once approval revoked", () => {
  assert.equal(resolveClosePolicy(false), "CLOSE_ALLOWED_AFTER_REVOCATION");
});

// ── Scope C — bypass is CLOSE-only and marker-gated ────────────────────────
test("kill-switch bypass applies ONLY for CLOSE_LIVE_POSITION with a marker", () => {
  assert.equal(
    killSwitchCloseBypassApplies({ commandType: "CLOSE_LIVE_POSITION", hasBypassMarker: true }),
    true,
  );
});

test("kill-switch bypass NEVER applies to OPEN / MODIFY / increase-exposure", () => {
  for (const commandType of ["OPEN_LIVE_POSITION", "MODIFY_LIVE_POSITION", "MODIFY", "OPEN"]) {
    assert.equal(
      killSwitchCloseBypassApplies({ commandType, hasBypassMarker: true }),
      false,
      `${commandType} must not bypass`,
    );
  }
});

test("kill-switch bypass NEVER applies to a CLOSE without a marker", () => {
  assert.equal(
    killSwitchCloseBypassApplies({ commandType: "CLOSE_LIVE_POSITION", hasBypassMarker: false }),
    false,
  );
});

test("effectiveKillSwitchEngaged suppresses the switch ONLY when the bypass is active", () => {
  // real engaged + bypass active → suppressed (false)
  assert.equal(effectiveKillSwitchEngaged(true, true), false);
  // real engaged, no bypass → stays engaged (true)
  assert.equal(effectiveKillSwitchEngaged(true, false), true);
  // not engaged → stays false regardless of bypass
  assert.equal(effectiveKillSwitchEngaged(false, true), false);
  assert.equal(effectiveKillSwitchEngaged(false, false), false);
});

test("bypass constants are stable wire/audit tokens", () => {
  assert.equal(EMERGENCY_CLOSE_KILL_SWITCH_BYPASS_REASON, "EMERGENCY_CLOSE_KILL_SWITCH_BYPASS");
  assert.equal(ADMIN_EMERGENCY_CLOSE_SOURCE, "ADMIN_EMERGENCY_CLOSE");
});

// ── Scope C — real-gate proof: bypass relaxes ONLY gate #5 ─────────────────
function passingGateInput(overrides: Partial<LivePhaseBGateInput> = {}): LivePhaseBGateInput {
  return {
    liveBrokerExecutionEnabled: true,
    globalLiveEnabled: true,
    userLiveApproved: true,
    userArmed: true,
    killSwitchEngaged: false,
    bridgeAccountType: "live",
    bridgeHeartbeatAgeSec: 5,
    bridgeEaVersion: "1.55",
    bridgeEnableLiveExecution: true,
    bridgeReadOnlyMode: false,
    bridgeTerminalConnected: true,
    bridgeAlgoTradingAllowed: true,
    commandSymbol: "EURUSD",
    commandVolume: 0.01,
    commandHasStopLoss: true,
    allowedSymbols: ["EURUSD"],
    maxLotForSymbol: 1,
    dailyLossLimitUsd: 0,
    realisedDailyLossUsd: 0,
    requireStopLoss: true,
    adminAllowNoStopLoss: false,
    requireTakeProfit: false,
    adminAllowNoTakeProfit: true,
    commandHasTakeProfit: false,
    disclosureAccepted: true,
    disclosureWaivedByOperator: false,
    ...overrides,
  };
}

test("baseline fixture PASSes (sanity)", () => {
  assert.equal(evaluateLivePhaseBDispatchGate(passingGateInput()).decision, "PASS");
});

test("kill switch engaged BLOCKS with KILL_SWITCH_ENGAGED", () => {
  const r = evaluateLivePhaseBDispatchGate(passingGateInput({ killSwitchEngaged: true }));
  assert.equal(r.decision, "BLOCKED");
  assert.equal(r.primaryReason, "KILL_SWITCH_ENGAGED");
});

test("feeding the EFFECTIVE (suppressed) kill switch lets a clean CLOSE PASS", () => {
  // This mirrors the dispatch wiring: killSwitchEngaged is fed via
  // effectiveKillSwitchEngaged(real=true, bypassActive=true) → false.
  const r = evaluateLivePhaseBDispatchGate(
    passingGateInput({ killSwitchEngaged: effectiveKillSwitchEngaged(true, true) }),
  );
  assert.equal(r.decision, "PASS");
});

test("the bypass relaxes ONLY gate #5 — every other gate still runs", () => {
  // Kill switch suppressed (bypass active) BUT user approval revoked → still
  // BLOCKED on USER_NOT_LIVE_APPROVED. Proves the bypass does not unlock
  // anything other than the kill switch.
  const r = evaluateLivePhaseBDispatchGate(
    passingGateInput({
      killSwitchEngaged: effectiveKillSwitchEngaged(true, true),
      userLiveApproved: false,
    }),
  );
  assert.equal(r.decision, "BLOCKED");
  assert.equal(r.primaryReason, "USER_NOT_LIVE_APPROVED");
});

test("bypass does not relax a missing stop-loss (defence-in-depth)", () => {
  const r = evaluateLivePhaseBDispatchGate(
    passingGateInput({
      killSwitchEngaged: effectiveKillSwitchEngaged(true, true),
      commandHasStopLoss: false,
    }),
  );
  assert.equal(r.decision, "BLOCKED");
  assert.equal(r.primaryReason, "MISSING_STOP_LOSS");
});
