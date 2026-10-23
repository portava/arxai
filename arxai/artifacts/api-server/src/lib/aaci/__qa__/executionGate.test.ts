// AACI Execution Gate & Reconciliation (Task #231) — PURE unit tests.
// Run via:
//   node --import tsx --test src/lib/aaci/__qa__/executionGate.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:aaci-execution`)
//
// Verifies the honesty + safety contracts of the AACI advisory execution gate
// and post-execution reconciliation helpers:
//   1. mapAaciDecisionToExecutionAdvisory can ONLY add caution — hard-gate fail
//      or low score never proceeds; a positive verdict proceeds but is still
//      (downstream) subject to the 16-gate pipeline. It never "enables".
//   2. isRealFill trusts ONLY LIVE_FILLED + a real broker ticket (dispatch≠fill).
//   3. classifyChainCoherence flags fill-no-position and lost-command and pauses
//      management; coherent / pending / terminal rows never pause.
//   4. detectPositionMismatch surfaces app/broker divergence (advisory only).
//   5. detectPreNewsExposure intersects open symbols with risky symbols.
//   6. No internal UPPER_SNAKE token leaks into any operator-facing reason text.
//
// Pure & deterministic. No DB, no IO.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapAaciDecisionToExecutionAdvisory,
  AACI_AGENT_DISPATCH_THRESHOLD,
} from "../executionAdvisory.js";
import {
  isRealFill,
  classifyChainCoherence,
  detectPositionMismatch,
  detectPreNewsExposure,
  LOST_COMMAND_STALE_MS,
} from "../reconciliationAudit.js";
import type { AaciDecision, AaciRecommendedAction } from "@workspace/domain/aaci";

// NOTE: these tests are pure (no DB IO), but importing the modules under test
// pulls in heavy chains (db pool, market simulator) that keep the event loop
// alive on import. The runner is invoked with `--test-force-exit` so the
// process exits once all tests have completed.

// Operator-facing strings must never contain an internal UPPER_SNAKE token.
const TOKEN_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

function makeDecision(over: Partial<AaciDecision>): AaciDecision {
  return {
    decisionId: "test",
    timestamp: new Date().toISOString(),
    actorType: "self_trade_agent",
    actionRequested: "AUTONOMOUS_EXECUTE",
    hardGatePass: true,
    hardGateFailures: [],
    finalAaciScore: 85,
    recommendedAction: "ALLOW",
    explanation: "Cohesion clear across all systems.",
    userFacingExplanation: "Everything lines up.",
    ...over,
  } as AaciDecision;
}

test("advisory: hard-gate fail can never proceed", () => {
  const a = mapAaciDecisionToExecutionAdvisory(
    makeDecision({ hardGatePass: false, hardGateFailures: ["RISK_GOVERNOR_BLOCK"], recommendedAction: "BLOCK" }),
  );
  assert.equal(a.proceed, false);
  assert.equal(a.sizeMultiplier, 1);
  assert.ok(a.blockReason);
});

test("advisory: below score floor downgrades to prepare-only", () => {
  const low = mapAaciDecisionToExecutionAdvisory(
    makeDecision({ recommendedAction: "ALLOW", finalAaciScore: AACI_AGENT_DISPATCH_THRESHOLD - 1 }),
  );
  assert.equal(low.proceed, false);
  assert.equal(low.downgradeToPrepareOnly, true);
});

test("advisory: clean high verdict proceeds at full size", () => {
  const ok = mapAaciDecisionToExecutionAdvisory(makeDecision({ recommendedAction: "ALLOW", finalAaciScore: 90 }));
  assert.equal(ok.proceed, true);
  assert.equal(ok.sizeMultiplier, 1);
  assert.ok(!TOKEN_RE.test(ok.reason));
});

test("advisory: reduced-size proceeds at half size", () => {
  const half = mapAaciDecisionToExecutionAdvisory(
    makeDecision({ recommendedAction: "ALLOW_REDUCED_SIZE", finalAaciScore: 75 }),
  );
  assert.equal(half.proceed, true);
  assert.equal(half.sizeMultiplier, 0.5);
  assert.ok(!TOKEN_RE.test(half.reason));
});

test("advisory: PREPARE_ONLY stages, never dispatches", () => {
  const prep = mapAaciDecisionToExecutionAdvisory(makeDecision({ recommendedAction: "PREPARE_ONLY", finalAaciScore: 65 }));
  assert.equal(prep.proceed, false);
  assert.equal(prep.downgradeToPrepareOnly, true);
});

test("advisory: cautionary actions all defer (no dispatch, no stage)", () => {
  const cautionary: AaciRecommendedAction[] = [
    "WAIT_FOR_CONFIRMATION",
    "WATCH_ONLY",
    "PROTECT_OPEN_TRADE",
    "EXIT_OR_REDUCE",
    "RECONCILE_SYSTEM",
    "BLOCK",
    "ALERT_ADMIN",
  ];
  for (const action of cautionary) {
    const adv = mapAaciDecisionToExecutionAdvisory(makeDecision({ recommendedAction: action, finalAaciScore: 95 }));
    assert.equal(adv.proceed, false, `${action} should not proceed`);
    assert.equal(adv.downgradeToPrepareOnly, false, `${action} should not stage`);
  }
});

