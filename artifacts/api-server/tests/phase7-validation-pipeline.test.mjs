// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 — Validation Pipeline tests.
//
// Verifies: per-stage validators, readiness scoring with cross-system
// signals, promotion (single-step + freeze guard), demotion triggers, full
// pipeline orchestrator, and explainable report generation. Vault-logged.
// All endpoints advisory (canPlaceTrades:false, mode:"VALIDATION_PIPELINE").
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

const ISO = "2026-05-10T10:00:00.000Z";

function metrics(stage, over = {}) {
  return {
    stage, candidateId: "cand-x", recordedAtIso: ISO,
    trades: 250, expectancyR: 0.20, winRate01: 0.58, maxDrawdownR: 3,
    longestLosingStreak: 4,
    confidenceCalibration01: 0.80, executionQuality01: 0.85, riskCompliance01: 0.96,
    falseApprovalRate01: 0.05, falseBlockRate01: 0.05,
    ...over,
  };
}

async function newState(stage = "BACKTEST") {
  const init = await j("POST", "/validation/init-candidate", {
    candidate: {
      candidateId: "cand-x", kind: "STRATEGY",
      refId: "strat-momentum-v1", versionId: "1.0.0",
      introducedAtIso: ISO,
    },
    recordedAtIso: ISO,
  });
  assert.equal(init.status, 200);
  const s = init.data.state;
  s.currentStage = stage;
  return s;
}

// ── per-stage validators ───────────────────────────────────────────────────

test("V1 backtest PASS logs VALIDATION_BACKTEST_RUN", async () => {
  const r = await j("POST", "/validation/backtest", {
    metrics: metrics("BACKTEST"), recordedAtIso: ISO,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.verdict, "PASS");
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "VALIDATION_PIPELINE");
  assert.ok((await vaultTypes()).includes("VALIDATION_BACKTEST_RUN"));
});

test("V2 backtest FAIL on low expectancy + tight drawdown", async () => {
  const r = await j("POST", "/validation/backtest", {
    metrics: metrics("BACKTEST", { expectancyR: -0.05, maxDrawdownR: 12 }),
    recordedAtIso: ISO,
  });
  assert.equal(r.data.result.verdict, "FAIL");
  assert.ok(r.data.result.failedChecks.includes("POSITIVE_EXPECTANCY"));
  assert.ok(r.data.result.failedChecks.includes("MAX_DRAWDOWN"));
});

test("V3 walk-forward INCONCLUSIVE without folds", async () => {
  const r = await j("POST", "/validation/walk-forward", {
    metrics: metrics("WALK_FORWARD"), recordedAtIso: ISO,
  });
  assert.equal(r.data.result.verdict, "INCONCLUSIVE");
  assert.ok(r.data.result.blockers.some(b => /fold/i.test(b)));
});

test("V4 walk-forward PASS with positive folds", async () => {
  const r = await j("POST", "/validation/walk-forward", {
    metrics: metrics("WALK_FORWARD",
      { foldExpectancyRs: [0.15, 0.18, 0.12, 0.20] }),
    recordedAtIso: ISO,
  });
  assert.equal(r.data.result.verdict, "PASS");
});

test("V5 shadow-mode FAIL when real trades placed", async () => {
  const r = await j("POST", "/validation/shadow-mode", {
    metrics: metrics("SHADOW_MODE"),
    actuallyExecutedTrades: 3,
    recordedAtIso: ISO,
  });
  assert.equal(r.data.result.verdict, "FAIL");
  assert.ok(r.data.result.blockers.some(b => /shadow-mode invariant/i.test(b)));
});

test("V6 paper-trade FAIL with real orders > 0", async () => {
  const r = await j("POST", "/validation/paper-trade", {
    metrics: metrics("PAPER_TRADING"),
    realOrdersPlaced: 1,
    recordedAtIso: ISO,
  });
  assert.equal(r.data.result.verdict, "FAIL");
});

