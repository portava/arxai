// ═══════════════════════════════════════════════════════════════════════════
// Phase 11 — Ecosystem Evolution + Governance Intelligence
//
// Acceptance criteria locked in (PE11_1..PE11_15):
//   PE11_1  Ecosystem fitness fuses contributions + fragility into [0,1]
//           and EXPOSES blockers when fitness < 0.4.
//   PE11_2  Constitution REFUSES any mutation proposed from a non-SANDBOX
//           mode (cites L_SANDBOX_ONLY_EVO).
//   PE11_3  Constitution REFUSES forbidden mutation patterns (no stop loss,
//           leverage > cap, blacklisted memory fingerprint, validation skip).
//   PE11_4  Ecosystem simulation is sandbox-only — non-SANDBOX requests are
//           refused with explicit blockers (and vault-logged DANGER).
//   PE11_5  Mutation memory query returns blacklisted=true when prior history
//           includes COLLAPSED_LIVE / OVERFIT_DETECTED / FAKE_EDGE_DETECTED.
//   PE11_6  Emergency veto is REFUSED for low-rank authorities (rank > 2).
//   PE11_7  Governance vote weighting respects authority hierarchy AND
//           reputation01 (higher rank + higher reputation ⇒ more weight).
//   PE11_8  Fake-edge detector blocks (suspicion01 ≥ 0.6) on the canonical
//           "outlier-driven, OOS-collapsed, tiny sample" combo.
//   PE11_9  Overfit detector blocks (overfit01 ≥ 0.6) on the canonical
//           "high train, bad val, many params" combo.
//   PE11_10 Statistical-illusion detector blocks (illusion01 ≥ 0.6) on a
//           tiny noisy sample with t-like below 1.5.
//   PE11_11 Species classification + ecosystem balance flag MONOCULTURE when
//           one species holds ≥ 60% capital share.
//   PE11_12 Civilization stress test SURVIVES a normal shock and FAILS a
//           catastrophic one (margin of safety drops to 0).
//   PE11_13 Ecosystem survival composite ∈ [0,1], drops below 0.3 in the
//           degenerate scenario AND surfaces blockers.
//   PE11_14 Every Phase 11 advisory route returns canPlaceTrades:false and a
//           non-empty mode/generatedAtIso envelope.
//   PE11_15 Vault entries (EE_*) are emitted for every Phase 11 state change.
// ═══════════════════════════════════════════════════════════════════════════

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { Pool } = pg;
const BASE = "http://localhost:80/api";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function j(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

before(async () => { await pool.query(`SELECT 1`); });
after(async () => { await pool.end(); });
beforeEach(async () => { await pool.query(`DELETE FROM audit_events`); });

async function vaultTypes() {
  const r = await pool.query(`SELECT event_type FROM audit_events ORDER BY id`);
  return r.rows.map((x) => x.event_type);
}

const nowIso = () => new Date().toISOString();

function assertAdvisoryEnvelope(payload) {
  assert.equal(payload.canPlaceTrades, false, "canPlaceTrades must be false");
  assert.ok(typeof payload.mode === "string" && payload.mode.length > 0, "mode missing");
  assert.ok(typeof payload.generatedAtIso === "string" && payload.generatedAtIso.length > 0, "generatedAtIso missing");
}

// ── Builders ──────────────────────────────────────────────────────────────
const div = (over = {}) => ({
  strategyId: "S1",
  meanCorrelationWithoutMe01: 0.6,
  meanCorrelationWithMe01: 0.4,
  uniqueRegimeCoveragePct: 70,
  ...over,
});
const exec = (over = {}) => ({
  strategyId: "S1",
  ordersPerMinute: 10,
  meanSlippageBps: 5,
  cancellationRatio01: 0.2,
  liquidityImpactPct: 0.5,
  ...over,
});
const beh = (over = {}) => ({
  strategyId: "S1",
  observedHerdingScore01: 0.2,
  cascadeTriggerEvents: 0,
  observationWindowHours: 24,
  panicAmplificationScore01: 0.1,
  ...over,
});
const contribInputs = (over = {}) => ({
  strategyId: "S1",
  diversification: div(over.diversification),
  executionStress: exec({ ...over.executionStress, strategyId: "S1" }),
  behavioralStress: beh({ ...over.behavioralStress, strategyId: "S1" }),
});
const fragility = (over = {}) => ({
  meanCorrelation01: 0.4,
  topStrategyCapitalShare01: 0.25,
  recentFailureRate01: 0.1,
  liquidityDepthScore01: 0.7,
  agentDisagreementVariance01: 0.2,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_1 — Ecosystem fitness fuses contributions + fragility, blocks low
// ─────────────────────────────────────────────────────────────────────────
test("PE11_1: ecosystem fitness gate exposes blockers on degenerate ecosystem", async () => {
  // Healthy
  let r = await j("POST", "/ecosystem/fitness", {
    contributions: [contribInputs()],
    fragility: fragility(),
  });
  assert.equal(r.status, 200);
  assertAdvisoryEnvelope(r.data);
  assert.ok(r.data.report.fitness01 >= 0 && r.data.report.fitness01 <= 1);

  // Degenerate: high correlation, high concentration, herding cascades
  r = await j("POST", "/ecosystem/fitness", {
    contributions: [contribInputs({
      diversification: { meanCorrelationWithoutMe01: 0.4, meanCorrelationWithMe01: 0.95, uniqueRegimeCoveragePct: 5 },
      executionStress: { ordersPerMinute: 120, meanSlippageBps: 30, cancellationRatio01: 0.9, liquidityImpactPct: 8 },
      behavioralStress: { observedHerdingScore01: 0.95, cascadeTriggerEvents: 30, observationWindowHours: 24, panicAmplificationScore01: 0.9 },
    })],
    fragility: fragility({
      meanCorrelation01: 0.95, topStrategyCapitalShare01: 0.9,
      recentFailureRate01: 0.8, liquidityDepthScore01: 0.05, agentDisagreementVariance01: 0.9,
    }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.report.fitness01 < 0.4, `expected fitness < 0.4, got ${r.data.report.fitness01}`);
  assert.ok(r.data.report.blockers.length >= 1, "expected at least one blocker on degenerate ecosystem");
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_2 — Constitution refuses non-SANDBOX mutations
// ─────────────────────────────────────────────────────────────────────────
test("PE11_2: constitution refuses non-SANDBOX mutations and cites L_SANDBOX_ONLY_EVO", async () => {
  const safeForbidden = {
    riskPerTradePct: 1, stopLossPct: 0.5, leverage: 5,
    passedAllValidationStages: true, liveSampleCount: 10, liveExpectancyR: 0.2,
    memoryBlacklistedFingerprints: [], mutationFingerprint: "FP_OK",
  };
  const r = await j("POST", "/ecosystem/constitution/rule", {
    mutationFingerprint: "FP_OK",
    proposedFromMode: "LIVE",
    forbidden: safeForbidden,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ruling.permitted, false);
  assert.ok(r.data.ruling.citedLawIds.includes("L_SANDBOX_ONLY_EVO"));
  assert.ok((await vaultTypes()).includes("EE_CONSTITUTION_RULED"));
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_3 — Constitution refuses forbidden patterns
// ─────────────────────────────────────────────────────────────────────────
test("PE11_3: constitution refuses forbidden mutation patterns", async () => {
  const r = await j("POST", "/ecosystem/constitution/rule", {
    mutationFingerprint: "FP_BAD",
    proposedFromMode: "SANDBOX",
    forbidden: {
      riskPerTradePct: 5,            // > 3% cap
      stopLossPct: 0,                // no stop
      leverage: 50,                  // > 30x cap
      passedAllValidationStages: false,
      liveSampleCount: 200,
      liveExpectancyR: -0.5,         // neg expectancy with samples
      memoryBlacklistedFingerprints: ["FP_BAD"],
      mutationFingerprint: "FP_BAD",
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ruling.permitted, false);
  // Expect every forbidden pattern id to fire.
  const ids = new Set(r.data.ruling.matchedForbiddenPatternIds);
  for (const id of ["FP_RISK_OVER_CAP","FP_NO_STOP","FP_LEVERAGE_OVER","FP_VAL_SKIPPED","FP_NEG_EXPECTANCY","FP_MEMORY_KNOWN_BAD"]) {
    assert.ok(ids.has(id), `expected matched pattern ${id}, got ${[...ids].join(",")}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_4 — Ecosystem simulation is sandbox-only
// ─────────────────────────────────────────────────────────────────────────
test("PE11_4: ecosystem simulation refuses non-SANDBOX modes", async () => {
  const body = {
    mode: "LIVE",
    failure: {
      exposures: [
        { strategyId: "S1", capitalSharePct: 50, worstCaseLossPct: 20 },
        { strategyId: "S2", capitalSharePct: 50, worstCaseLossPct: 20 },
      ],
      failingStrategyIds: ["S1"],
      catastrophicAccountLossPct: 30,
    },
    disagreement: {
      signals: [
        { agentId: "A1", signal: 0.9, conviction01: 0.9 },
        { agentId: "A2", signal: -0.9, conviction01: 0.9 },
      ],
    },
    stress: {
      axes: [{ axis: "VOLATILITY_SHOCK", intensity01: 0.4 }],
      ecosystemFitness01: 0.7, reservesFraction01: 0.5,
    },
  };
  const r = await j("POST", "/ecosystem/sandbox/simulation", body);
  assert.equal(r.status, 200);
  assert.equal(r.data.result.passed, false);
  assert.ok(r.data.result.blockers.some((b) => /SANDBOX/.test(b)));
  assert.ok((await vaultTypes()).includes("EE_SANDBOX_SIMULATION_RAN"));
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_5 — Memory blacklist
// ─────────────────────────────────────────────────────────────────────────
test("PE11_5: mutation memory query returns blacklisted=true on COLLAPSED_LIVE history", async () => {
  const r = await j("POST", "/ecosystem/memory/mutation-query", {
    fingerprint: "FP_X",
    history: [
      { fingerprint: "FP_X", parentStrategyId: "S0", outcome: "COLLAPSED_LIVE", recordedAtIso: nowIso(), notes: "" },
      { fingerprint: "FP_Y", parentStrategyId: "S1", outcome: "GRADUATED",      recordedAtIso: nowIso(), notes: "" },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.decision.blacklisted, true);
  assert.equal(r.data.decision.matchingEntries.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_6 — Emergency veto rank guard
// ─────────────────────────────────────────────────────────────────────────
test("PE11_6: emergency veto is refused for low-rank authority and approved for KILL_SWITCH", async () => {
  let r = await j("POST", "/ecosystem/politics/emergency-veto", {
    invokingAuthority: "AGENT_REPUTATION", proposedAction: "halt_all", reason: "panic",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.decision.vetoApproved, false);
  assert.ok(r.data.decision.blockers[0].includes("not eligible to veto"));

  r = await j("POST", "/ecosystem/politics/emergency-veto", {
    invokingAuthority: "KILL_SWITCH", proposedAction: "halt_all", reason: "tail event",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.decision.vetoApproved, true);
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_7 — Vote weighting
// ─────────────────────────────────────────────────────────────────────────
test("PE11_7: governance vote weights by hierarchy rank × reputation", async () => {
  const r = await j("POST", "/ecosystem/politics/vote", {
    motion: "Promote variant V42",
    votes: [
      { voter: "RISK_GOVERNOR",   reputation01: 1.0, ballot: "YES" }, // huge weight
      { voter: "AGENT_REPUTATION", reputation01: 1.0, ballot: "NO"  }, // smallest weight
    ],
    approvalThreshold01: 0.66,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.passed, true,
    `RISK_GOVERNOR YES should outweigh AGENT_REPUTATION NO; tally=${JSON.stringify(r.data.result)}`);
  assert.ok(r.data.result.yesWeight > r.data.result.noWeight);
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_8/9/10 — Fraud detectors
// ─────────────────────────────────────────────────────────────────────────
test("PE11_8: fake-edge detector blocks on outlier-driven, OOS-collapsed sample", async () => {
  const r = await j("POST", "/ecosystem/fraud/fake-edge", {
    strategyId: "S1", sampleCount: 30,
    topTradeContributionToPnl01: 0.85,
    outOfSampleExpectancyR: -0.4, inSampleExpectancyR: 0.6,
    windowsTested: 10, windowsPassed: 2,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.suspicion01 >= 0.6, `suspicion=${r.data.result.suspicion01}`);
  assert.equal(r.data.result.block, true);
});

test("PE11_9: overfit detector blocks on train>>val gap with many params", async () => {
  const r = await j("POST", "/ecosystem/fraud/overfit", {
    variantId: "V1", parameterCount: 40,
    trainExpectancyR: 0.8,
    validationExpectancyRPerFold: [-0.2, -0.1, 0.05, -0.3, 0.4],
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.overfit01 >= 0.6, `overfit=${r.data.result.overfit01}`);
  assert.equal(r.data.result.block, true);
});

test("PE11_10: statistical illusion blocks on tiny noisy sample", async () => {
  const r = await j("POST", "/ecosystem/fraud/illusion", {
    strategyId: "S1", sampleCount: 25,
    meanReturnR: 0.05, stdevReturnR: 0.6, benchmarkReturnR: 0.04,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.illusion01 >= 0.6, `illusion=${r.data.result.illusion01}`);
  assert.equal(r.data.result.block, true);
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_11 — Monoculture flag
// ─────────────────────────────────────────────────────────────────────────
test("PE11_11: ecosystem balance flags monoculture when one species ≥ 60% share", async () => {
  // Classify a sample for vault coverage
  let r = await j("POST", "/ecosystem/species/classify", {
    strategyId: "S1",
    trendBias01: 0.9, meanReversionBias01: 0.1, breakoutBias01: 0.2,
    liquidityBias01: 0.1, volatilityBias01: 0.1, arbitrageBias01: 0.1,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.species, "TREND_FOLLOWER");

  r = await j("POST", "/ecosystem/species/balance", {
    populations: [
      { species: "TREND_FOLLOWER",   capitalSharePct: 75, count: 6 },
      { species: "MEAN_REVERSION",   capitalSharePct: 15, count: 1 },
      { species: "BREAKOUT",         capitalSharePct: 10, count: 1 },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.report.monocultureRisk, true);
  assert.ok(r.data.report.blockers.length >= 1);
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_12 — Civilization stress test
// ─────────────────────────────────────────────────────────────────────────
test("PE11_12: civilization stress test survives normal shock, fails catastrophic shock", async () => {
  let r = await j("POST", "/ecosystem/survival/civilization-stress", {
    shockMagnitudeSigma: 2, shockDurationDays: 1,
    reservesFraction01: 0.6, ecosystemFitness01: 0.7,
    recoveryLatencyDays: 3, catastrophicLossLimitPct: 30,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.survives, true);

  r = await j("POST", "/ecosystem/survival/civilization-stress", {
    shockMagnitudeSigma: 12, shockDurationDays: 30,
    reservesFraction01: 0.05, ecosystemFitness01: 0.1,
    recoveryLatencyDays: 60, catastrophicLossLimitPct: 30,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.survives, false);
  assert.equal(r.data.result.marginOfSafety01, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_13 — Survival composite
// ─────────────────────────────────────────────────────────────────────────
test("PE11_13: ecosystem survival composite drops below 0.3 in degenerate scenario with blockers", async () => {
  const r = await j("POST", "/ecosystem/survival/score", {
    ecosystemFitness01: 0.05, systemicFragility01: 0.95,
    stressTest: {
      shockMagnitudeSigma: 12, shockDurationDays: 30,
      reservesFraction01: 0.05, ecosystemFitness01: 0.1,
      recoveryLatencyDays: 60, catastrophicLossLimitPct: 30,
    },
    recovery: {
      currentDrawdownPct: 25,
      reserveReplenishmentRatePctPerDay: 0,
      survivingStrategyCount: 1, validationBacklog: 80,
      meanStrategyExpectancyR: -0.3,
    },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.report.survival01 < 0.3, `survival=${r.data.report.survival01}`);
  assert.ok(r.data.report.blockers.length >= 1);
});

// ─────────────────────────────────────────────────────────────────────────
// PE11_14 — Every advisory route returns canPlaceTrades:false
// PE11_15 — Vault entries (EE_*) emitted for state changes
// ─────────────────────────────────────────────────────────────────────────
test("PE11_14 + PE11_15: every Phase 11 route is advisory and emits EE_* vault events", async () => {
  // Hit a representative endpoint per module.
  const results = await Promise.all([
    j("POST", "/ecosystem/contribution-score", contribInputs()),
    j("POST", "/ecosystem/systemic-fragility", fragility()),
    j("POST", "/ecosystem/fitness", { contributions: [contribInputs()], fragility: fragility() }),
    j("POST", "/ecosystem/constitution/rule", {
      mutationFingerprint: "FP_OK", proposedFromMode: "SANDBOX",
      forbidden: {
        riskPerTradePct: 1, stopLossPct: 0.5, leverage: 5,
        passedAllValidationStages: true, liveSampleCount: 10, liveExpectancyR: 0.2,
        memoryBlacklistedFingerprints: [], mutationFingerprint: "FP_OK",
      },
    }),
    j("POST", "/ecosystem/sandbox/correlated-failure", {
      exposures: [{ strategyId: "S1", capitalSharePct: 100, worstCaseLossPct: 5 }],
      failingStrategyIds: ["S1"], catastrophicAccountLossPct: 30,
    }),
    j("POST", "/ecosystem/sandbox/mass-disagreement", {
      signals: [
        { agentId: "A1", signal: 0.5, conviction01: 0.5 },
        { agentId: "A2", signal: 0.3, conviction01: 0.5 },
      ],
    }),
    j("POST", "/ecosystem/sandbox/stress", {
      axes: [{ axis: "VOLATILITY_SHOCK", intensity01: 0.3 }],
      ecosystemFitness01: 0.7, reservesFraction01: 0.6,
    }),
    j("POST", "/ecosystem/sandbox/simulation", {
      mode: "SANDBOX",
      failure: {
        exposures: [{ strategyId: "S1", capitalSharePct: 100, worstCaseLossPct: 5 }],
        failingStrategyIds: ["S1"], catastrophicAccountLossPct: 30,
      },
      disagreement: {
        signals: [{ agentId: "A1", signal: 0.2, conviction01: 0.2 }, { agentId: "A2", signal: 0.3, conviction01: 0.2 }],
      },
      stress: {
        axes: [{ axis: "VOLATILITY_SHOCK", intensity01: 0.2 }],
        ecosystemFitness01: 0.7, reservesFraction01: 0.6,
      },
    }),
    j("POST", "/ecosystem/memory/mutation-query", { fingerprint: "FP_X", history: [] }),
    j("POST", "/ecosystem/memory/collapse-history", { history: [], nowIso: nowIso() }),
    j("POST", "/ecosystem/memory/adaptation-summary", { strategyId: "S1", history: [] }),
    j("POST", "/ecosystem/politics/authority-conflict", {
      competing: ["RISK_GOVERNOR", "AGENT_REPUTATION"],
    }),
    j("POST", "/ecosystem/politics/emergency-veto", {
      invokingAuthority: "RISK_GOVERNOR", proposedAction: "freeze", reason: "test",
    }),
    j("POST", "/ecosystem/politics/vote", {
      motion: "M1",
      votes: [
        { voter: "RISK_GOVERNOR", reputation01: 0.9, ballot: "YES" },
        { voter: "STRATEGY_REPUTATION", reputation01: 0.5, ballot: "NO" },
      ],
    }),
    j("POST", "/ecosystem/fraud/fake-edge", {
      strategyId: "S1", sampleCount: 500,
      topTradeContributionToPnl01: 0.2,
      outOfSampleExpectancyR: 0.3, inSampleExpectancyR: 0.35,
      windowsTested: 10, windowsPassed: 9,
    }),
    j("POST", "/ecosystem/fraud/overfit", {
      variantId: "V1", parameterCount: 5,
      trainExpectancyR: 0.3,
      validationExpectancyRPerFold: [0.25, 0.28, 0.30, 0.27],
    }),
    j("POST", "/ecosystem/fraud/illusion", {
      strategyId: "S1", sampleCount: 800,
      meanReturnR: 0.3, stdevReturnR: 0.1, benchmarkReturnR: 0,
    }),
    j("POST", "/ecosystem/species/classify", {
      strategyId: "S1",
      trendBias01: 0.8, meanReversionBias01: 0.1, breakoutBias01: 0.1,
      liquidityBias01: 0.1, volatilityBias01: 0.1, arbitrageBias01: 0.1,
    }),
    j("POST", "/ecosystem/species/extinction-risk", {
      species: "TREND_FOLLOWER", populationCount: 5,
      meanExpectancyR: 0.2, recentDrawdownPct: 4, regimeHostility01: 0.2,
    }),
    j("POST", "/ecosystem/species/adaptation-capacity", {
      species: "TREND_FOLLOWER", historicalSuccessRate01: 0.6,
      parameterFlexibility01: 0.5, validationDepth01: 0.7, attemptCount: 25,
    }),
    j("POST", "/ecosystem/species/balance", {
      populations: [
        { species: "TREND_FOLLOWER", capitalSharePct: 40, count: 3 },
        { species: "MEAN_REVERSION", capitalSharePct: 30, count: 2 },
        { species: "BREAKOUT",       capitalSharePct: 30, count: 2 },
      ],
    }),
    j("POST", "/ecosystem/survival/civilization-stress", {
      shockMagnitudeSigma: 2, shockDurationDays: 1,
      reservesFraction01: 0.6, ecosystemFitness01: 0.7,
      recoveryLatencyDays: 3, catastrophicLossLimitPct: 30,
    }),
    j("POST", "/ecosystem/survival/recovery", {
      currentDrawdownPct: 5,
      reserveReplenishmentRatePctPerDay: 0.5,
      survivingStrategyCount: 5, validationBacklog: 3,
      meanStrategyExpectancyR: 0.3,
    }),
    j("POST", "/ecosystem/survival/score", {
      ecosystemFitness01: 0.7, systemicFragility01: 0.3,
      stressTest: {
        shockMagnitudeSigma: 2, shockDurationDays: 1,
        reservesFraction01: 0.6, ecosystemFitness01: 0.7,
        recoveryLatencyDays: 3, catastrophicLossLimitPct: 30,
      },
      recovery: {
        currentDrawdownPct: 5, reserveReplenishmentRatePctPerDay: 0.5,
        survivingStrategyCount: 5, validationBacklog: 3,
        meanStrategyExpectancyR: 0.3,
      },
    }),
  ]);

  for (const r of results) {
    assert.equal(r.status, 200, `non-200 from a phase-11 route: ${JSON.stringify(r)}`);
    assertAdvisoryEnvelope(r.data);
  }

  const types = await vaultTypes();
  // Spot-check a handful of EE_* events that must have fired.
  for (const t of [
    "EE_CONTRIBUTION_SCORED", "EE_FRAGILITY_EVALUATED", "EE_FITNESS_EVALUATED",
    "EE_CONSTITUTION_RULED", "EE_SANDBOX_SIMULATION_RAN",
    "EE_MUTATION_MEMORY_QUERIED", "EE_AUTHORITY_RESOLVED",
    "EE_GOVERNANCE_VOTE_TALLIED", "EE_FAKE_EDGE_EVALUATED",
    "EE_OVERFIT_EVALUATED", "EE_ILLUSION_EVALUATED",
    "EE_SPECIES_CLASSIFIED", "EE_ECOSYSTEM_BALANCE_EVALUATED",
    "EE_CIVILIZATION_STRESS_RAN", "EE_SYSTEMIC_RECOVERY_EVALUATED",
    "EE_ECOSYSTEM_SURVIVAL_SCORED",
  ]) {
    assert.ok(types.includes(t), `missing vault event ${t}; have: ${[...new Set(types)].join(",")}`);
  }
});
