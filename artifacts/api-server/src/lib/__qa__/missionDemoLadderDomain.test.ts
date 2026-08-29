// fix/demo-ladder — pure contract tests for the honest paper/demo fill
// simulator, the labelled promotion evidence, and the ladder's evidence bar.
//
// What these lock (the OFFLINE half; the DB-backed half is missionDemoLadder.test.ts):
//   * NO FILL WITHOUT A QUOTE. Absent / unusable quotes produce a typed refusal,
//     never a price. There is no branch anywhere that invents one.
//   * REAL PRICES ONLY, SPREAD CROSSED. A BUY fills at the real ask, a SELL at
//     the real bid; a single-sided quote is used but its weaker basis is recorded.
//   * PESSIMISTIC EXITS. When one quote sits beyond BOTH the stop and the
//     target, the STOP wins — the order of visits is unknowable and assuming the
//     favourable one would be a lie in the user's favour.
//   * UNKNOWN P/L STAYS UNKNOWN. Without a planned risk distance or a risk
//     amount the R and P/L are null, never a plugged zero.
//   * THE EVIDENCE IS LABELLED. The promotion gate's demo_performance detail and
//     the decision itself state when the evidence is SIMULATED.
//   * THE INVERSION IS CLOSED. `evaluateLadderEvidenceBar` fails without the
//     evidence gates and passes with them, independently of the live-only gates.
//   * THE MONEY LABEL IS ON THE READ SURFACE. `serialize` marks a non-live
//     mission's currentValue SIMULATED.
//
// Everything here is pure — no DB, no network, no clock — so it runs in the
// offline `ci` lane.
//
// Run: pnpm --filter @workspace/api-server run test:mission-demo-ladder-domain

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  simulateEntryFill,
  evaluateSimulatedExit,
  plannedRiskDistance,
  simulatedRMultiple,
  simulatedPnl,
  quotedPriceForSide,
  closingSide,
  evidenceBasisFor,
  describeEvidenceBasis,
  evaluateMissionPromotion,
  evaluateLadderEvidenceBar,
  PROMOTION_EVIDENCE_LEVEL,
  SIMULATED_FILL_ASSUMPTIONS,
  type PromotionEvidence,
} from "@workspace/domain/profit-mission";
import { accountingBasisFor, serialize, assess, type MissionRow } from "../profitMissionSerialize.js";

// ── 1. No fill without a real quote ──────────────────────────────────────────

test("a missing quote produces NO_FILL_NO_QUOTE, never a price", () => {
  const r = simulateEntryFill({ direction: "BUY", quote: null });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.refusal, "NO_FILL_NO_QUOTE");
});

test("a quote with no usable price on the traded side refuses honestly", () => {
  const r = simulateEntryFill({
    direction: "BUY",
    quote: { bid: null, ask: null, last: null },
  });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.refusal, "NO_FILL_NO_USABLE_PRICE");
});

test("a draft with no direction refuses rather than guessing a side", () => {
  const r = simulateEntryFill({ direction: "NONE", quote: { bid: 1, ask: 1.1, last: 1.05 } });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.refusal, "NO_FILL_NO_DIRECTION");
});

// ── 2. Real prices, spread crossed ───────────────────────────────────────────

test("a BUY fills at the real ask and a SELL at the real bid", () => {
  const quote = { bid: 1.1000, ask: 1.1003, last: 1.1001 };
  const buy = simulateEntryFill({ direction: "BUY", quote });
  const sell = simulateEntryFill({ direction: "SELL", quote });
  assert.equal(buy.ok && buy.price, 1.1003);
  assert.equal(sell.ok && sell.price, 1.1000);
  assert.equal(buy.ok && buy.basis, "REAL_BID_ASK_CROSSED");
  // The fill price is always one of the numbers the feed actually published.
  assert.ok(buy.ok && [quote.bid, quote.ask, quote.last].includes(buy.price));
});