test("advisory: hard-gate fail beats every action (cannot be enabled)", () => {
  const actions: AaciRecommendedAction[] = [
    "ALLOW",
    "ALLOW_REDUCED_SIZE",
    "PREPARE_ONLY",
    "WAIT_FOR_CONFIRMATION",
    "WATCH_ONLY",
    "PROTECT_OPEN_TRADE",
    "EXIT_OR_REDUCE",
    "RECONCILE_SYSTEM",
    "BLOCK",
    "ALERT_ADMIN",
  ];
  for (const action of actions) {
    const adv = mapAaciDecisionToExecutionAdvisory(
      makeDecision({ hardGatePass: false, hardGateFailures: ["X_BLOCK"], recommendedAction: action, finalAaciScore: 99 }),
    );
    assert.equal(adv.proceed, false, `hard-gate fail + ${action} must not proceed`);
  }
});

test("isRealFill: only LIVE_FILLED + real broker ticket (dispatch ≠ fill)", () => {
  assert.equal(isRealFill({ status: "LIVE_FILLED", brokerTicket: "12345" }), true);
  assert.equal(isRealFill({ status: "LIVE_FILLED", brokerTicket: null }), false);
  assert.equal(isRealFill({ status: "SENT_TO_MT5_LIVE", brokerTicket: "9" }), false);
  assert.equal(isRealFill(null), false);
});

test("classifyChainCoherence: fill recorded but no broker position → pause", () => {
  const fnp = classifyChainCoherence({
    execStatus: "FILLED",
    execBrokerTicket: "T1",
    hasOpenBrokerPosition: false,
    command: { status: "LIVE_FILLED", brokerTicket: "T1" },
    commandAgeMs: 1000,
  });
  assert.equal(fnp.verdict, "FILL_NO_POSITION");
  assert.equal(fnp.shouldPauseManagement, true);
});

test("classifyChainCoherence: filled with matching position → coherent, no pause", () => {
  const coherent = classifyChainCoherence({
    execStatus: "FILLED",
    execBrokerTicket: "T2",
    hasOpenBrokerPosition: true,
    command: { status: "LIVE_FILLED", brokerTicket: "T2" },
    commandAgeMs: 1000,
  });
  assert.equal(coherent.verdict, "COHERENT");
  assert.equal(coherent.shouldPauseManagement, false);
});

test("classifyChainCoherence: dispatched + missing or stale command → lost, pause", () => {
  const lost = classifyChainCoherence({
    execStatus: "DISPATCHED",
    execBrokerTicket: null,
    hasOpenBrokerPosition: false,
    command: null,
    commandAgeMs: null,
  });
  assert.equal(lost.verdict, "LOST_COMMAND");
  assert.equal(lost.shouldPauseManagement, true);

  const stale = classifyChainCoherence({
    execStatus: "DISPATCHED",
    execBrokerTicket: null,
    hasOpenBrokerPosition: false,
    command: { status: "SENT_TO_MT5_LIVE", brokerTicket: null },
    commandAgeMs: LOST_COMMAND_STALE_MS + 1,
  });
  assert.equal(stale.verdict, "LOST_COMMAND");
});

test("classifyChainCoherence: fresh in-flight or terminal rows never pause", () => {
  const pending = classifyChainCoherence({
    execStatus: "DISPATCHED",
    execBrokerTicket: null,
    hasOpenBrokerPosition: false,
    command: { status: "SENT_TO_MT5_LIVE", brokerTicket: null },
    commandAgeMs: 1000,
  });
  assert.equal(pending.verdict, "PENDING");
  assert.equal(pending.shouldPauseManagement, false);

  const terminal = classifyChainCoherence({
    execStatus: "CLOSED",
    execBrokerTicket: "T3",
    hasOpenBrokerPosition: false,
    command: { status: "LIVE_CLOSED", brokerTicket: "T3" },
    commandAgeMs: 1000,
  });
  assert.equal(terminal.verdict, "TERMINAL");
  assert.equal(terminal.shouldPauseManagement, false);
});

test("detectPositionMismatch: surfaces app/broker divergence", () => {
  const m = detectPositionMismatch({ appOpenTickets: ["A", "B"], brokerOpenTickets: ["B", "C"] });
  assert.deepEqual(m.onlyInApp, ["A"]);
  assert.deepEqual(m.onlyInBroker, ["C"]);
  assert.equal(m.hasMismatch, true);

  assert.equal(detectPositionMismatch({ appOpenTickets: ["X"], brokerOpenTickets: ["X"] }).hasMismatch, false);
  assert.equal(detectPositionMismatch({ appOpenTickets: [], brokerOpenTickets: [] }).hasMismatch, false);
});

test("detectPreNewsExposure: intersects open symbols with risky symbols", () => {
  assert.deepEqual(
    detectPreNewsExposure({ openSymbols: ["EURUSD", "GBPUSD"], riskySymbols: new Set(["GBPUSD"]) }),
    ["GBPUSD"],
  );
  assert.deepEqual(detectPreNewsExposure({ openSymbols: ["EURUSD"], riskySymbols: new Set() }), []);
  assert.deepEqual(
    detectPreNewsExposure({ openSymbols: ["XAUUSD", "XAUUSD"], riskySymbols: new Set(["XAUUSD"]) }),
    ["XAUUSD"],
  );
});
