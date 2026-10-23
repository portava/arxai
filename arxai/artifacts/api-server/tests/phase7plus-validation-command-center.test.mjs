// ═══════════════════════════════════════════════════════════════════════════
// Phase 7+ — Validation Command Center tests.
//
// Verifies the seven institutional-grade dimensions: edge quality, risk
// survival, statistical reliability, market regime fit, execution reality,
// trader behavior safety, edge durability — plus the master Command Center
// decision and the vault-ready audit report.
//
// All endpoints advisory (canPlaceTrades:false, mode:"VALIDATION_PIPELINE").
// Every decision must be vault-logged.
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
beforeEach(async () => {
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
});
async function vaultTypes() {
  const r = await pool.query(`SELECT event_type FROM audit_events`);
  return r.rows.map(x => x.event_type);
}
const ISO = "2026-05-10T11:00:00.000Z";
const CID = "cand-cc";

// ── Builders for healthy / unhealthy candidates ────────────────────────────
function healthyStatSig() { return {
  candidateId: CID, trades: 250, winRate01: 0.55, avgWinR: 1.4, avgLossR: 1.0,
};}
function healthyOOS() { return {
  candidateId: CID,
  inSampleExpectancyR: 0.20, outOfSampleExpectancyR: 0.18,
  inSampleTrades: 200, outOfSampleTrades: 100,
};}
function healthyMC() {
  // 50 mostly-positive R outcomes
  const tradeRs = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? -0.8 : 1.0));
  return {
    candidateId: CID, tradeRs, simulations: 200, seed: 42,
    slippageJitterR: 0.03, spreadJitterR: 0.02, latencyDelayJitter01: 0.01,
  };
}
function healthyRegimeFit() { return {
  candidateId: CID,
  byRegime: {
    TRENDING: { trades: 80, expectancyR: 0.22, winRate01: 0.58 },
    CHOPPY:   { trades: 60, expectancyR: 0.10, winRate01: 0.52 },
    HIGH_VOL: { trades: 50, expectancyR: 0.15, winRate01: 0.55 },
    SESSION_NY: { trades: 40, expectancyR: 0.12, winRate01: 0.55 },
  },
};}
function healthyStress() { return {
  candidateId: CID, baselineExpectancyR: 0.20,
  scenarios: [
    { kind: "DOUBLE_SLIPPAGE", perturbedExpectancyR: 0.14 },
    { kind: "BROKER_OUTAGE",   perturbedExpectancyR: 0.12 },
    { kind: "NEWS_SHOCK",      perturbedExpectancyR: 0.11 },
  ],
};}
function healthyExecReality() { return {
  candidateId: CID, expectancyR: 0.20,
  slippageImpactR: 0.02, spreadImpactR: 0.01, latencyImpactR: 0.005,
  fillProbability01: 0.95, implementationShortfallR: 0.04, brokerReliability01: 0.97,
};}
function healthyTraderBehavior() { return {
  candidateId: CID,
  baselineExpectancyR: 0.20,
  afterLossExpectancyR: 0.18, afterOverrideExpectancyR: 0.18,
  overtradingScore01: 0.2, disciplineImpactScore01: 0.2,
  cognitiveRiskSensitivity01: 0.3,
};}
function healthyEdgeDurability() { return {
  candidateId: CID,
  recentExpectancyR: 0.19, baselineExpectancyR: 0.20,
  regimeDriftScore01: 0.1,
  falseApprovalTrendDeltaPct01: 0.05,
  falseBlockTrendDeltaPct01: 0.05,
  calibrationDriftDeltaPct01: 0.05,
};}

// ── Per-engine endpoint tests ──────────────────────────────────────────────

test("CC1 statistical-significance PASS for sound expectancy + n=250", async () => {
  const r = await j("POST", "/validation/cc/statistical-significance", healthyStatSig());
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "VALIDATION_PIPELINE");
  assert.ok(r.data.result.score01 >= 0.5);
  assert.ok(r.data.result.expectancyR > 0);
  assert.ok(r.data.result.confidenceLow95R > 0,
    "lower 95% CI should be > 0 for an actually significant edge");
  assert.ok((await vaultTypes()).includes("VALIDATION_CC_STATISTICAL_SIGNIFICANCE_ASSESSED"));
});