test("a one-sided quote still uses a REAL price but records the weaker basis", () => {
  const r = simulateEntryFill({ direction: "BUY", quote: { bid: null, ask: null, last: 1.2345 } });
  assert.equal(r.ok && r.price, 1.2345);
  assert.equal(r.ok && r.basis, "REAL_LAST_NO_SPREAD_AVAILABLE");
});

test("the assumptions say what is NOT modelled instead of inventing it", () => {
  assert.equal(SIMULATED_FILL_ASSUMPTIONS.slippage, "NONE_MODELLED");
  assert.equal(
    SIMULATED_FILL_ASSUMPTIONS.partialFills,
    "NONE_MODELLED_FULL_VOLUME_ASSUMED",
  );
  assert.equal(SIMULATED_FILL_ASSUMPTIONS.commissionsAndSwap, "NOT_MODELLED");
  assert.equal(SIMULATED_FILL_ASSUMPTIONS.spreadCrossing, "REAL_QUOTE_SPREAD_CROSSED");
});

test("closing side and quoted side are the exit-cost mirror of the entry", () => {
  assert.equal(closingSide("BUY"), "SELL");
  assert.equal(closingSide("SELL"), "BUY");
  const quote = { bid: 2, ask: 2.5, last: 2.2 };
  assert.equal(quotedPriceForSide("SELL", quote)?.price, 2);
  assert.equal(quotedPriceForSide("BUY", quote)?.price, 2.5);
});

// ── 3. Exits against real subsequent quotes ──────────────────────────────────

test("a real quote reaching the target closes the simulated position at the target", () => {
  const v = evaluateSimulatedExit({
    side: "BUY",
    stopLoss: 1.0900,
    takeProfit: 1.1100,
    quote: { bid: 1.1105, ask: 1.1108, last: 1.1106 },
  });
  assert.equal(v.closed, true);
  assert.equal(v.closed === true && v.trigger, "take_profit");
  assert.equal(v.closed === true && v.exitPrice, 1.1100);
});

test("STOP BEFORE TARGET: one quote beyond both levels takes the pessimistic branch", () => {
  // A quote that is simultaneously past a BUY's stop and its target (a wide
  // gap) must resolve to the stop — assuming the target was hit first would be
  // a fabricated favourable outcome.
  const v = evaluateSimulatedExit({
    side: "BUY",
    stopLoss: 1.2000,
    takeProfit: 1.1000,
    quote: { bid: 1.0500, ask: 1.0502, last: 1.0501 },
  });
  assert.equal(v.closed === true && v.trigger, "stop_loss");
});

test("no quote leaves the simulated position OPEN with a typed reason", () => {
  const v = evaluateSimulatedExit({
    side: "BUY",
    stopLoss: 1,
    takeProfit: 2,
    quote: null,
  });
  assert.equal(v.closed, false);
  assert.equal(v.closed === false && v.refusal, "NO_FILL_NO_QUOTE");
  assert.equal(v.closed === false && v.markPrice, null);
});

test("an untriggered position stays open and reports an honest mark", () => {
  const v = evaluateSimulatedExit({
    side: "SELL",
    stopLoss: 1.2000,
    takeProfit: 1.1000,
    quote: { bid: 1.1500, ask: 1.1503, last: 1.1501 },
  });
  assert.equal(v.closed, false);
  // Closing a SELL means BUYing — it marks at the ask, the honest exit cost.
  assert.equal(v.closed === false && v.markPrice, 1.1503);
});

test("a finished mission window marks an open position out at the real quote", () => {
  const v = evaluateSimulatedExit({
    side: "BUY",
    stopLoss: 1.0,
    takeProfit: 2.0,
    quote: { bid: 1.5, ask: 1.51, last: 1.505 },
    missionEnded: true,
  });
  assert.equal(v.closed === true && v.trigger, "mission_ended");
  assert.equal(v.closed === true && v.exitPrice, 1.5);
});

// ── 4. Unknown P/L stays unknown ─────────────────────────────────────────────

