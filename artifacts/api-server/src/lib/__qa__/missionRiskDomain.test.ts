// Profit Mission Phase 6 (Task #665) — PURE, OFFLINE proof of the mission risk
// engines: loss ladder, consecutive-loss protocol, outcome-driven mode, blow-up
// score, behavioral detectors, emergency stop, no-martingale sizing, and the
// STRICTER-ONLY gate composition. These modules are IO-free, so this suite runs
// in the offline `ci` lane with no database or network.
//
// SAFETY / SCOPE: these engines can only make a mission STRICTER. They never
// place an order and can never relax the per-user Risk Governor or the 23-gate
// live dispatch — `composeMissionGate` proves its decision is always at least as
// strict as the governor decision it is handed.
//
// Tests 43-55 from the task spec live here.
//
// Run: pnpm --filter @workspace/api-server run test:mission-risk-domain

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MISSION_RISK_BUDGET,
  evaluateLossLadder,
  consecutiveLossProtocol,
  resolveMissionMode,
  missionTradeSize,
  composeMissionGate,
  computeBlowupRisk,
  detectBehavioralRisk,
  evaluateEmergencyStop,
  type EmergencyStopInput,
} from "@workspace/domain/profit-mission";

// A baseline emergency-stop input with every condition clear; tests flip one.
function cleanEmergencyInput(): EmergencyStopInput {
  return {
    missionLossPct: 0,
    maxMissionLossPct: 10,
    dailyLossPct: 0,
    maxDailyLossPct: 5,
    killSwitchActive: false,
    brokerConnected: true,
    feedStatus: "live",
    quoteFresh: true,
    ghostPosition: false,
    equityMismatch: false,
    spread: "normal",
    slippageAbnormal: false,
    executionFailures: 0,
    severeDrift: false,
    highImpactNews: false,
    blowupLevel: "low",
    userEmergencyStop: false,
  };
}

// (43) Behind-pace pressure must NEVER bypass risk: when a real risk signal
//      (here a deep drawdown) is present, the stricter mode wins over the
//      pace-driven "attack" scanning mode. Behind pace only raises scan freq.
test("43: behind-pace mission does not bypass risk discipline", () => {
  const behindClean = resolveMissionMode({
    pace: "behind",
    drawdownPct: 0,
    consecutiveLosses: 0,
    dailyLossPct: 0,
  });
  // "attack" is the LEAST-strict mode, so it never lowers the baseline `normal`
  // discipline — behind pace can only raise scanning frequency, never weaken risk.
  assert.equal(behindClean.mode, "normal", "behind pace never drops below normal discipline");
  assert.ok(
    behindClean.reasons.some((r) => /scanning frequency/i.test(r)),
    "behind pace is recorded as a scanning-frequency change only",
  );

  // With a real drawdown, the loss ladder must dominate the pace mode.
  const behindWithDrawdown = resolveMissionMode({
    pace: "behind",
    drawdownPct: 8, // ladder → cooldown
    consecutiveLosses: 0,
    dailyLossPct: 0,
  });
  assert.equal(
    behindWithDrawdown.mode,
    "cooldown",
    "behind pace cannot override a drawdown-driven cooldown",
  );

  // And sizing never amplifies just because the mission is behind.
  const size = missionTradeSize({
    baseRiskPct: 1,
    riskMultiplier: 1,
    lastTradeWasLoss: true,
    martingaleAllowed: DEFAULT_MISSION_RISK_BUDGET.martingaleAllowed,
  });
  assert.ok(size.riskPct <= 1, "behind pace never increases trade size");
});

// (44) Ahead-of-pace reduces aggression (protect), protecting gains.
test("44: ahead-of-pace reduces aggression", () => {
  const ahead = resolveMissionMode({
    pace: "ahead",
    drawdownPct: 0,
    consecutiveLosses: 0,
    dailyLossPct: 0,
  });
  assert.equal(ahead.mode, "protect", "ahead pace reduces aggression");
});

// (45) Daily-loss limit pauses the mission (cooldown mode + budget block).
test("45: daily loss limit pauses the mission", () => {
  const atCap = resolveMissionMode({
    pace: "on_track",
    drawdownPct: 0,
    consecutiveLosses: 0,
    dailyLossPct: DEFAULT_MISSION_RISK_BUDGET.maxLossPerDayPct, // == cap
  });
  assert.equal(atCap.mode, "cooldown", "hitting the daily-loss cap pauses (cooldown)");

  // And the gate refuses a trade once the budget is exceeded.
  const gate = composeMissionGate({
    governorDecision: "pass",
    mode: "cooldown",
    ladderAction: "normal",
    blowupAction: "continue",
    budgetExceeded: true,
    cooldownActive: true,
    emergencyTriggered: false,
    hasStopLoss: true,
  });
  assert.equal(gate.allow, false);
  assert.ok(gate.blockReasons.includes("MISSION_RISK_BUDGET_EXCEEDED"));
});