test("CC2 statistical-significance flags overfitting on tiny n + extreme winRate", async () => {
  const r = await j("POST", "/validation/cc/statistical-significance", {
    candidateId: CID, trades: 12, winRate01: 0.92, avgWinR: 2.5, avgLossR: 1.0,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.overfittingRiskHint01 > 0.3);
  assert.ok(r.data.result.sampleAdequacy01 < 0.1);
});

test("CC3 out-of-sample PASS when oos≈is", async () => {
  const r = await j("POST", "/validation/cc/out-of-sample", healthyOOS());
  assert.equal(r.data.result.oosPassing, true);
  assert.ok(r.data.result.score01 >= 0.6);
  assert.ok(r.data.result.overfittingProbability01 < 0.3);
});

test("CC4 out-of-sample FAIL when oos collapses (overfitting)", async () => {
  const r = await j("POST", "/validation/cc/out-of-sample", {
    candidateId: CID,
    inSampleExpectancyR: 0.50, outOfSampleExpectancyR: -0.05,
    inSampleTrades: 200, outOfSampleTrades: 100,
  });
  assert.equal(r.data.result.oosPassing, false);
  assert.ok(r.data.result.overfittingProbability01 >= 0.5,
    `expected overfit≥0.5, got ${r.data.result.overfittingProbability01}`);
  assert.equal(r.data.result.oosNet, "NEGATIVE");
});

test("CC5 monte-carlo PASS for healthy, deterministic with seed", async () => {
  const r = await j("POST", "/validation/cc/monte-carlo", healthyMC());
  assert.equal(r.data.result.simulations, 200);
  assert.ok(r.data.result.score01 > 0,
    `score should be > 0 for profitable trades; got ${r.data.result.score01}`);
  assert.ok(r.data.result.ruinProbability01 < 0.5);
  // Determinism: same seed → same median final R.
  const r2 = await j("POST", "/validation/cc/monte-carlo", healthyMC());
  assert.equal(r.data.result.medianFinalR, r2.data.result.medianFinalR);
});

test("CC6 monte-carlo high ruin probability for losing strategy", async () => {
  const losing = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 1.0 : -0.6));
  const r = await j("POST", "/validation/cc/monte-carlo", {
    candidateId: CID, tradeRs: losing, simulations: 200, seed: 7,
  });
  assert.ok(r.data.result.score01 < 0.6);
  assert.ok(r.data.result.meanFinalR < 0);
});

test("CC7 regime-fit BROAD when all evaluated regimes pass", async () => {
  const r = await j("POST", "/validation/cc/regime-fit", healthyRegimeFit());
  assert.equal(r.data.result.label, "BROAD");
  assert.equal(r.data.result.restrictions.length, 0);
  assert.ok(r.data.result.score01 >= 0.6);
});

test("CC8 regime-fit REGIME_SPECIFIC produces ONLY_* restriction", async () => {
  const r = await j("POST", "/validation/cc/regime-fit", {
    candidateId: CID,
    byRegime: {
      TRENDING: { trades: 80, expectancyR: 0.25, winRate01: 0.58 },
      CHOPPY:   { trades: 60, expectancyR: -0.10, winRate01: 0.45 },
      HIGH_VOL: { trades: 50, expectancyR: -0.05, winRate01: 0.48 },
    },
  });
  assert.ok(["REGIME_SPECIFIC", "NARROW"].includes(r.data.result.label));
  assert.ok(r.data.result.restrictions.includes("ONLY_TRENDING"));
});

test("CC9 stress passes when degradations are within threshold", async () => {
  const r = await j("POST", "/validation/cc/stress", healthyStress());
  assert.ok(r.data.result.score01 >= 0.5);
  assert.equal(r.data.result.scenariosFailed.length, 0);
});

test("CC10 stress reports worst scenario when one collapses", async () => {
  const r = await j("POST", "/validation/cc/stress", {
    candidateId: CID, baselineExpectancyR: 0.20,
    scenarios: [
      { kind: "DOUBLE_SLIPPAGE", perturbedExpectancyR: 0.16 },
      { kind: "FLASH_CRASH",     perturbedExpectancyR: -0.10 },
    ],
  });
  assert.equal(r.data.result.worstScenarioKind, "FLASH_CRASH");
  assert.ok(r.data.result.scenariosFailed.includes("FLASH_CRASH"));
});