test("R and P/L derive from the mission's own planned risk", () => {
  const riskDistance = plannedRiskDistance({ plannedEntryPrice: 100, stopLoss: 90 });
  assert.equal(riskDistance, 10);
  const r = simulatedRMultiple({ side: "BUY", entryPrice: 100, exitPrice: 115, riskDistance });
  assert.equal(r, 1.5);
  assert.equal(simulatedPnl({ rMultiple: r, riskAmount: 50 }), 75);
});

test("a SELL's R is signed the other way", () => {
  const r = simulatedRMultiple({ side: "SELL", entryPrice: 100, exitPrice: 90, riskDistance: 10 });
  assert.equal(r, 1);
});

test("no planned stop means NO derivable R or P/L — null, never zero", () => {
  assert.equal(plannedRiskDistance({ plannedEntryPrice: 100, stopLoss: null }), null);
  assert.equal(plannedRiskDistance({ plannedEntryPrice: 100, stopLoss: 100 }), null);
  assert.equal(
    simulatedRMultiple({ side: "BUY", entryPrice: 100, exitPrice: 110, riskDistance: null }),
    null,
  );
  assert.equal(simulatedPnl({ rMultiple: null, riskAmount: 50 }), null);
  assert.equal(simulatedPnl({ rMultiple: 1.5, riskAmount: null }), null);
  assert.equal(simulatedPnl({ rMultiple: 1.5, riskAmount: 0 }), null);
});

// ── 5. The evidence is labelled everywhere the decision is shown ─────────────

function fullEvidence(over: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    backtestSampleSize: 40,
    backtestPromotionEligible: true,
    forwardSampleSize: 25,
    forwardPromotionEligible: true,
    demoWinRate: 0.6,
    demoSampleSize: 25,
    demoEvidenceBasis: "SIMULATED",
    maxDrawdownPct: 8,
    agentReliability: 0.7,
    riskRuleCompliant: true,
    driftSeverity: "NONE",
    liveAutoEnabled: false,
    liveGatesEnabled: false,
    certificateAccepted: false,
    guardrailMaxLevel: 3,
    ...over,
  };
}

test("evidenceBasisFor labels the three honest cases", () => {
  assert.equal(evidenceBasisFor({ simulatedCount: 0, brokerReconciledCount: 0 }), "NONE");
  assert.equal(evidenceBasisFor({ simulatedCount: 5, brokerReconciledCount: 0 }), "SIMULATED");
  assert.equal(evidenceBasisFor({ simulatedCount: 0, brokerReconciledCount: 5 }), "BROKER_RECONCILED");
  assert.equal(evidenceBasisFor({ simulatedCount: 5, brokerReconciledCount: 5 }), "MIXED");
});

test("an unstated basis is described as unproven, never as broker truth", () => {
  const d = describeEvidenceBasis("UNSTATED");
  assert.match(d, /not stated/i);
  assert.match(d, /unproven/i);
});

test("the demo_performance gate STATES that its evidence is simulated", () => {
  const decision = evaluateMissionPromotion(3, fullEvidence());
  const gate = decision.gates.find((g) => g.name === "demo_performance");
  assert.ok(gate);
  assert.equal(gate.passed, true);
  assert.match(gate.detail, /SIMULATED/);
  // And the decision itself carries the label + note for journals and the UI.
  assert.equal(decision.demoEvidenceBasis, "SIMULATED");
  assert.ok(decision.evidenceNotes.some((n) => /SIMULATED/.test(n)));
});

test("simulated demo evidence UNLOCKS demo-auto (the ladder is reachable)", () => {
  const decision = evaluateMissionPromotion(3, fullEvidence());
  assert.equal(decision.approved, true, decision.blockers.join("; "));
});

test("too small a simulated sample still fails the gate — the bar is unchanged", () => {
  const decision = evaluateMissionPromotion(3, fullEvidence({ demoSampleSize: 19, demoWinRate: 0.9 }));
  assert.equal(decision.approved, false);
  assert.ok(decision.failedGates.includes("demo_performance"));
});

