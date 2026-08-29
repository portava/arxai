// Capability #23 — Ruin & Capacity Simulator with frictions.
//
// Locked here:
//   * Deterministic: same seed → identical result.
//   * The NEW ruin inputs actually bite, in the safe direction:
//       correlation ↑  → ruin probability does not improve
//       liquidity frictions (partial fills + slippage) → mean outcome worsens
//       broker failure ↑ → ruin probability does not improve
//   * Capacity estimate is a guardrail-bounded largest-safe-risk, monotone in
//     distribution quality, honest NO_SAFE_CAPACITY / DEGENERATE_INPUT states.
//   * Simulated-vs-realized comparison is honest: typed INSUFFICIENT_DATA
//     below the sample floor, COMPARED with a verdict above it, and it never
//     fabricates an R basis for realized trades.
//
// IO-free, deterministic (seeded). Offline `ci` lane.
// Run: pnpm --filter @workspace/api-server run test:ruin-capacity

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  simulateRuinWithFrictions,
  estimateStrategyCapacity,
  compareSimulatedVsRealized,
  MIN_REALIZED_SAMPLE,
  type FrictionRuinInput,
} from "@workspace/domain/decision-intelligence";

const BASE: FrictionRuinInput = {
  candidateRiskR: 1,
  winRate01: 0.5,
  avgWinR: 1.4,
  avgLossR: -1,
  pathsToSimulate: 1500,
  horizonTrades: 150,
  ruinThresholdR: -25,
  seed: 42,
};

test("deterministic: same input, same output", () => {
  const a = simulateRuinWithFrictions(BASE);
  const b = simulateRuinWithFrictions(BASE);
  assert.deepEqual(a, b);
});

test("correlation with concurrent positions never IMPROVES ruin", () => {
  const indep = simulateRuinWithFrictions({
    ...BASE, winRate01: 0.45, concurrentPositions: 5, correlation01: 0, ruinThresholdR: -15,
  });
  const corr = simulateRuinWithFrictions({
    ...BASE, winRate01: 0.45, concurrentPositions: 5, correlation01: 0.9, ruinThresholdR: -15,
  });
  assert.ok(corr.ruinProbability01 >= indep.ruinProbability01,
    `correlated ruin ${corr.ruinProbability01} must be ≥ independent ${indep.ruinProbability01}`);
  // and correlated tails are fatter on the downside
  assert.ok(corr.worstFinalR <= indep.worstFinalR + 1e-9);
});

test("liquidity frictions (partial fills + slippage) worsen the mean outcome", () => {
  const clean = simulateRuinWithFrictions(BASE);
  const fricted = simulateRuinWithFrictions({
    ...BASE,
    liquidity: { fillProbability01: 0.9, partialFillMean01: 0.6, slippageR: 0.1 },
  });
  assert.ok(fricted.meanFinalR < clean.meanFinalR,
    `fricted mean ${fricted.meanFinalR} must be < clean mean ${clean.meanFinalR}`);
  assert.ok(fricted.unfilledFraction01 > 0, "unfilled fraction must be reported");
});

test("broker failure input never IMPROVES ruin and is reported", () => {
  const clean = simulateRuinWithFrictions({ ...BASE, ruinThresholdR: -15 });
  const failing = simulateRuinWithFrictions({
    ...BASE, ruinThresholdR: -15,
    brokerFailure: { perTradeFailureProb01: 0.05, failureSlipMultiplier: 3 },
  });
  assert.ok(failing.ruinProbability01 >= clean.ruinProbability01);
  assert.ok(failing.brokerFailureFraction01 > 0);
  assert.ok(failing.meanFinalR < clean.meanFinalR);
});

test("degenerate distribution is a typed blocker, not a simulated number", () => {
  const r = simulateRuinWithFrictions({ ...BASE, avgLossR: 0.5 });
  assert.equal(r.withinGuardrail, false);
  assert.equal(r.ruinProbability01, 1);
  assert.ok(r.blockers.some((b) => b.includes("degenerate")));
});