test("CC11 execution-reality flags BROKER_DEGRADATION_RISK on heavy shortfall", async () => {
  const r = await j("POST", "/validation/cc/execution-reality", {
    candidateId: CID, expectancyR: 0.20,
    slippageImpactR: 0.05, spreadImpactR: 0.05, latencyImpactR: 0.04,
    fillProbability01: 0.7, implementationShortfallR: 0.15,
    brokerReliability01: 0.85,
  });
  assert.ok(r.data.result.restrictions.includes("BROKER_DEGRADATION_RISK"));
  assert.ok(r.data.result.restrictions.includes("LIMIT_TO_LIQUID_HOURS"));
  assert.ok(r.data.result.restrictions.includes("REQUIRES_REDUNDANT_BROKER"));
  assert.ok(r.data.result.netExpectancyR < 0.20);
});

test("CC12 trader-behavior flags REQUIRES_LOSS_COOLDOWN on tilt", async () => {
  const r = await j("POST", "/validation/cc/trader-behavior", {
    candidateId: CID, baselineExpectancyR: 0.20,
    afterLossExpectancyR: 0.05, afterOverrideExpectancyR: 0.18,
    overtradingScore01: 0.3, disciplineImpactScore01: 0.4,
    cognitiveRiskSensitivity01: 0.3,
  });
  assert.ok(r.data.result.restrictions.includes("REQUIRES_LOSS_COOLDOWN"));
  assert.ok(r.data.result.afterLossDegradationPct01 >= 0.5);
});

test("CC13 edge-durability STABLE for recent≈baseline", async () => {
  const r = await j("POST", "/validation/cc/edge-durability", healthyEdgeDurability());
  assert.equal(r.data.result.decayLevel, "STABLE");
  assert.ok(r.data.result.score01 >= 0.7);
});

test("CC14 edge-durability SEVERE for major regression", async () => {
  const r = await j("POST", "/validation/cc/edge-durability", {
    candidateId: CID,
    recentExpectancyR: -0.05, baselineExpectancyR: 0.20,
    regimeDriftScore01: 0.8,
    falseApprovalTrendDeltaPct01: 0.5,
    falseBlockTrendDeltaPct01: 0.4,
    calibrationDriftDeltaPct01: 0.5,
  });
  assert.equal(r.data.result.decayLevel, "SEVERE");
  assert.ok(r.data.result.score01 <= 0.4);
});

test("CC15 confidence weakest dimension is identified correctly", async () => {
  const r = await j("POST", "/validation/cc/confidence", {
    candidateId: CID,
    statisticalConfidenceScore01: 0.9,
    regimeFitScore01: 0.2,    // weakest
    edgeDurabilityScore01: 0.85,
    monteCarloRobustness01: 0.8,
    outOfSampleScore01: 0.85,
    sampleSize: 250,
  });
  assert.equal(r.data.result.weakestComponent, "regimeFit");
  assert.ok(r.data.result.score01 >= 0.5);
});

test("CC16 scorecard PASS when every dimension ≥ 0.6", async () => {
  const r = await j("POST", "/validation/cc/scorecard", {
    candidateId: CID,
    edgeQuality01: 0.85, riskSurvival01: 0.80,
    statisticalReliability01: 0.75, marketRegimeFit01: 0.70,
    executionReality01: 0.78, traderBehaviorSafety01: 0.72,
    edgeDurability01: 0.82,
  });
  assert.equal(r.data.result.passed, true);
  assert.equal(r.data.result.dimensionsPassed, 7);
});

test("CC17 scorecard FAIL identifies failing dimensions", async () => {
  const r = await j("POST", "/validation/cc/scorecard", {
    candidateId: CID,
    edgeQuality01: 0.85, riskSurvival01: 0.30,           // FAIL
    statisticalReliability01: 0.75, marketRegimeFit01: 0.70,
    executionReality01: 0.40,                             // FAIL
    traderBehaviorSafety01: 0.72, edgeDurability01: 0.82,
  });
  assert.equal(r.data.result.passed, false);
  assert.deepEqual(
    r.data.result.failingDimensions.sort(),
    ["executionReality", "riskSurvival"].sort(),
  );
});

