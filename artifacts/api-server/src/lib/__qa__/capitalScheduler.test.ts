// Capability #20 — Capital Scheduler over simultaneous qualified opportunities.
//
// Locked here:
//   * The envelope is divided among SIMULTANEOUS opportunities ranked by
//     conservative utility × reliability × turnover × optionality.
//   * TIGHTEN-ONLY: no allocation ever exceeds the per-strategy envelope, the
//     per-symbol cap, or the deployable budget — even when requests are
//     deliberately inflated. verifyScheduleWithinEnvelope re-proves it.
//   * Regret / missed-opportunity accounting: every clipped or unfunded
//     opportunity is journaled with a typed cause and forgone conservative
//     utility; correct declines (utility ≤ 0) journal ZERO forgone utility.
//   * Regret feedback is RANKING-ONLY and bounded ≤ +15% — it never raises
//     any cap.
//
// IO-free, deterministic. Offline `ci` lane.
// Run: pnpm --filter @workspace/api-server run test:capital-scheduler

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scheduleOpportunities,
  verifyScheduleWithinEnvelope,
  summarizeRegretFeedback,
  regretBoostFor,
  scoreOpportunity,
  type OpportunityScheduleInput,
  type QualifiedOpportunity,
} from "@workspace/domain/portfolio-manager";

function opp(partial: Partial<QualifiedOpportunity> & { opportunityId: string }): QualifiedOpportunity {
  return {
    strategyId: "strat-a",
    symbolId: "V75",
    requestedRiskR: 1,
    conservativeUtilityR: 0.3,
    reliability01: 0.8,
    expectedDurationMin: 60,
    optionality01: 0.5,
    ...partial,
  };
}

test("divides the envelope among simultaneous opportunities in rank order", () => {
  const input: OpportunityScheduleInput = {
    opportunities: [
      opp({ opportunityId: "weak", conservativeUtilityR: 0.1, reliability01: 0.5 }),
      opp({ opportunityId: "strong", conservativeUtilityR: 0.6, reliability01: 0.9 }),
      opp({ opportunityId: "mid", conservativeUtilityR: 0.3, reliability01: 0.8 }),
    ],
    strategyEnvelopeR: { "strat-a": 2 },
    perSymbolCapR: 10,
    deployableR: 10,
  };
  const s = scheduleOpportunities(input);
  const byId = new Map(s.allocations.map((a) => [a.opportunityId, a]));
  assert.equal(byId.get("strong")!.rank, 1);
  assert.equal(byId.get("strong")!.allocatedRiskR, 1); // fully funded first
  assert.equal(byId.get("mid")!.allocatedRiskR, 1);    // envelope now exhausted
  assert.equal(byId.get("weak")!.allocatedRiskR, 0);
  assert.equal(s.totalAllocatedR, 2);
  assert.equal(s.blockers.length, 0);
});

test("TIGHTEN-ONLY: inflated requests can never exceed any existing cap", () => {
  const input: OpportunityScheduleInput = {
    opportunities: [
      opp({ opportunityId: "a", requestedRiskR: 100, symbolId: "V75" }),
      opp({ opportunityId: "b", requestedRiskR: 100, symbolId: "EURUSD", strategyId: "strat-b" }),
      opp({ opportunityId: "c", requestedRiskR: 100, symbolId: "V75", strategyId: "strat-b" }),
    ],
    strategyEnvelopeR: { "strat-a": 1.5, "strat-b": 2.5 },
    perSymbolCapR: 2,
    deployableR: 3,
    perSymbolUsedR: { V75: 0.5 },
    deployedR: 0.5,
  };
  const s = scheduleOpportunities(input);
  assert.equal(s.blockers.length, 0, `invariant blockers: ${s.blockers.join("; ")}`);
  assert.deepEqual(verifyScheduleWithinEnvelope(s, input), []);
  // Per-strategy ceilings hold.
  const perStrategy = new Map<string, number>();
  for (const a of s.allocations) {
    perStrategy.set(a.strategyId, (perStrategy.get(a.strategyId) ?? 0) + a.allocatedRiskR);
  }
  assert.ok((perStrategy.get("strat-a") ?? 0) <= 1.5 + 1e-9);
  assert.ok((perStrategy.get("strat-b") ?? 0) <= 2.5 + 1e-9);
  // Per-symbol cap (2) minus already-used (0.5) leaves 1.5 for V75.
  const v75 = s.allocations.filter((a) => a.symbolId === "V75")
    .reduce((x, a) => x + a.allocatedRiskR, 0);
  assert.ok(v75 <= 1.5 + 1e-9);
  // Deployable (3) minus deployed (0.5) leaves 2.5 in total.
  assert.ok(s.totalAllocatedR <= 2.5 + 1e-9);
});

test("regret journal: clipped risk carries typed cause and forgone utility", () => {
  const input: OpportunityScheduleInput = {
    opportunities: [
      opp({ opportunityId: "big", requestedRiskR: 3, conservativeUtilityR: 0.4 }),
    ],
    strategyEnvelopeR: { "strat-a": 1 },
    perSymbolCapR: 10,
    deployableR: 10,
  };
  const s = scheduleOpportunities(input);
  assert.equal(s.regretJournal.length, 1);
  const j = s.regretJournal[0]!;
  assert.equal(j.cause, "STRATEGY_ENVELOPE_EXHAUSTED");
  assert.ok(Math.abs(j.missedRiskR - 2) < 1e-9);
  assert.ok(Math.abs(j.forgoneConservativeUtilityR - 0.8) < 1e-9);
  assert.ok(s.totalForgoneConservativeUtilityR > 0);
});