test("a losing simulated record still fails the gate — the bar is unchanged", () => {
  const decision = evaluateMissionPromotion(3, fullEvidence({ demoWinRate: 0.3 }));
  assert.equal(decision.approved, false);
  assert.ok(decision.failedGates.includes("demo_performance"));
});

// ── 6. The demo→live inversion is closed ─────────────────────────────────────

test("the evidence bar is the level-3 bar", () => {
  assert.equal(PROMOTION_EVIDENCE_LEVEL, 3);
});

test("no evidence means the evidence bar REFUSES (real money is not the easy road)", () => {
  const bar = evaluateLadderEvidenceBar(
    fullEvidence({
      backtestSampleSize: 0,
      backtestPromotionEligible: false,
      forwardSampleSize: 0,
      forwardPromotionEligible: false,
      demoSampleSize: 0,
      demoWinRate: 0,
      demoEvidenceBasis: "NONE",
    }),
  );
  assert.equal(bar.passed, false);
  assert.ok(bar.failedGates.includes("demo_performance"));
  assert.ok(bar.failedGates.includes("backtest_sample"));
  assert.ok(bar.failedGates.includes("forward_sample"));
});

test("earned evidence clears the bar WITHOUT any live-only gate being satisfied", () => {
  // Certificate, live-auto opt-in and the platform live switch are all OFF here.
  // The bar must be about EVIDENCE only — those gates stay enforced separately,
  // and this must not silently duplicate or relax them.
  const bar = evaluateLadderEvidenceBar(fullEvidence());
  assert.equal(bar.passed, true, bar.blockers.join("; "));
  assert.equal(bar.demoEvidenceBasis, "SIMULATED");
});

test("the evidence bar ignores the guardrail ceiling (that gate lives elsewhere)", () => {
  const bar = evaluateLadderEvidenceBar(fullEvidence({ guardrailMaxLevel: 2 }));
  assert.equal(bar.passed, true);
});

// ── 7. The money label is on the read surface ────────────────────────────────

function row(executionMode: string): MissionRow {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: 1,
    userId: 1,
    startingAmount: 1000,
    targetAmount: 1300,
    requiredProfit: 300,
    timeframeStart: now,
    timeframeEnd: new Date(now.getTime() + 7 * 24 * 3600_000),
    timeframeAmount: null,
    timeframeUnit: null,
    timeframeMinutes: null,
    timeframeLabel: null,
    riskProfile: "balanced",
    executionMode,
    automationLevel: 2,
    status: "running",
    currentMode: "running",
    settingsJson: null,
    currentValue: 1150,
    progressJson: null,
    feasibilityJson: null,
    probabilityJson: null,
    riskJson: null,
    liveAutoEnabled: false,
    certificateAcceptedAt: null,
    certificateAcceptanceJson: null,
    promotionJson: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  } as unknown as MissionRow;
}

test("paper and demo missions label currentValue SIMULATED; live does not", () => {
  assert.equal(accountingBasisFor("paper"), "SIMULATED");
  assert.equal(accountingBasisFor("demo"), "SIMULATED");
  assert.equal(accountingBasisFor("live"), "BROKER_RECONCILED");
  // An unknown / missing mode is never treated as money.
  assert.equal(accountingBasisFor(null), "SIMULATED");
  assert.equal(accountingBasisFor("something-else"), "SIMULATED");

  const nowMs = Date.parse("2026-01-02T00:00:00.000Z");
  const paper = serialize(row("paper"), assess(row("paper"), nowMs));
  assert.equal(paper.accountingBasis, "SIMULATED");
  assert.equal(paper.currentValueSimulated, true);
  assert.match(paper.accountingLabel, /SIMULATED/);

  const live = serialize(row("live"), assess(row("live"), nowMs));
  assert.equal(live.accountingBasis, "BROKER_RECONCILED");
  assert.equal(live.currentValueSimulated, false);
  assert.doesNotMatch(live.accountingLabel, /SIMULATED/);
});