// ── Decision orchestrator tests ────────────────────────────────────────────

async function buildHealthySubResults() {
  const stat = (await j("POST", "/validation/cc/statistical-significance", healthyStatSig())).data.result;
  const oos  = (await j("POST", "/validation/cc/out-of-sample",            healthyOOS())).data.result;
  const mc   = (await j("POST", "/validation/cc/monte-carlo",              healthyMC())).data.result;
  const reg  = (await j("POST", "/validation/cc/regime-fit",               healthyRegimeFit())).data.result;
  const exr  = (await j("POST", "/validation/cc/execution-reality",        healthyExecReality())).data.result;
  const tb   = (await j("POST", "/validation/cc/trader-behavior",          healthyTraderBehavior())).data.result;
  const ed   = (await j("POST", "/validation/cc/edge-durability",          healthyEdgeDurability())).data.result;
  const sc   = (await j("POST", "/validation/cc/scorecard", {
    candidateId: CID,
    edgeQuality01: 0.85, riskSurvival01: 0.80,
    statisticalReliability01: stat.score01, marketRegimeFit01: reg.score01,
    executionReality01: exr.score01, traderBehaviorSafety01: tb.score01,
    edgeDurability01: ed.score01,
  })).data.result;
  return { stat, oos, mc, reg, exr, tb, ed, sc };
}