test("capacity: a strong edge gets more capacity than a weak edge", () => {
  const { candidateRiskR: _c, ...base } = BASE;
  const strong = estimateStrategyCapacity({ ...base, winRate01: 0.58, avgWinR: 1.6 });
  const weak = estimateStrategyCapacity({ ...base, winRate01: 0.47, avgWinR: 1.1 });
  assert.equal(strong.status, "ESTIMATED");
  assert.ok(strong.capacityRiskR >= weak.capacityRiskR,
    `strong capacity ${strong.capacityRiskR} must be ≥ weak ${weak.capacityRiskR}`);
  assert.ok(strong.probes.length >= 2);
});

test("capacity: a ruinous distribution reports NO_SAFE_CAPACITY (zero), degenerate reports DEGENERATE_INPUT", () => {
  const { candidateRiskR: _c, ...base } = BASE;
  const ruinous = estimateStrategyCapacity({
    ...base, winRate01: 0.2, avgWinR: 0.5, ruinThresholdR: -1, horizonTrades: 400,
  });
  assert.equal(ruinous.status, "NO_SAFE_CAPACITY");
  assert.equal(ruinous.capacityRiskR, 0);

  const degenerate = estimateStrategyCapacity({ ...base, avgLossR: 1 });
  assert.equal(degenerate.status, "DEGENERATE_INPUT");
  assert.equal(degenerate.capacityRiskR, 0);
});

test("capacity never exceeds the probe ceiling", () => {
  const { candidateRiskR: _c, ...base } = BASE;
  const easy = estimateStrategyCapacity(
    { ...base, winRate01: 0.9, avgWinR: 3 }, { maxRiskR: 2 });
  assert.ok(easy.capacityRiskR <= 2 + 1e-9);
});

test("sim-vs-realized: below the floor is typed INSUFFICIENT_DATA", () => {
  const r = compareSimulatedVsRealized({
    simulated: { winRate01: 0.5, avgWinR: 1.4, avgLossR: -1 },
    realizedPnls: [10, -8, 12],
  });
  assert.equal(r.status, "INSUFFICIENT_DATA");
  assert.equal(r.insufficientReason, "TOO_FEW_REALIZED_TRADES");
  assert.equal(r.realizedSampleSize, 3);
  assert.equal(r.verdict, undefined);

  const empty = compareSimulatedVsRealized({
    simulated: { winRate01: 0.5, avgWinR: 1.4, avgLossR: -1 },
    realizedPnls: [],
  });
  assert.equal(empty.insufficientReason, "NO_REALIZED_DATA");
});

test("sim-vs-realized: one-sided samples refuse a fabricated payoff ratio", () => {
  const allWins = compareSimulatedVsRealized({
    simulated: { winRate01: 0.5, avgWinR: 1.4, avgLossR: -1 },
    realizedPnls: Array.from({ length: MIN_REALIZED_SAMPLE }, () => 5),
  });
  assert.equal(allWins.status, "INSUFFICIENT_DATA");
  assert.equal(allWins.insufficientReason, "NO_REALIZED_LOSSES");
});

test("sim-vs-realized: consistent and divergent demo samples verdict correctly", () => {
  // ~50% wins at +14, losses at −10 → payoff 1.4, matching the simulated dist.
  const consistent: number[] = [];
  for (let i = 0; i < 40; i++) consistent.push(i % 2 === 0 ? 14 : -10);
  const ok = compareSimulatedVsRealized({
    simulated: { winRate01: 0.5, avgWinR: 1.4, avgLossR: -1 },
    realizedPnls: consistent,
  });
  assert.equal(ok.status, "COMPARED");
  assert.equal(ok.verdict, "CONSISTENT");

  // 20% wins, payoff 0.5 → nothing like the simulated distribution.
  const divergent: number[] = [];
  for (let i = 0; i < 40; i++) divergent.push(i % 5 === 0 ? 5 : -10);
  const bad = compareSimulatedVsRealized({
    simulated: { winRate01: 0.5, avgWinR: 1.4, avgLossR: -1 },
    realizedPnls: divergent,
  });
  assert.equal(bad.status, "COMPARED");
  assert.equal(bad.verdict, "DIVERGENT");
});