// (46) Mission-loss limit STOPS the mission outright.
test("46: mission loss limit stops the mission", () => {
  const input = cleanEmergencyInput();
  input.missionLossPct = 10; // == maxMissionLossPct
  const stop = evaluateEmergencyStop(input);
  assert.equal(stop.triggered, true);
  assert.equal(stop.action, "stop", "mission-loss limit halts the mission");
  assert.equal(stop.primary, "max_mission_loss");

  // The loss ladder agrees at the hard drawdown stop.
  assert.equal(evaluateLossLadder(10).action, "stop");
});

// (47) A stale feed blocks the mission trade (pause).
test("47: stale feed blocks the mission trade", () => {
  const input = cleanEmergencyInput();
  input.feedStatus = "stale";
  const res = evaluateEmergencyStop(input);
  assert.equal(res.triggered, true);
  assert.ok(res.conditions.includes("stale_feed"));
  assert.equal(res.action, "pause", "a stale feed pauses new entries");

  // An unknown feed is treated the same (fail-safe toward stricter).
  const unknown = cleanEmergencyInput();
  unknown.feedStatus = "unknown";
  assert.equal(evaluateEmergencyStop(unknown).triggered, true);
});

// (48) A wide spread blocks a scalp.
test("48: wide spread blocks a scalp", () => {
  const scalp = composeMissionGate({
    governorDecision: "pass",
    mode: "normal",
    ladderAction: "normal",
    blowupAction: "continue",
    budgetExceeded: false,
    cooldownActive: false,
    emergencyTriggered: false,
    hasStopLoss: true,
    spread: "wide",
    isScalp: true,
  });
  assert.equal(scalp.allow, false);
  assert.ok(scalp.blockReasons.includes("SCALP_WIDE_SPREAD"));

  // A non-scalp trade tolerates a wide (but not extreme) spread.
  const swing = composeMissionGate({
    governorDecision: "pass",
    mode: "normal",
    ladderAction: "normal",
    blowupAction: "continue",
    budgetExceeded: false,
    cooldownActive: false,
    emergencyTriggered: false,
    hasStopLoss: true,
    spread: "wide",
    isScalp: false,
  });
  assert.equal(swing.allow, true);
});

// (49) No valid stop-loss blocks the trade.
test("49: missing stop-loss blocks the trade", () => {
  const gate = composeMissionGate({
    governorDecision: "pass",
    mode: "normal",
    ladderAction: "normal",
    blowupAction: "continue",
    budgetExceeded: false,
    cooldownActive: false,
    emergencyTriggered: false,
    hasStopLoss: false,
  });
  assert.equal(gate.allow, false);
  assert.ok(gate.blockReasons.includes("MISSION_STOP_LOSS_REQUIRED"));
});

// (50) Blow-up "high" reduces risk.
test("50: blow-up high reduces risk", () => {
  const res = computeBlowupRisk({
    drawdownPct: 8, // 30
    consecutiveLosses: 2, // 10
    dailyLossPct: 0,
    maxDailyLossPct: 5,
    revengeDetected: false,
    overtradingDetected: false,
    budgetUsedPct: 80, // 8 → score 48 → high
  });
  assert.equal(res.level, "high");
  assert.equal(res.action, "reduce_risk");

  // The gate turns a reduce_risk read into a warning, not a hard block.
  const gate = composeMissionGate({
    governorDecision: "pass",
    mode: "normal",
    ladderAction: "normal",
    blowupAction: res.action,
    budgetExceeded: false,
    cooldownActive: false,
    emergencyTriggered: false,
    hasStopLoss: true,
  });
  assert.equal(gate.allow, true);
  assert.equal(gate.decision, "warning");
});