test("V7 micro-lot FAIL on cap breach", async () => {
  const r = await j("POST", "/validation/micro-lot", {
    metrics: metrics("MICRO_LOT_LIVE"),
    maxObservedLots: 0.05, maxAllowedLots: 0.01,
    recordedAtIso: ISO,
  });
  assert.equal(r.data.result.verdict, "FAIL");
  assert.ok(r.data.result.failedChecks.includes("MICRO_LOT_CAP"));
});

test("V8 limited-live FAIL on exposure + daily-risk caps", async () => {
  const r = await j("POST", "/validation/limited-live", {
    metrics: metrics("LIMITED_LIVE"),
    maxObservedExposureR: 12, maxAllowedExposureR: 5,
    maxObservedDailyTrades: 4, maxAllowedDailyTrades: 10,
    maxObservedDailyRiskR: 8, maxAllowedDailyRiskR: 3,
    recordedAtIso: ISO,
  });
  assert.equal(r.data.result.verdict, "FAIL");
  assert.ok(r.data.result.failedChecks.includes("EXPOSURE_CAP"));
  assert.ok(r.data.result.failedChecks.includes("DAILY_RISK_CAP"));
});

// ── readiness with cross-system signals ────────────────────────────────────

test("V9 readiness blends in cross-system signals", async () => {
  const state = await newState("MICRO_LOT_LIVE");
  const passResult = (stage) => ({
    stage, candidateId: "cand-x", verdict: "PASS",
    failedChecks: [], metrics: metrics(stage), recordedAtIso: ISO,
    reasons: [], blockers: [],
  });
  const stageResults = ["BACKTEST", "OUT_OF_SAMPLE_TEST", "WALK_FORWARD",
                          "MONTE_CARLO_STRESS_TEST", "REGIME_SPECIFIC_TEST",
                          "EXECUTION_REALITY_TEST", "SHADOW_MODE",
                          "PAPER_TRADING", "MICRO_LOT_LIVE"].map(passResult);

  const noCross = await j("POST", "/validation/readiness", {
    state, stageResults,
  });
  assert.equal(noCross.status, 200);
  assert.ok(noCross.data.readiness.score01 >= 0.99); // all PASS

  const withGoodCross = await j("POST", "/validation/readiness", {
    state, stageResults,
    crossSystem: {
      replayLab: { survivalScore01: 0.9, sampleConfidence01: 0.85 },
      executionIntel: { executionQuality01: 0.88 },
      traderDNA: { disciplineScore01: 0.85, behaviorRiskScore01: 0.1 },
      cognitive: { cognitiveLoad01: 0.15 },
    },
  });
  assert.ok(withGoodCross.data.readiness.score01 >= 0.85);
  assert.ok(withGoodCross.data.readiness.reasons.some(r => /cross-system blend/.test(r)));

  const withBadCross = await j("POST", "/validation/readiness", {
    state, stageResults,
    crossSystem: {
      replayLab: { survivalScore01: 0.1, sampleConfidence01: 0.1 },
      executionIntel: { executionQuality01: 0.1 },
      traderDNA: { disciplineScore01: 0.1, behaviorRiskScore01: 0.95 },
      cognitive: { cognitiveLoad01: 0.95 },
    },
  });
  // Bad cross-system signals should pull composite below the good one.
  assert.ok(withBadCross.data.readiness.score01 < withGoodCross.data.readiness.score01 - 0.2);
  assert.ok((await vaultTypes()).filter(t => t === "LIVE_READINESS_SCORED").length === 3);
});

// ── promotion / demotion ───────────────────────────────────────────────────

