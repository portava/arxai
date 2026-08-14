// ═══════════════════════════════════════════════════════════════════════════
// Phase 8 Decision Intelligence Layer tests.
//
// Acceptance criteria locked in:
//   • Bad winning trades can receive low decision scores.
//   • Good losing trades can receive high decision scores.
//   • No-trade decisions can be rewarded.
//   • Conviction (calibration) affects trade aggression.
//   • Future risk scenarios can reduce or block approval.
//   • All endpoints advisory (canPlaceTrades:false, mode:DECISION_PIPELINE).
//   • All decisions vault-logged with DI_* event types.
//   • Master /decision/evaluate recomputes every sub-result server-side
//     and ignores caller-supplied simulation proofs.
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

// ── Builders ───────────────────────────────────────────────────────────────
const ISO = "2026-05-10T12:00:00.000Z";
const baseDecision = (over = {}) => ({
  decisionId: "d1", strategyId: "S1", symbolId: "SYM",
  kind: "ENTRY", takenAtIso: ISO,
  session: "LONDON", regime: "TREND_UP",
  followedRules: true, riskSizingCorrect: true,
  preTradeChecklistPassed: true, futureRiskSimApproved: true,
  expressedConfidence01: 0.65, convictionGrade01: 0.65,
  outcome: "WIN", realizedR: 1.5,
  ...over,
});

const healthyMarket = () => ({
  trendStrength01: 0.7, rangeBound01: 0.2, autocorr1: 0.3,
  realisedVolZ: -0.5, volumeBurstZ: -0.5, microNoiseRatio01: 0.2,
});
const noisyMarket = () => ({
  trendStrength01: 0.2, rangeBound01: 0.5, autocorr1: -0.1,
  realisedVolZ: 0.3, volumeBurstZ: 0.5, microNoiseRatio01: 0.7,
});
const frenzyMarket = () => ({
  trendStrength01: 0.3, rangeBound01: 0.3, autocorr1: 0.0,
  realisedVolZ: 2.5, volumeBurstZ: 2.5, microNoiseRatio01: 0.6,
});
const calmFatigue = () => ({
  decisionsLastHour: 5, errorsLastHour: 0, minutesSinceLastBreak: 30,
});
const exhaustedFatigue = () => ({
  // density saturates at 30 dec/h; pushing 120 + high errorRate (0.5 ≥
  // ERROR_HARD 0.40 with decisions ≥ 5) guarantees forceCooldown=true.
  decisionsLastHour: 120, errorsLastHour: 60, minutesSinceLastBreak: 240,
});

const goodSim = () => ({
  candidateRiskR: 1.0, expectancyR: 0.30, winRate01: 0.55,
  avgWinR: 1.2, avgLossR: -0.8, pathsToSimulate: 500,
  horizonTrades: 50, ruinThresholdR: -30, seed: 42,
});
const badSim = () => ({
  candidateRiskR: 5.0, expectancyR: -0.20, winRate01: 0.30,
  avgWinR: 1.0, avgLossR: -2.0, pathsToSimulate: 500,
  horizonTrades: 100, ruinThresholdR: -10, seed: 42,
});

// 30 disciplined wins + 30 disciplined losses for a healthy history with
// reasonable expectancy.
function healthyHistory() {
  const recs = [];
  for (let i = 0; i < 30; i++) {
    recs.push(baseDecision({
      decisionId: `w${i}`,
      expressedConfidence01: 0.7, outcome: "WIN", realizedR: 1.5,
    }));
  }
  for (let i = 0; i < 30; i++) {
    recs.push(baseDecision({
      decisionId: `l${i}`, kind: "ENTRY",
      expressedConfidence01: 0.55, outcome: "LOSS", realizedR: -1.0,
    }));
  }
  return recs;
}