// (51) Blow-up "critical" pauses / stops the mission.
test("51: blow-up critical stops the mission", () => {
  const res = computeBlowupRisk({
    drawdownPct: 10, // 40 + hard stop escalation
    consecutiveLosses: 4, // 30
    dailyLossPct: 5,
    maxDailyLossPct: 5, // dailyCapHit → 25
    revengeDetected: true, // 15
    overtradingDetected: true, // 15
    budgetUsedPct: 100, // 15
  });
  assert.equal(res.level, "critical");
  assert.equal(res.action, "stop_mission");

  const gate = composeMissionGate({
    governorDecision: "pass",
    mode: "normal",
    ladderAction: "normal",
    blowupAction: res.action,
    budgetExceeded: false,
    cooldownActive: false,
    emergencyTriggered: false,
    hasStopLoss: true,
  });
  assert.equal(gate.allow, false);
  assert.ok(gate.blockReasons.includes("BLOWUP_STOP_MISSION"));

  // Emergency engine treats a critical blow-up as a stop condition.
  const em = cleanEmergencyInput();
  em.blowupLevel = "critical";
  const stop = evaluateEmergencyStop(em);
  assert.equal(stop.action, "stop");
  assert.ok(stop.conditions.includes("blowup_critical"));
});

// (52) Revenge detector activates a cooldown.
test("52: revenge detector activates a cooldown", () => {
  const res = detectBehavioralRisk({
    recentClosesInLastHour: 1,
    reentriesAfterLossInLastHour: 2, // == revenge threshold
  });
  assert.equal(res.revenge, true);
  assert.equal(res.cooldownTriggered, true);
  assert.ok(res.scoreDock > 0);

  // One re-entry is below threshold — no cooldown.
  const below = detectBehavioralRisk({
    recentClosesInLastHour: 1,
    reentriesAfterLossInLastHour: 1,
  });
  assert.equal(below.revenge, false);
  assert.equal(below.cooldownTriggered, false);
});

// (53) Overtrading detector activates a cooldown.
test("53: overtrading detector activates a cooldown", () => {
  const res = detectBehavioralRisk({
    recentClosesInLastHour: 5, // == overtrading threshold
    reentriesAfterLossInLastHour: 0,
  });
  assert.equal(res.overtrading, true);
  assert.equal(res.cooldownTriggered, true);
  assert.ok(res.scoreDock > 0);
});

// (54) Martingale is disabled by default and sizing never grows after a loss.
test("54: martingale disabled by default; size never grows after a loss", () => {
  assert.equal(DEFAULT_MISSION_RISK_BUDGET.martingaleAllowed, false);

  // After a loss, with a protective half-risk multiplier, size shrinks.
  const afterLoss = missionTradeSize({
    baseRiskPct: 1,
    riskMultiplier: 0.5,
    lastTradeWasLoss: true,
    martingaleAllowed: false,
  });
  assert.equal(afterLoss.riskPct, 0.5);
  assert.equal(afterLoss.note, "no_martingale");

  // Even if the multiplier were >1, sizing clamps to the base (never amplifies).
  const clamped = missionTradeSize({
    baseRiskPct: 1,
    riskMultiplier: 4,
    lastTradeWasLoss: true,
    martingaleAllowed: true,
  });
  assert.ok(clamped.riskPct <= 1, "size never exceeds the base after a loss");
});

// (55) Consecutive-loss protocol triggers a cooldown at the streak cap.
test("55: consecutive-loss protocol triggers a cooldown", () => {
  const max = DEFAULT_MISSION_RISK_BUDGET.maxConsecutiveLosses; // 3
  assert.equal(consecutiveLossProtocol(0).cooldown, false);
  assert.equal(consecutiveLossProtocol(max - 1).mode, "protect");
  assert.equal(consecutiveLossProtocol(max - 1).riskMultiplier, 0.5);

  const atCap = consecutiveLossProtocol(max);
  assert.equal(atCap.mode, "recovery");
  assert.equal(atCap.cooldown, true, "the streak cap triggers a cooldown");
  assert.ok(atCap.riskMultiplier < 0.5, "risk shrinks at the streak cap");

  const over = consecutiveLossProtocol(max + 1);
  assert.equal(over.mode, "stop");
  assert.equal(over.riskMultiplier, 0, "beyond the cap, no risk is taken");
});

// (stricter-only invariant) The mission gate can NEVER relax the Risk Governor:
// a `block` governor decision stays blocked even when every mission input is the
// most permissive value possible. The mission layer only ever ADDS strictness.
test("stricter-only: a governor block can never be relaxed by mission fields", () => {
  const gate = composeMissionGate({
    governorDecision: "block",
    // Most-permissive mission inputs across the board.
    mode: "attack",
    ladderAction: "normal",
    blowupAction: "continue",
    budgetExceeded: false,
    cooldownActive: false,
    emergencyTriggered: false,
    hasStopLoss: true,
    edgeTier: "A",
  });
  assert.equal(gate.allow, false, "a governor block must remain blocked");
  assert.equal(gate.decision, "block");
  assert.ok(
    gate.blockReasons.includes("RISK_GOVERNOR_BLOCK"),
    "the governor block reason is preserved",
  );
});