test("V10 promote advances exactly one stage and logs PROMOTION_DECISION", async () => {
  const state = await newState("BACKTEST");
  const r = await j("POST", "/validation/promote", {
    state, recordedAtIso: ISO,
    controlTowerAuthorized: true, controlTowerReason: "ok",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.promotion.promoted, true);
  assert.equal(r.data.promotion.fromStage, "BACKTEST");
  assert.equal(r.data.promotion.toStage, "OUT_OF_SAMPLE_TEST");
  assert.ok((await vaultTypes()).includes("PROMOTION_DECISION"));
});

test("V11 promote DENIED when Risk Governor frozen", async () => {
  const state = await newState("PAPER_TRADING");
  const r = await j("POST", "/validation/promote", {
    state, recordedAtIso: ISO,
    riskGovernorFrozen: true, freezeReason: "drawdown spike on parent strategy",
    controlTowerAuthorized: true,
  });
  assert.equal(r.data.promotion.promoted, false);
  assert.equal(r.data.promotion.authorized, false);
  assert.equal(r.data.promotion.newState.frozen, true);
});

test("V12 promote DENIED when Control Tower rejects", async () => {
  const state = await newState("BACKTEST");
  const r = await j("POST", "/validation/promote", {
    state, recordedAtIso: ISO,
    controlTowerAuthorized: false, controlTowerReason: "rollout window closed",
  });
  assert.equal(r.data.promotion.promoted, false);
  assert.ok(r.data.promotion.reasons.some(x => /rollout window closed/.test(x)));
});

test("V13 demotion EDGE_DECAY steps back exactly one stage", async () => {
  const state = await newState("PAPER_TRADING");
  const r = await j("POST", "/validation/demote", {
    state,
    metrics: metrics("PAPER_TRADING", { rollingExpectancySlope: -0.20 }),
    recordedAtIso: ISO,
  });
  assert.equal(r.data.demotion.shouldDemote, true);
  assert.ok(r.data.demotion.triggers.includes("EDGE_DECAY"));
  assert.equal(r.data.demotion.proposedStage, "SHADOW_MODE");
  assert.equal(r.data.newState.currentStage, "SHADOW_MODE");
});

test("V14 demotion DRAWDOWN_BREACH severe → SHADOW_MODE", async () => {
  const state = await newState("LIMITED_LIVE");
  const r = await j("POST", "/validation/demote", {
    state, metrics: metrics("LIMITED_LIVE", { maxDrawdownR: 15 }),
    recordedAtIso: ISO,
  });
  assert.equal(r.data.demotion.proposedStage, "SHADOW_MODE");
  assert.ok(r.data.demotion.triggers.includes("DRAWDOWN_BREACH"));
});

// ── full pipeline orchestrator ─────────────────────────────────────────────

test("V15 pipeline applies PASS result and promotes", async () => {
  const state = await newState("WALK_FORWARD");
  const result = {
    stage: "WALK_FORWARD", candidateId: "cand-x", verdict: "PASS",
    failedChecks: [], metrics: metrics("WALK_FORWARD"),
    recordedAtIso: ISO, reasons: ["all checks ok"], blockers: [],
  };
  const r = await j("POST", "/validation/pipeline", {
    state, result, recordedAtIso: ISO,
    controlTowerAuthorized: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.newState.currentStage, "MONTE_CARLO_STRESS_TEST");
  assert.equal(r.data.promotion.promoted, true);
  assert.ok((await vaultTypes()).includes("VALIDATION_PIPELINE_RUN"));
});

test("V16 pipeline does NOT promote on FAIL verdict", async () => {
  const state = await newState("BACKTEST");
  const result = {
    stage: "BACKTEST", candidateId: "cand-x", verdict: "FAIL",
    failedChecks: ["POSITIVE_EXPECTANCY"], metrics: metrics("BACKTEST"),
    recordedAtIso: ISO, reasons: ["fail"], blockers: [],
  };
  const r = await j("POST", "/validation/pipeline", {
    state, result, recordedAtIso: ISO, controlTowerAuthorized: true,
  });
  assert.equal(r.data.newState.currentStage, "BACKTEST");
  assert.equal(r.data.promotion, null);
});

// ── report ─────────────────────────────────────────────────────────────────

test("V17 report recommends PROMOTE when ready + current stage PASS", async () => {
  const state = await newState("MICRO_LOT_LIVE");
  const passResult = (stage) => ({
    stage, candidateId: "cand-x", verdict: "PASS",
    failedChecks: [], metrics: metrics(stage), recordedAtIso: ISO,
    reasons: [], blockers: [],
  });
  const stageResults = ["BACKTEST", "OUT_OF_SAMPLE_TEST", "WALK_FORWARD",
                          "MONTE_CARLO_STRESS_TEST", "REGIME_SPECIFIC_TEST",
                          "EXECUTION_REALITY_TEST", "SHADOW_MODE",
                          "PAPER_TRADING", "MICRO_LOT_LIVE"].map(passResult);

  const rd = await j("POST", "/validation/readiness", { state, stageResults });
  assert.equal(rd.status, 200);

  const rep = await j("POST", "/validation/report", {
    state, stageResults, readiness: rd.data.readiness, generatedAtIso: ISO,
  });
  assert.equal(rep.status, 200);
  assert.equal(rep.data.report.recommendation, "PROMOTE");
  assert.equal(rep.data.report.frozen, false);
  assert.ok((await vaultTypes()).includes("VALIDATION_REPORT_GENERATED"));
});

test("V18 report recommends DEMOTE when latest demotion check says so", async () => {
  const state = await newState("PAPER_TRADING");
  const stageResults = [];
  const rd = await j("POST", "/validation/readiness", { state, stageResults });
  const dem = await j("POST", "/validation/demote", {
    state,
    metrics: metrics("PAPER_TRADING", { rollingExpectancySlope: -0.20 }),
    recordedAtIso: ISO,
  });
  const rep = await j("POST", "/validation/report", {
    state, stageResults, readiness: rd.data.readiness,
    latestDemotionCheck: dem.data.demotion, generatedAtIso: ISO,
  });
  assert.equal(rep.data.report.recommendation, "DEMOTE");
});

test("V19 report recommends FREEZE when state.frozen", async () => {
  const state = await newState("LIMITED_LIVE");
  state.frozen = true; state.frozenReason = "manual freeze";
  const stageResults = [];
  const rd = await j("POST", "/validation/readiness", { state, stageResults });
  const rep = await j("POST", "/validation/report", {
    state, stageResults, readiness: rd.data.readiness, generatedAtIso: ISO,
  });
  assert.equal(rep.data.report.frozen, true);
  // RETIRE supersedes FREEZE if readiness has blockers (it does — frozen).
  assert.ok(["FREEZE", "RETIRE"].includes(rep.data.report.recommendation));
});

// ── architect-fix verifications ────────────────────────────────────────────

test("V20 frozen candidate IS still demotable (freeze blocks promote, not demote)", async () => {
  const state = await newState("LIMITED_LIVE");
  state.frozen = true; state.frozenReason = "governor freeze for investigation";
  const r = await j("POST", "/validation/demote", {
    state, metrics: metrics("LIMITED_LIVE", { maxDrawdownR: 15 }),
    recordedAtIso: ISO,
  });
  assert.equal(r.data.demotion.shouldDemote, true);
  assert.equal(r.data.demotion.proposedStage, "SHADOW_MODE");
  assert.equal(r.data.newState.currentStage, "SHADOW_MODE");
  // Frozen flag must be preserved — Governor's veto on future promotion stays.
  assert.equal(r.data.newState.frozen, true);
});

test("V21 catastrophic cross-system signal forces ready=false even with PASS stages", async () => {
  const state = await newState("MICRO_LOT_LIVE");
  const passResult = (stage) => ({
    stage, candidateId: "cand-x", verdict: "PASS",
    failedChecks: [], metrics: metrics(stage), recordedAtIso: ISO,
    reasons: [], blockers: [],
  });
  const stageResults = ["BACKTEST", "OUT_OF_SAMPLE_TEST", "WALK_FORWARD",
                          "MONTE_CARLO_STRESS_TEST", "REGIME_SPECIFIC_TEST",
                          "EXECUTION_REALITY_TEST", "SHADOW_MODE",
                          "PAPER_TRADING", "MICRO_LOT_LIVE"].map(passResult);
  const r = await j("POST", "/validation/readiness", {
    state, stageResults,
    crossSystem: {
      replayLab: { survivalScore01: 0.95, sampleConfidence01: 0.9 },
      executionIntel: { executionQuality01: 0.9 },
      traderDNA: { disciplineScore01: 0.9, behaviorRiskScore01: 0.95 }, // catastrophic
      cognitive: { cognitiveLoad01: 0.5 },
    },
  });
  assert.equal(r.data.readiness.ready, false);
  assert.ok(r.data.readiness.blockers.some(b => /CATASTROPHIC_SIGNAL.*behaviorRiskScore/.test(b)));
});

test("V22 pipeline refuses promotion when stage result carries blockers", async () => {
  const state = await newState("SHADOW_MODE");
  // A miscast PASS verdict but with structural blockers (e.g. shadow-mode
  // invariant violation from upstream) — defense-in-depth must catch this.
  const result = {
    stage: "SHADOW_MODE", candidateId: "cand-x", verdict: "PASS",
    failedChecks: [], metrics: metrics("SHADOW_MODE"),
    recordedAtIso: ISO, reasons: ["miscast"],
    blockers: ["shadow-mode invariant violated: 5 live trades placed"],
  };
  const r = await j("POST", "/validation/pipeline", {
    state, result, recordedAtIso: ISO, controlTowerAuthorized: true,
  });
  assert.equal(r.data.newState.currentStage, "SHADOW_MODE"); // no promote
  assert.equal(r.data.promotion, null);
});

// ── invariants ─────────────────────────────────────────────────────────────

test("VZ phase7 never emits TRADE_*/MODE_*/SIGNAL_*; canPlaceTrades:false", async () => {
  await j("POST", "/validation/backtest",
    { metrics: metrics("BACKTEST"), recordedAtIso: ISO });
  await j("POST", "/validation/walk-forward",
    { metrics: metrics("WALK_FORWARD", { foldExpectancyRs: [0.15, 0.20, 0.18] }),
      recordedAtIso: ISO });
  await j("POST", "/validation/shadow-mode",
    { metrics: metrics("SHADOW_MODE"), actuallyExecutedTrades: 0,
      liveAgreementRate01: 0.8, recordedAtIso: ISO });
  await j("POST", "/validation/paper-trade",
    { metrics: metrics("PAPER_TRADING"), realOrdersPlaced: 0, recordedAtIso: ISO });
  await j("POST", "/validation/micro-lot",
    { metrics: metrics("MICRO_LOT_LIVE"),
      maxObservedLots: 0.01, maxAllowedLots: 0.01, recordedAtIso: ISO });
  await j("POST", "/validation/limited-live",
    { metrics: metrics("LIMITED_LIVE"),
      maxObservedExposureR: 1, maxAllowedExposureR: 5,
      maxObservedDailyTrades: 1, maxAllowedDailyTrades: 10,
      maxObservedDailyRiskR: 1, maxAllowedDailyRiskR: 3, recordedAtIso: ISO });
  const state = await newState("BACKTEST");
  await j("POST", "/validation/promote",
    { state, recordedAtIso: ISO, controlTowerAuthorized: true });
  await j("POST", "/validation/demote",
    { state, metrics: metrics("BACKTEST"), recordedAtIso: ISO });
  await j("POST", "/validation/readiness", { state, stageResults: [] });

  const types = await vaultTypes();
  for (const t of types) {
    assert.ok(!/^TRADE_/.test(t),  `leaked TRADE_*: ${t}`);
    assert.ok(!/^MODE_/.test(t),   `leaked MODE_*: ${t}`);
    assert.ok(!/^SIGNAL_/.test(t), `leaked SIGNAL_*: ${t}`);
  }
  assert.ok(types.length >= 7, `expected vault writes, got ${types.length}`);
});

test("VZ2 phase7 invalid bodies return 400", async () => {
  const a = await j("POST", "/validation/backtest", { metrics: { stage: "BACKTEST" } });
  assert.equal(a.status, 400);
  const b = await j("POST", "/validation/promote", { state: { foo: "bar" }, recordedAtIso: ISO });
  assert.equal(b.status, 400);
  const c = await j("POST", "/validation/readiness", {});
  assert.equal(c.status, 400);
});
