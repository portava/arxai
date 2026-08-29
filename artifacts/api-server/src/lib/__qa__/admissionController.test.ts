// Capability #21 — Position Admission Controller.
//
// Locked here:
//   * Admission evaluates FOUR new dimensions (portfolio-role,
//     broker-dependency, opportunity-cost, operational-load) on top of the
//     existing concentration/correlation base gate.
//   * EVERY decision — including plain ADMIT — carries a portfolio-level
//     stress evidence record with three deterministic scenarios.
//   * Missing evidence degrades CONSERVATIVELY: unknown venue trust or a
//     missing operational-load input caps the decision at ADMIT_REDUCED,
//     never silently ADMIT.
//   * The decision combiner is monotonic (tighten-only) and the output is
//     advisory (advisoryOnly: true) — no execution authority.
//
// IO-free, deterministic. Offline `ci` lane.
// Run: pnpm --filter @workspace/api-server run test:admission-controller

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAdmission,
  tightenDecision,
  runDeterministicStress,
  type AdmissionInput,
} from "@workspace/domain/portfolio-manager";

function baseInput(partial?: Partial<AdmissionInput>): AdmissionInput {
  return {
    candidate: {
      symbol: "V75", direction: "BUY", riskAmount: 50, lotSize: 0.1,
      venue: "deriv", conservativeUtilityR: 0.4,
    },
    accountBalance: 10_000,
    accountEquity: 10_000,
    positions: [],
    maxOpenTrades: 5,
    maxDailyLossPct: 3,
    riskPerTradePct: 0.5,
    venueHealth: [{ venue: "deriv", trust01: 0.9 }],
    bestAlternativeUtilityR: 0.3,
    operationalLoad: { openPositions: 0, maxOpenTrades: 5, pendingOrders: 0 },
    ...partial,
  };
}

test("clean book admits, with all four dimensions present and stress evidence attached", () => {
  const d = evaluateAdmission(baseInput());
  assert.equal(d.decision, "ADMIT");
  assert.equal(d.advisoryOnly, true);
  const dims = d.dimensions.map((x) => x.dimension).sort();
  assert.deepEqual(dims, [
    "BROKER_DEPENDENCY", "OPERATIONAL_LOAD", "OPPORTUNITY_COST", "PORTFOLIO_ROLE",
  ]);
  // Stress evidence record on the ADMIT too.
  assert.equal(d.stressEvidence.method, "DETERMINISTIC_STRESS_V1");
  assert.equal(d.stressEvidence.scenarios.length, 3);
  assert.ok(d.stressEvidence.scenarios.every((s) => Number.isFinite(s.assumedLossAmount)));
});

test("tightenDecision is monotonic — the harsher verdict always wins", () => {
  assert.equal(tightenDecision("ADMIT", "REJECT"), "REJECT");
  assert.equal(tightenDecision("REJECT", "ADMIT"), "REJECT");
  assert.equal(tightenDecision("ADMIT_REDUCED", "DEFER"), "DEFER");
  assert.equal(tightenDecision("DEFER", "ADMIT_REDUCED"), "DEFER");
});

test("portfolio-role: duplicate same-symbol same-direction position REJECTS", () => {
  const d = evaluateAdmission(baseInput({
    positions: [{ symbol: "V75", direction: "BUY", lotSize: 0.1, unrealizedPnl: 0, riskAmount: 40, venue: "deriv" }],
  }));
  assert.equal(d.portfolioRole, "DUPLICATE");
  assert.equal(d.decision, "REJECT");
});

test("portfolio-role: correlated stacking is a CONCENTRATOR (reduced), offsetting is a HEDGE", () => {
  const conc = evaluateAdmission(baseInput({
    candidate: { symbol: "EURUSD", direction: "BUY", riskAmount: 50, lotSize: 0.1, venue: "mt5", conservativeUtilityR: 0.4 },
    venueHealth: [{ venue: "mt5", trust01: 0.9 }],
    positions: [{ symbol: "GBPUSD", direction: "BUY", lotSize: 0.1, unrealizedPnl: 0, riskAmount: 40, venue: "mt5" }],
  }));
  assert.equal(conc.portfolioRole, "CONCENTRATOR");
  assert.notEqual(conc.decision, "ADMIT");

  const hedge = evaluateAdmission(baseInput({
    candidate: { symbol: "EURUSD", direction: "SELL", riskAmount: 50, lotSize: 0.1, venue: "mt5", conservativeUtilityR: 0.4 },
    venueHealth: [{ venue: "mt5", trust01: 0.9 }],
    positions: [{ symbol: "GBPUSD", direction: "BUY", lotSize: 0.1, unrealizedPnl: 0, riskAmount: 40, venue: "mt5" }],
  }));
  assert.equal(hedge.portfolioRole, "HEDGE");
});

test("broker-dependency: unknown venue trust degrades conservatively (never plain ADMIT)", () => {
  const d = evaluateAdmission(baseInput({ venueHealth: [] }));
  const dim = d.dimensions.find((x) => x.dimension === "BROKER_DEPENDENCY")!;
  assert.equal(dim.degraded, true);
  assert.ok(dim.degradedReason?.includes("no trust evidence"));
  assert.notEqual(d.decision, "ADMIT");
});