// ─────────────────────────────────────────────────────────────────────────
// 1) Decision Quality
// ─────────────────────────────────────────────────────────────────────────
test("DI1 bad winning trade receives LOW decision quality", async () => {
  // Won the trade but broke every process gate.
  const r = await j("POST", "/decision/quality", {
    decision: baseDecision({
      decisionId: "luckyWin",
      followedRules: false, riskSizingCorrect: false,
      preTradeChecklistPassed: false, futureRiskSimApproved: false,
      outcome: "WIN", realizedR: 3.0,
    }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.qualityScore01 < 0.40,
    `expected qualityScore<0.40, got ${r.data.result.qualityScore01}`);
  assert.equal(r.data.result.classification, "UNDISCIPLINED_WIN");
  assert.equal(r.data.result.reinforce, false, "must NOT reinforce undisciplined win");
});

test("DI2 good losing trade receives HIGH decision quality (with verified sim proof)", async () => {
  // The simulation proof MUST be supplied — otherwise the trade-class
  // decision is structurally undisciplined per scoreDecisionQuality.
  const sim = await j("POST", "/decision/future-risk", goodSim());
  const r = await j("POST", "/decision/quality", {
    decision: baseDecision({
      decisionId: "discLoss",
      followedRules: true, riskSizingCorrect: true,
      preTradeChecklistPassed: true, futureRiskSimApproved: true,
      outcome: "LOSS", realizedR: -1.0,
    }),
    simulationProof: sim.data.result,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.qualityScore01 >= 0.70,
    `expected qualityScore≥0.70, got ${r.data.result.qualityScore01}`);
  assert.equal(r.data.result.classification, "DISCIPLINED_LOSS");
  assert.equal(r.data.result.punish, false, "DISCIPLINED_LOSS must NOT be punished");
});

test("DI3 self-reported sim approval without proof structurally undisciplined", async () => {
  const r = await j("POST", "/decision/quality", {
    decision: baseDecision({
      decisionId: "selfReport",
      followedRules: true, riskSizingCorrect: true,
      preTradeChecklistPassed: true,
      futureRiskSimApproved: true,   // self-reported only — no proof
      outcome: "WIN", realizedR: 2.0,
    }),
    // no simulationProof attached
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.blockers.some(b => b.includes("verified futureRiskSim")),
    `expected blocker about verified sim, got ${JSON.stringify(r.data.result.blockers)}`);
  assert.equal(r.data.result.classification, "UNDISCIPLINED_WIN");
});

// ─────────────────────────────────────────────────────────────────────────
// 2) Expectancy
// ─────────────────────────────────────────────────────────────────────────
test("DI4 expectancy from history records", async () => {
  const r = await j("POST", "/decision/expectancy", { records: healthyHistory() });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.sampleSize, 60);
  assert.ok(r.data.result.winRate01 > 0.45 && r.data.result.winRate01 < 0.55);
  assert.ok(r.data.result.expectancyR > 0, `E[R] should be positive, got ${r.data.result.expectancyR}`);
});

test("DI5 expectancy with no resolved trades returns zero metrics", async () => {
  const r = await j("POST", "/decision/expectancy", {
    records: [baseDecision({ outcome: "PENDING", realizedR: undefined })],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.sampleSize, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 3) Conviction
// ─────────────────────────────────────────────────────────────────────────
test("DI6 conviction calibration: well-calibrated history", async () => {
  const r = await j("POST", "/decision/conviction", { records: healthyHistory() });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.overallCalibration01 >= 0,
    "well-calibrated history yields non-negative overallCalibration01");
  assert.ok(Array.isArray(r.data.result.bands));
});

test("DI7 conviction is poor when expressed confidence ignores reality", async () => {
  // Always express 0.95 confidence, but only win 30%.
  const recs = [];
  for (let i = 0; i < 50; i++) {
    recs.push(baseDecision({
      decisionId: `oc${i}`, expressedConfidence01: 0.95,
      outcome: i < 15 ? "WIN" : "LOSS",
      realizedR: i < 15 ? 1.2 : -1.0,
    }));
  }
  const r = await j("POST", "/decision/conviction", { records: recs });
  assert.ok(r.data.result.overconfidentBands.length > 0,
    "should detect overconfident bands");
  assert.ok(r.data.result.overallCalibration01 < 0.5,
    `overconfident → low calibration, got ${r.data.result.overallCalibration01}`);
});

// ─────────────────────────────────────────────────────────────────────────
// 4) Strategic Patience
// ─────────────────────────────────────────────────────────────────────────
test("DI8 patience metrics: highly selective system gets high selectivity", async () => {
  const recs = [
    baseDecision({ decisionId: "e1", kind: "ENTRY", outcome: "WIN", realizedR: 1.0 }),
  ];
  // 1 entry out of 20 qualified setups.
  const r = await j("POST", "/decision/patience", {
    records: recs, qualifiedSetupsCount: 20,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.selectivityScore01 >= 0.9);
});

// ─────────────────────────────────────────────────────────────────────────
// 5) Future Risk Simulation
// ─────────────────────────────────────────────────────────────────────────
test("DI9 future-risk sim approves a sound distribution", async () => {
  const r = await j("POST", "/decision/future-risk", goodSim());
  assert.equal(r.status, 200);
  assert.equal(r.data.result.approved, true);
  assert.ok(r.data.result.ruinProbability01 <= 0.05);
});

test("DI10 future-risk sim DECLINES a dangerous distribution", async () => {
  const r = await j("POST", "/decision/future-risk", badSim());
  assert.equal(r.status, 200);
  assert.equal(r.data.result.approved, false);
  assert.ok(r.data.result.blockers.length > 0);
});

test("DI11 future-risk sim is deterministic (same seed → same output)", async () => {
  const a = await j("POST", "/decision/future-risk", goodSim());
  const b = await j("POST", "/decision/future-risk", goodSim());
  assert.equal(a.data.result.meanFinalR, b.data.result.meanFinalR);
  assert.equal(a.data.result.ruinProbability01, b.data.result.ruinProbability01);
});

// ─────────────────────────────────────────────────────────────────────────
// 6) Market Personality
// ─────────────────────────────────────────────────────────────────────────
test("DI12 market personality identifies dominant trait", async () => {
  const r = await j("POST", "/decision/market-personality", healthyMarket());
  assert.equal(r.status, 200);
  assert.ok(["TRENDING","MOMENTUM","CALM","MIXED"].includes(r.data.result.dominantTrait));
});

// ─────────────────────────────────────────────────────────────────────────
// 7) Adaptive Aggression
// ─────────────────────────────────────────────────────────────────────────
test("DI13 conviction calibration affects aggression: good cal → ELEVATED/MAX possible", async () => {
  // History with strong calibration AND positive expectancy: confidence
  // 0.8 wins ~80%.
  const recs = [];
  for (let i = 0; i < 40; i++) {
    recs.push(baseDecision({
      decisionId: `g${i}`, expressedConfidence01: 0.80,
      outcome: i < 32 ? "WIN" : "LOSS",
      realizedR: i < 32 ? 1.5 : -1.0,
    }));
  }
  const r = await j("POST", "/decision/adaptive-aggression", {
    records: recs, market: healthyMarket(), fatigue: calmFatigue(),
  });
  assert.equal(r.status, 200);
  assert.ok(["STANDARD","ELEVATED","MAX"].includes(r.data.result.level),
    `expected non-conservative level, got ${r.data.result.level}`);
  assert.ok(r.data.result.multiplier >= 1.0);
});

test("DI14 fatigue cooldown forces CONSERVATIVE × 0", async () => {
  const r = await j("POST", "/decision/adaptive-aggression", {
    records: healthyHistory(), market: healthyMarket(),
    fatigue: exhaustedFatigue(),
  });
  assert.equal(r.data.result.level, "CONSERVATIVE");
  assert.equal(r.data.result.multiplier, 0);
});

test("DI15 negative expectancy caps aggression to CONSERVATIVE", async () => {
  // 70% losers → negative expectancy.
  const recs = [];
  for (let i = 0; i < 40; i++) {
    recs.push(baseDecision({
      decisionId: `bd${i}`, expressedConfidence01: 0.5,
      outcome: i < 12 ? "WIN" : "LOSS",
      realizedR: i < 12 ? 1.0 : -1.5,
    }));
  }
  const r = await j("POST", "/decision/adaptive-aggression", {
    records: recs, market: healthyMarket(), fatigue: calmFatigue(),
  });
  assert.equal(r.data.result.level, "CONSERVATIVE");
});

// ─────────────────────────────────────────────────────────────────────────
// 8) No-Trade Quality (restraint can be REWARDED)
// ─────────────────────────────────────────────────────────────────────────
test("DI16 NO_TRADE that avoided a loss is VINDICATED", async () => {
  const r = await j("POST", "/decision/no-trade-quality", {
    decision: baseDecision({ decisionId: "nt1", kind: "NO_TRADE", outcome: "AVOIDED_LOSS", realizedR: undefined }),
    counterfactualR: -1.5,                  // would have lost 1.5R
    historyRecords: healthyHistory(),
    qualifiedSetupsCount: 50,
    market: noisyMarket(),
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.classification, "VINDICATED_RESTRAINT");
  assert.ok(r.data.result.qualityScore01 >= 0.65, `score=${r.data.result.qualityScore01}`);
  assert.equal(r.data.result.reinforce, true);
});

test("DI17 NO_TRADE that missed a clean win is REGRETTED but not punished hard", async () => {
  const r = await j("POST", "/decision/no-trade-quality", {
    decision: baseDecision({ decisionId: "nt2", kind: "NO_TRADE", outcome: "MISSED_WIN", realizedR: undefined }),
    counterfactualR: 2.0,                   // would have won 2R
    historyRecords: healthyHistory(),
    qualifiedSetupsCount: 50,
    market: healthyMarket(),
  });
  assert.equal(r.data.result.classification, "REGRETTED_RESTRAINT");
  assert.equal(r.data.result.reinforce, false);
});

test("DI18 BLOCKED in noisy/frenzied market gets restraint credit", async () => {
  const r = await j("POST", "/decision/no-trade-quality", {
    decision: baseDecision({ decisionId: "blk1", kind: "BLOCKED", outcome: "AVOIDED_LOSS", realizedR: undefined }),
    counterfactualR: -0.5,
    historyRecords: healthyHistory(),
    qualifiedSetupsCount: 50,
    market: frenzyMarket(),
  });
  assert.equal(r.data.result.classification, "VINDICATED_RESTRAINT");
  assert.ok(r.data.result.qualityScore01 >= 0.7);
});

// ─────────────────────────────────────────────────────────────────────────
// 9) Decision Chain Scoring
// ─────────────────────────────────────────────────────────────────────────
test("DI19 chain scoring rewards a clean ENTRY → HOLD → EXIT sequence (with sim proof)", async () => {
  const sim = (await j("POST", "/decision/future-risk", goodSim())).data.result;
  const steps = [
    baseDecision({ decisionId: "c1.entry", kind: "ENTRY",
      takenAtIso: "2026-05-10T12:00:00.000Z", outcome: "WIN", realizedR: 1.5 }),
    baseDecision({ decisionId: "c1.hold", kind: "HOLD",
      takenAtIso: "2026-05-10T12:30:00.000Z", outcome: "PENDING", realizedR: undefined }),
    baseDecision({ decisionId: "c1.exit", kind: "EXIT",
      takenAtIso: "2026-05-10T13:00:00.000Z", outcome: "WIN", realizedR: 1.5 }),
  ];
  const r = await j("POST", "/decision/chain", {
    chainId: "c1", steps,
    simulationProofs: { "c1.entry": sim, "c1.exit": sim },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.chainQualityScore01 >= 0.70);
  assert.equal(r.data.result.reinforceChain, true);
  assert.equal(r.data.result.antiPatterns.length, 0);
});

test("DI20 chain detects REVENGE_SCALE_IN within 5min of a loss", async () => {
  const sim = (await j("POST", "/decision/future-risk", goodSim())).data.result;
  const steps = [
    baseDecision({ decisionId: "rv.entry", kind: "ENTRY",
      takenAtIso: "2026-05-10T12:00:00.000Z", outcome: "LOSS", realizedR: -1.0 }),
    baseDecision({ decisionId: "rv.scale", kind: "SCALE_IN",
      takenAtIso: "2026-05-10T12:02:00.000Z", outcome: "LOSS", realizedR: -1.5 }),
  ];
  const r = await j("POST", "/decision/chain", {
    chainId: "rv", steps,
    simulationProofs: { "rv.entry": sim, "rv.scale": sim },
  });
  assert.ok(r.data.result.antiPatterns.some(p => p.includes("REVENGE_SCALE_IN")));
  assert.equal(r.data.result.reinforceChain, false);
  assert.equal(r.data.result.punishChain, true);
});

test("DI21 chain detects UNDISCIPLINED_ENTRY_RESCUED_BY_LUCK", async () => {
  // Entry breaks every gate yet wins.
  const steps = [
    baseDecision({ decisionId: "lk.entry", kind: "ENTRY",
      followedRules: false, riskSizingCorrect: false,
      preTradeChecklistPassed: false, futureRiskSimApproved: false,
      takenAtIso: "2026-05-10T12:00:00.000Z", outcome: "WIN", realizedR: 4.0 }),
  ];
  const r = await j("POST", "/decision/chain", { chainId: "lk", steps });
  assert.ok(r.data.result.antiPatterns.some(p => p.includes("UNDISCIPLINED_ENTRY_RESCUED_BY_LUCK")));
  assert.equal(r.data.result.punishChain, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 10) Master /decision/evaluate
// ─────────────────────────────────────────────────────────────────────────
const masterBundle = (over = {}) => ({
  candidateDecision: baseDecision({
    decisionId: "cand1", kind: "ENTRY",
    outcome: "PENDING", realizedR: undefined,
  }),
  historyRecords: healthyHistory(),
  qualifiedSetupsCount: 50,
  market: healthyMarket(),
  fatigue: calmFatigue(),
  simulation: goodSim(),
  ...over,
});

test("DI22 master /decision/evaluate is advisory and produces all required scores", async () => {
  const r = await j("POST", "/decision/evaluate", masterBundle());
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "DECISION_PIPELINE");
  const s = r.data.verdict.scores;
  for (const k of ["decisionQualityScore01","expectancyScore01","convictionScore01",
                   "patienceScore01","survivalImpactScore01","futureRiskScore01"]) {
    assert.ok(typeof s[k] === "number" && s[k] >= 0 && s[k] <= 1, `score ${k}=${s[k]}`);
  }
  assert.ok(typeof r.data.verdict.recommendedAction === "string");
  assert.ok(typeof r.data.verdict.plainEnglishExplanation === "string");
});

test("DI23 master /decision/evaluate returns HARD_BLOCK when fatigue cooldown triggered", async () => {
  const r = await j("POST", "/decision/evaluate", masterBundle({
    fatigue: exhaustedFatigue(),
  }));
  assert.equal(r.data.verdict.recommendedAction, "HARD_BLOCK");
});

test("DI24 master /decision/evaluate returns HARD_BLOCK when sim is dangerous", async () => {
  const r = await j("POST", "/decision/evaluate", masterBundle({
    simulation: badSim(),
  }));
  assert.equal(r.data.verdict.recommendedAction, "HARD_BLOCK");
});

test("DI25 master /decision/evaluate returns MONITOR_ONLY in frenzy+noisy market", async () => {
  const r = await j("POST", "/decision/evaluate", masterBundle({
    market: frenzyMarket(),
  }));
  assert.equal(r.data.verdict.recommendedAction, "MONITOR_ONLY");
});

test("DI26 master /decision/evaluate returns SOFT_BLOCK on negative-expectancy history", async () => {
  // Force negative expectancy via bulk losers.
  const bad = [];
  for (let i = 0; i < 40; i++) {
    bad.push(baseDecision({
      decisionId: `bad${i}`, expressedConfidence01: 0.5,
      outcome: i < 10 ? "WIN" : "LOSS",
      realizedR: i < 10 ? 1.0 : -1.5,
    }));
  }
  const r = await j("POST", "/decision/evaluate", masterBundle({ historyRecords: bad }));
  assert.equal(r.data.verdict.recommendedAction, "SOFT_BLOCK");
});

test("DI27 master /decision/evaluate scores NO_TRADE candidate and rewards restraint", async () => {
  // Realistic restraint context: noisy market + selective system
  // (qualifiedSetupsCount > history entries → high selectivity).
  const r = await j("POST", "/decision/evaluate", masterBundle({
    candidateDecision: baseDecision({
      decisionId: "ntCand", kind: "NO_TRADE",
      outcome: "AVOIDED_LOSS", realizedR: undefined,
    }),
    counterfactualR: -1.5,
    market: noisyMarket(),
    qualifiedSetupsCount: 200,
  }));
  assert.equal(r.status, 200);
  assert.ok(r.data.verdict.scores.noTradeQualityScore01 !== null);
  assert.ok(r.data.verdict.scores.noTradeQualityScore01 >= 0.65,
    `noTradeScore=${r.data.verdict.scores.noTradeQualityScore01}`);
  assert.equal(r.data.verdict.noTradeQuality.classification, "VINDICATED_RESTRAINT");
});

test("DI28 master /decision/evaluate ignores caller-supplied simulationProof — recomputes server-side", async () => {
  // Caller cannot fabricate a sim proof at /decision/evaluate; the body
  // schema is .strict() and only accepts raw `simulation` inputs. Posting
  // a forged simulationProof key must 400.
  const body = masterBundle();
  body.simulationProof = {
    paths: 1, meanFinalR: 999, medianFinalR: 999, p05FinalR: 999, worstFinalR: 999,
    ruinProbability01: 0, approved: true, reasons: [], blockers: [],
  };
  const r = await j("POST", "/decision/evaluate", body);
  assert.equal(r.status, 400);
});

test("DI29 master /decision/evaluate vault-logs DI_DECISION_INTELLIGENCE_VERDICT", async () => {
  await j("POST", "/decision/evaluate", masterBundle());
  const types = await vaultTypes();
  assert.ok(types.includes("DI_DECISION_INTELLIGENCE_VERDICT"),
    `expected DI_DECISION_INTELLIGENCE_VERDICT in ${types.join(",")}`);
});

// ─────────────────────────────────────────────────────────────────────────
// 11) Cross-cutting invariants
// ─────────────────────────────────────────────────────────────────────────
test("DI30 every per-engine endpoint emits a DI_* vault event", async () => {
  await j("POST", "/decision/quality",            { decision: baseDecision() });
  await j("POST", "/decision/expectancy",         { records: healthyHistory() });
  await j("POST", "/decision/conviction",         { records: healthyHistory() });
  await j("POST", "/decision/patience",           { records: healthyHistory(), qualifiedSetupsCount: 10 });
  await j("POST", "/decision/future-risk",        goodSim());
  await j("POST", "/decision/market-personality", healthyMarket());
  await j("POST", "/decision/adaptive-aggression",{ records: healthyHistory(), market: healthyMarket(), fatigue: calmFatigue() });
  await j("POST", "/decision/no-trade-quality",   {
    decision: baseDecision({ decisionId: "x", kind: "NO_TRADE", outcome: "AVOIDED_LOSS", realizedR: undefined }),
    counterfactualR: -1.0, historyRecords: healthyHistory(),
    qualifiedSetupsCount: 50, market: healthyMarket(),
  });
  await j("POST", "/decision/chain", {
    chainId: "z", steps: [baseDecision({ decisionId: "z1" })],
  });
  const types = await vaultTypes();
  const di = [...new Set(types.filter(t => t.startsWith("DI_")))];
  assert.ok(di.length >= 9, `expected ≥9 distinct DI_* events, got ${di.length} (${di.join(",")})`);
});

test("DI31 every endpoint is advisory (canPlaceTrades:false, mode:DECISION_PIPELINE)", async () => {
  const calls = [
    ["/decision/quality",            { decision: baseDecision() }],
    ["/decision/expectancy",         { records: healthyHistory() }],
    ["/decision/conviction",         { records: healthyHistory() }],
    ["/decision/patience",           { records: healthyHistory(), qualifiedSetupsCount: 10 }],
    ["/decision/future-risk",        goodSim()],
    ["/decision/market-personality", healthyMarket()],
    ["/decision/adaptive-aggression",{ records: healthyHistory(), market: healthyMarket(), fatigue: calmFatigue() }],
    ["/decision/chain",              { chainId: "ad", steps: [baseDecision({ decisionId: "ad1" })] }],
    ["/decision/evaluate",           masterBundle()],
  ];
  for (const [path, body] of calls) {
    const r = await j("POST", path, body);
    assert.equal(r.status, 200, `${path} failed`);
    assert.equal(r.data.canPlaceTrades, false, `${path} canPlaceTrades`);
    assert.equal(r.data.mode, "DECISION_PIPELINE", `${path} mode`);
  }
});

test("DI32a forged simulationProof on /decision/quality is rejected (strict schema)", async () => {
  const r = await j("POST", "/decision/quality", {
    decision: baseDecision({ outcome: "WIN", realizedR: 2.0 }),
    simulationProof: { approved: true, foo: "bar" },   // not a valid SimulationResult
  });
  assert.equal(r.status, 400);
});

test("DI32b forged simulationProof on /decision/chain is rejected (strict schema)", async () => {
  const r = await j("POST", "/decision/chain", {
    chainId: "fz", steps: [baseDecision({ decisionId: "fz1" })],
    simulationProofs: { "fz1": { approved: true } },   // not a valid SimulationResult
  });
  assert.equal(r.status, 400);
});

test("DI32 invalid bodies return 400", async () => {
  const a = await j("POST", "/decision/quality", {});
  assert.equal(a.status, 400);
  const b = await j("POST", "/decision/future-risk", { ...goodSim(), winRate01: 1.5 });
  assert.equal(b.status, 400);
  const c = await j("POST", "/decision/evaluate", { foo: "bar" });
  assert.equal(c.status, 400);
});