test("CC18 decision PROMOTE when all gates pass and ready=true", async () => {
  const sub = await buildHealthySubResults();
  const r = await j("POST", "/validation/cc/decision", {
    candidateId: CID,
    currentStage: "PAPER_TRADING",
    liveReadinessScore01: 0.9, ready: true, frozen: false,
    controlTowerAuthorized: true,
    scorecard: sub.sc, edgeDurability: sub.ed, monteCarlo: sub.mc,
    outOfSample: sub.oos, executionReality: sub.exr,
    traderBehavior: sub.tb, regimeFit: sub.reg,
    statisticalSignificance: sub.stat,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.decision, "PROMOTE");
  assert.equal(r.data.result.promotionDecision, "PROMOTE");
  assert.equal(r.data.result.recommendedStage, "MICRO_LOT_LIVE");
  assert.equal(r.data.result.blockers.length, 0);
  assert.ok((await vaultTypes()).includes("VALIDATION_CC_DECISION"));
});

test("CC19 decision DEMOTE when scorecard fails", async () => {
  const sub = await buildHealthySubResults();
  const badSC = (await j("POST", "/validation/cc/scorecard", {
    candidateId: CID,
    edgeQuality01: 0.85, riskSurvival01: 0.20,
    statisticalReliability01: 0.20, marketRegimeFit01: 0.70,
    executionReality01: 0.78, traderBehaviorSafety01: 0.72, edgeDurability01: 0.82,
  })).data.result;
  const r = await j("POST", "/validation/cc/decision", {
    candidateId: CID, currentStage: "MICRO_LOT_LIVE",
    liveReadinessScore01: 0.85, ready: true, frozen: false,
    controlTowerAuthorized: true,
    scorecard: badSC, edgeDurability: sub.ed, monteCarlo: sub.mc,
    outOfSample: sub.oos, executionReality: sub.exr,
    traderBehavior: sub.tb, regimeFit: sub.reg,
    statisticalSignificance: sub.stat,
  });
  assert.equal(r.data.result.decision, "DEMOTE");
  assert.equal(r.data.result.recommendedStage, "PAPER_TRADING");
  assert.ok(r.data.result.blockers.some(b => /SCORECARD_FAILED/.test(b)));
});

test("CC20 decision RETIRE on SEVERE edge decay regardless of scorecard", async () => {
  const sub = await buildHealthySubResults();
  const severeED = (await j("POST", "/validation/cc/edge-durability", {
    candidateId: CID,
    recentExpectancyR: -0.05, baselineExpectancyR: 0.20,
    regimeDriftScore01: 0.85,
    falseApprovalTrendDeltaPct01: 0.6,
    falseBlockTrendDeltaPct01: 0.5,
    calibrationDriftDeltaPct01: 0.6,
  })).data.result;
  const r = await j("POST", "/validation/cc/decision", {
    candidateId: CID, currentStage: "LIMITED_LIVE",
    liveReadinessScore01: 0.9, ready: true, frozen: false,
    controlTowerAuthorized: true,
    scorecard: sub.sc, edgeDurability: severeED, monteCarlo: sub.mc,
    outOfSample: sub.oos, executionReality: sub.exr,
    traderBehavior: sub.tb, regimeFit: sub.reg,
    statisticalSignificance: sub.stat,
  });
  assert.equal(r.data.result.decision, "RETIRE");
  assert.equal(r.data.result.demotionDecision, "RETIRE");
  assert.equal(r.data.result.recommendedStage, "RESEARCH");
});

test("CC21 decision FREEZE when frozen=true (no transitions)", async () => {
  const sub = await buildHealthySubResults();
  const r = await j("POST", "/validation/cc/decision", {
    candidateId: CID, currentStage: "MICRO_LOT_LIVE",
    liveReadinessScore01: 0.9, ready: true, frozen: true,
    controlTowerAuthorized: true,
    scorecard: sub.sc, edgeDurability: sub.ed, monteCarlo: sub.mc,
    outOfSample: sub.oos, executionReality: sub.exr,
    traderBehavior: sub.tb, regimeFit: sub.reg,
    statisticalSignificance: sub.stat,
  });
  assert.equal(r.data.result.decision, "FREEZE");
  assert.equal(r.data.result.promotionDecision, "DENY");
  assert.ok(r.data.result.blockers.includes("FROZEN_BY_RISK_GOVERNOR"));
});

test("CC22 decision RESTRICT for regime-specific edge", async () => {
  const sub = await buildHealthySubResults();
  const narrowReg = (await j("POST", "/validation/cc/regime-fit", {
    candidateId: CID,
    byRegime: {
      TRENDING: { trades: 80, expectancyR: 0.25, winRate01: 0.58 },
      CHOPPY:   { trades: 60, expectancyR: -0.10, winRate01: 0.45 },
      HIGH_VOL: { trades: 50, expectancyR: -0.05, winRate01: 0.48 },
    },
  })).data.result;
  const r = await j("POST", "/validation/cc/decision", {
    candidateId: CID, currentStage: "PAPER_TRADING",
    liveReadinessScore01: 0.85, ready: true, frozen: false,
    controlTowerAuthorized: true,
    scorecard: sub.sc, edgeDurability: sub.ed, monteCarlo: sub.mc,
    outOfSample: sub.oos, executionReality: sub.exr,
    traderBehavior: sub.tb, regimeFit: narrowReg,
    statisticalSignificance: sub.stat,
  });
  assert.equal(r.data.result.decision, "RESTRICT");
  assert.ok(r.data.result.restrictions.includes("ONLY_TRENDING"));
});

test("CC22b decision RESTRICT when BROAD regime but execution/trader restrictions exist", async () => {
  // Architect-flagged invariant: passed risk gates with non-empty
  // restrictions must NEVER PROMOTE, even if regime label is BROAD.
  const sub = await buildHealthySubResults();
  const restrictedExec = (await j("POST", "/validation/cc/execution-reality", {
    candidateId: CID, expectancyR: 0.20,
    slippageImpactR: 0.02, spreadImpactR: 0.01, latencyImpactR: 0.005,
    fillProbability01: 0.70,            // → LIMIT_TO_LIQUID_HOURS
    implementationShortfallR: 0.04, brokerReliability01: 0.97,
  })).data.result;
  assert.equal(sub.reg.label, "BROAD");
  assert.ok(restrictedExec.restrictions.includes("LIMIT_TO_LIQUID_HOURS"));
  const r = await j("POST", "/validation/cc/decision", {
    candidateId: CID, currentStage: "PAPER_TRADING",
    liveReadinessScore01: 0.9, ready: true, frozen: false,
    controlTowerAuthorized: true,
    scorecard: sub.sc, edgeDurability: sub.ed, monteCarlo: sub.mc,
    outOfSample: sub.oos, executionReality: restrictedExec,
    traderBehavior: sub.tb, regimeFit: sub.reg,
    statisticalSignificance: sub.stat,
  });
  assert.equal(r.data.result.decision, "RESTRICT");
  assert.notEqual(r.data.result.promotionDecision, "PROMOTE");
  assert.ok(r.data.result.restrictions.includes("LIMIT_TO_LIQUID_HOURS"));
});

test("CC23 decision HOLD when control tower NOT authorized", async () => {
  const sub = await buildHealthySubResults();
  const r = await j("POST", "/validation/cc/decision", {
    candidateId: CID, currentStage: "PAPER_TRADING",
    liveReadinessScore01: 0.9, ready: true, frozen: false,
    controlTowerAuthorized: false,
    scorecard: sub.sc, edgeDurability: sub.ed, monteCarlo: sub.mc,
    outOfSample: sub.oos, executionReality: sub.exr,
    traderBehavior: sub.tb, regimeFit: sub.reg,
    statisticalSignificance: sub.stat,
  });
  assert.equal(r.data.result.decision, "HOLD");
  assert.ok(r.data.result.blockers.includes("CONTROL_TOWER_NOT_AUTHORIZED"));
});

// ── Audit Report ───────────────────────────────────────────────────────────

test("CC24 audit-report contains timeline + decision + plain English", async () => {
  const sub = await buildHealthySubResults();
  const dec = (await j("POST", "/validation/cc/decision", {
    candidateId: CID, currentStage: "PAPER_TRADING",
    liveReadinessScore01: 0.9, ready: true, frozen: false,
    controlTowerAuthorized: true,
    scorecard: sub.sc, edgeDurability: sub.ed, monteCarlo: sub.mc,
    outOfSample: sub.oos, executionReality: sub.exr,
    traderBehavior: sub.tb, regimeFit: sub.reg,
    statisticalSignificance: sub.stat,
  })).data.result;
  const rep = await j("POST", "/validation/cc/audit-report", {
    candidateId: CID, asOfIso: ISO,
    command: dec, scorecard: sub.sc,
    monteCarlo: sub.mc, outOfSample: sub.oos,
    edgeDurability: sub.ed, regimeFit: sub.reg,
    executionReality: sub.exr, traderBehavior: sub.tb,
    statisticalSignificance: sub.stat,
  });
  assert.equal(rep.status, 200);
  const r = rep.data.report;
  assert.equal(r.candidateId, CID);
  assert.equal(r.asOfIso, ISO);
  assert.equal(r.decision, "PROMOTE");
  assert.equal(r.recommendedStage, "MICRO_LOT_LIVE");
  assert.ok(r.timeline.length >= 8); // 7 sub-engines + scorecard summary
  assert.ok(r.timeline.some(t => t.check === "SCORECARD_OVERALL"));
  assert.ok(r.timeline.some(t => t.check === "STATISTICAL_SIGNIFICANCE"));
  assert.ok(r.plainEnglishExplanation.length > 0);
  assert.ok(typeof r.scoreSummary.scorecard === "number");
  assert.ok((await vaultTypes()).includes("VALIDATION_CC_AUDIT_REPORT_GENERATED"));
});

// ── Pipeline integration tests for the 4 new stages ────────────────────────

async function newState(stage) {
  const init = await j("POST", "/validation/init-candidate", {
    candidate: {
      candidateId: CID, kind: "STRATEGY",
      refId: "strat-cc", versionId: "1.0.0",
      introducedAtIso: ISO,
    },
    recordedAtIso: ISO,
  });
  assert.equal(init.status, 200);
  const s = init.data.state;
  s.currentStage = stage;
  return s;
}

test("CC25 pipeline can advance through every new stage in single steps", async () => {
  // OUT_OF_SAMPLE_TEST → WALK_FORWARD
  let state = await newState("OUT_OF_SAMPLE_TEST");
  let r = await j("POST", "/validation/promote", {
    state, recordedAtIso: ISO, controlTowerAuthorized: true,
  });
  assert.equal(r.data.promotion.toStage, "WALK_FORWARD");

  // WALK_FORWARD → MONTE_CARLO_STRESS_TEST
  state = await newState("WALK_FORWARD");
  r = await j("POST", "/validation/promote", {
    state, recordedAtIso: ISO, controlTowerAuthorized: true,
  });
  assert.equal(r.data.promotion.toStage, "MONTE_CARLO_STRESS_TEST");

  // MONTE_CARLO_STRESS_TEST → REGIME_SPECIFIC_TEST
  state = await newState("MONTE_CARLO_STRESS_TEST");
  r = await j("POST", "/validation/promote", {
    state, recordedAtIso: ISO, controlTowerAuthorized: true,
  });
  assert.equal(r.data.promotion.toStage, "REGIME_SPECIFIC_TEST");

  // REGIME_SPECIFIC_TEST → EXECUTION_REALITY_TEST
  state = await newState("REGIME_SPECIFIC_TEST");
  r = await j("POST", "/validation/promote", {
    state, recordedAtIso: ISO, controlTowerAuthorized: true,
  });
  assert.equal(r.data.promotion.toStage, "EXECUTION_REALITY_TEST");

  // EXECUTION_REALITY_TEST → SHADOW_MODE
  state = await newState("EXECUTION_REALITY_TEST");
  r = await j("POST", "/validation/promote", {
    state, recordedAtIso: ISO, controlTowerAuthorized: true,
  });
  assert.equal(r.data.promotion.toStage, "SHADOW_MODE");
});

// ── Invariants ─────────────────────────────────────────────────────────────

test("CCZ phase7+ never emits TRADE_*/MODE_*/SIGNAL_*; canPlaceTrades:false everywhere", async () => {
  await j("POST", "/validation/cc/statistical-significance", healthyStatSig());
  await j("POST", "/validation/cc/out-of-sample",            healthyOOS());
  await j("POST", "/validation/cc/monte-carlo",              healthyMC());
  await j("POST", "/validation/cc/regime-fit",               healthyRegimeFit());
  await j("POST", "/validation/cc/stress",                   healthyStress());
  await j("POST", "/validation/cc/execution-reality",        healthyExecReality());
  await j("POST", "/validation/cc/trader-behavior",          healthyTraderBehavior());
  await j("POST", "/validation/cc/edge-durability",          healthyEdgeDurability());
  await j("POST", "/validation/cc/scorecard", {
    candidateId: CID,
    edgeQuality01: 0.8, riskSurvival01: 0.8,
    statisticalReliability01: 0.8, marketRegimeFit01: 0.7,
    executionReality01: 0.8, traderBehaviorSafety01: 0.7, edgeDurability01: 0.8,
  });
  await j("POST", "/validation/cc/confidence", {
    candidateId: CID,
    statisticalConfidenceScore01: 0.8, regimeFitScore01: 0.7,
    edgeDurabilityScore01: 0.8, monteCarloRobustness01: 0.7,
    outOfSampleScore01: 0.8, sampleSize: 200,
  });
  const types = await vaultTypes();
  for (const t of types) {
    assert.ok(!/^TRADE_/.test(t),  `leaked TRADE_*: ${t}`);
    assert.ok(!/^MODE_/.test(t),   `leaked MODE_*: ${t}`);
    assert.ok(!/^SIGNAL_/.test(t), `leaked SIGNAL_*: ${t}`);
  }
  // Every CC vault event must be prefixed VALIDATION_CC_
  const ccTypes = types.filter(t => t.startsWith("VALIDATION_CC_"));
  assert.ok(ccTypes.length >= 9, `expected ≥9 VALIDATION_CC_* events, got ${ccTypes.length}`);
});

test("CCZ2 phase7+ invalid bodies return 400", async () => {
  const a = await j("POST", "/validation/cc/statistical-significance", { candidateId: CID });
  assert.equal(a.status, 400);
  const b = await j("POST", "/validation/cc/monte-carlo", { candidateId: CID, tradeRs: [] });
  assert.equal(b.status, 400);
  const c = await j("POST", "/validation/cc/decision", { candidateId: CID });
  assert.equal(c.status, 400);
  const d = await j("POST", "/validation/cc/scorecard", { candidateId: CID, edgeQuality01: 1.5 });
  assert.equal(d.status, 400);
});