test("non-positive conservative utility is declined with ZERO forgone utility", () => {
  const s = scheduleOpportunities({
    opportunities: [opp({ opportunityId: "neg", conservativeUtilityR: -0.2 })],
    strategyEnvelopeR: { "strat-a": 5 },
    perSymbolCapR: 10,
    deployableR: 10,
  });
  assert.equal(s.allocations[0]!.allocatedRiskR, 0);
  assert.equal(s.regretJournal[0]!.cause, "NEGATIVE_CONSERVATIVE_UTILITY");
  assert.equal(s.regretJournal[0]!.forgoneConservativeUtilityR, 0);
  // …and summarizeRegretFeedback treats a correct decline as non-regret.
  assert.deepEqual(summarizeRegretFeedback(s.regretJournal), []);
});

test("regret feedback re-ranks (bounded ≤ +15%) but NEVER raises a cap", () => {
  const boost = regretBoostFor("strat-x", [
    { strategyId: "strat-x", missedCount: 10_000, forgoneUtilityR: 999 },
  ]);
  assert.ok(boost <= 1.15 + 1e-12, `boost ${boost} must be capped at 1.15`);
  assert.equal(regretBoostFor("strat-x", undefined), 1);

  // Two equal opportunities on different strategies; feedback flips the order…
  const a = opp({ opportunityId: "a", strategyId: "s1" });
  const b = opp({ opportunityId: "b", strategyId: "s2" });
  const feedback = [{ strategyId: "s2", missedCount: 5, forgoneUtilityR: 2 }];
  assert.ok(scoreOpportunity(b, feedback) > scoreOpportunity(a, feedback));
  // …but the envelope is unchanged: with 1R total for s2, allocation ≤ 1R.
  const s = scheduleOpportunities({
    opportunities: [a, b],
    strategyEnvelopeR: { s1: 1, s2: 1 },
    perSymbolCapR: 10, deployableR: 10,
    regretFeedback: feedback,
  });
  for (const alloc of s.allocations) assert.ok(alloc.allocatedRiskR <= 1 + 1e-9);
  assert.deepEqual(s.blockers, []);
});

test("ranking prefers shorter duration and reliability at equal utility", () => {
  const fast = opp({ opportunityId: "fast", expectedDurationMin: 30 });
  const slow = opp({ opportunityId: "slow", expectedDurationMin: 8 * 60 });
  assert.ok(scoreOpportunity(fast) > scoreOpportunity(slow));
  const reliable = opp({ opportunityId: "r", reliability01: 0.9 });
  const flaky = opp({ opportunityId: "f", reliability01: 0.3 });
  assert.ok(scoreOpportunity(reliable) > scoreOpportunity(flaky));
});

test("every schedule carries deterministic stress evidence within the budget", () => {
  const input: OpportunityScheduleInput = {
    opportunities: [
      opp({ opportunityId: "a", requestedRiskR: 1 }),
      opp({ opportunityId: "b", requestedRiskR: 1, symbolId: "EURUSD", strategyId: "strat-b" }),
    ],
    strategyEnvelopeR: { "strat-a": 1, "strat-b": 1 },
    perSymbolCapR: 10,
    deployableR: 4,
  };
  const s = scheduleOpportunities(input);
  assert.equal(s.stressEvidence.method, "SCHEDULER_STRESS_V1");
  assert.equal(s.stressEvidence.simultaneousFullLossR, 2);
  assert.ok(Math.abs(s.stressEvidence.lossFractionOfDeployable - 0.5) < 1e-9);
  assert.equal(s.stressEvidence.exceedsDeployable, false);
  assert.equal(s.stressEvidence.worstSymbolLossR, 1);
  assert.ok(s.reasons.some((r) => r.includes("simultaneous full loss")));
});

test("perSymbolCapR = 0 is a REAL zero cap, not a disabled cap", () => {
  // A budget of maxPerSymbolRiskFraction01 = 0 legitimately derives
  // perSymbolCapR = 0 (riskBudget.engine). The scheduler must fund NOTHING,
  // journal the miss as SYMBOL_CAP_REACHED, and the verifier must agree —
  // 0 must never be silently reinterpreted as "no per-symbol cap".
  const input: OpportunityScheduleInput = {
    opportunities: [opp({ opportunityId: "zerocap", requestedRiskR: 1 })],
    strategyEnvelopeR: { "strat-a": 5 },
    perSymbolCapR: 0,
    deployableR: 10,
  };
  const s = scheduleOpportunities(input);
  assert.equal(s.allocations[0]!.allocatedRiskR, 0);
  assert.equal(s.totalAllocatedR, 0);
  assert.equal(s.regretJournal[0]!.cause, "SYMBOL_CAP_REACHED");
  assert.deepEqual(s.blockers, []);
  assert.deepEqual(verifyScheduleWithinEnvelope(s, input), []);
  // The verifier itself must flag a schedule that ignores a zero cap.
  const breached = { ...s, allocations: s.allocations.map((a) => ({ ...a, allocatedRiskR: 1 })) };
  const violations = verifyScheduleWithinEnvelope(breached, input);
  assert.ok(
    violations.some((v) => v.includes("perSymbolCapR 0")),
    `expected a per-symbol violation, got: ${JSON.stringify(violations)}`,
  );
});

test("capacity clip binds and is journaled as CAPACITY_LIMIT", () => {
  const s = scheduleOpportunities({
    opportunities: [opp({ opportunityId: "cap", requestedRiskR: 2, capacityRiskR: 0.5 })],
    strategyEnvelopeR: { "strat-a": 5 },
    perSymbolCapR: 10, deployableR: 10,
  });
  assert.equal(s.allocations[0]!.allocatedRiskR, 0.5);
  assert.equal(s.regretJournal[0]!.cause, "CAPACITY_LIMIT");
});