test("broker-dependency: untrusted venue REJECTS; venue over-concentration on a multi-venue book tightens", () => {
  const bad = evaluateAdmission(baseInput({
    venueHealth: [{ venue: "deriv", trust01: 0.2 }],
  }));
  assert.equal(bad.decision, "REJECT");

  const concentrated = evaluateAdmission(baseInput({
    candidate: { symbol: "V75", direction: "BUY", riskAmount: 90, lotSize: 0.1, venue: "deriv", conservativeUtilityR: 0.4 },
    positions: [
      { symbol: "EURUSD", direction: "BUY", lotSize: 0.1, unrealizedPnl: 0, riskAmount: 5, venue: "mt5" },
      { symbol: "Crash 500 Index", direction: "SELL", lotSize: 0.1, unrealizedPnl: 0, riskAmount: 30, venue: "deriv" },
    ],
  }));
  const dim = concentrated.dimensions.find((x) => x.dimension === "BROKER_DEPENDENCY")!;
  assert.ok(dim.evidence.some((e) => e.includes("% of open risk")));
  assert.notEqual(concentrated.decision, "ADMIT");
});

test("opportunity-cost: a much better alternative under scarce capital DEFERS", () => {
  // Scarce book: risk already near the allowed total.
  const positions = Array.from({ length: 4 }, (_, i) => ({
    symbol: `OTHER${i}`, direction: "BUY" as const, lotSize: 0.1,
    unrealizedPnl: 0, riskAmount: 50, venue: "deriv",
  }));
  const d = evaluateAdmission(baseInput({
    positions,
    candidate: { symbol: "V75", direction: "BUY", riskAmount: 50, lotSize: 0.1, venue: "deriv", conservativeUtilityR: 0.1 },
    bestAlternativeUtilityR: 0.6,
  }));
  const dim = d.dimensions.find((x) => x.dimension === "OPPORTUNITY_COST")!;
  assert.equal(dim.verdict, "DEFER");
  assert.notEqual(d.decision, "ADMIT");
});

test("opportunity-cost without utility evidence is typed-degraded, not invented", () => {
  const d = evaluateAdmission(baseInput({
    candidate: { symbol: "V75", direction: "BUY", riskAmount: 50, lotSize: 0.1, venue: "deriv", conservativeUtilityR: null },
    bestAlternativeUtilityR: null,
  }));
  const dim = d.dimensions.find((x) => x.dimension === "OPPORTUNITY_COST")!;
  assert.equal(dim.score01, null);
  assert.equal(dim.degraded, true);
});

test("operational-load: at-capacity book DEFERS; missing load input degrades conservatively", () => {
  const full = evaluateAdmission(baseInput({
    operationalLoad: { openPositions: 5, maxOpenTrades: 5, pendingOrders: 0 },
  }));
  const dim = full.dimensions.find((x) => x.dimension === "OPERATIONAL_LOAD")!;
  assert.equal(dim.verdict, "DEFER");

  const missing = evaluateAdmission(baseInput({ operationalLoad: undefined }));
  const mDim = missing.dimensions.find((x) => x.dimension === "OPERATIONAL_LOAD")!;
  assert.equal(mDim.degraded, true);
  assert.notEqual(missing.decision, "ADMIT");
});

test("stress evidence: a ruin-floor breach REJECTS regardless of the other dimensions", () => {
  const d = evaluateAdmission(baseInput({
    accountEquity: 1000, accountBalance: 1000,
    candidate: { symbol: "V75", direction: "BUY", riskAmount: 300, lotSize: 1, venue: "deriv", conservativeUtilityR: 0.9 },
  }));
  assert.equal(d.decision, "REJECT");
  assert.ok(d.blockers.some((b) => b.includes("ruin floor")));
  assert.ok(d.stressEvidence.scenarios.some((s) => s.breachesRuinFloor));
});

test("ADMIT_REDUCED always tightens: maxAdmittedRiskAmount ≤ requested", () => {
  const d = evaluateAdmission(baseInput({
    positions: [{ symbol: "GBPUSD", direction: "BUY", lotSize: 0.1, unrealizedPnl: 0, riskAmount: 40, venue: "mt5" }],
    candidate: { symbol: "EURUSD", direction: "BUY", riskAmount: 60, lotSize: 0.1, venue: "mt5", conservativeUtilityR: 0.4 },
    venueHealth: [{ venue: "mt5", trust01: 0.9 }],
  }));
  if (d.decision === "ADMIT_REDUCED") {
    assert.ok(d.maxAdmittedRiskAmount !== null && d.maxAdmittedRiskAmount <= 60);
  } else {
    assert.ok(["DEFER", "REJECT"].includes(d.decision));
  }
});

test("deterministic stress is pure arithmetic: same input, same record", () => {
  const input = baseInput();
  const a = runDeterministicStress(input);
  const b = runDeterministicStress(input);
  assert.deepEqual(a, b);
  assert.equal(a.ruinFloorFraction01, 0.2);
});
