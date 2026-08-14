// ═══════════════════════════════════════════════════════════════════════════
// Adversarial Validation tests.
//
// Verifies the six adversarial attack categories + assumption audit + the
// master decision engine. Confirms invariants:
//   • Fragile strategies cannot PROMOTE regardless of profit.
//   • Severe assumption violations force at least RESTRICT.
//   • All decisions are vault-logged with ADVERSARIAL_* event types.
//   • Endpoints remain advisory (canPlaceTrades:false).
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
const CID = "cand-adv";

// ── Builders ───────────────────────────────────────────────────────────────
function robustEdge() { return {
  candidateId: CID, baselineExpectancyR: 0.20,
  attacks: [
    { kind: "DELAYED_ENTRY",     perturbedExpectancyR: 0.18 },
    { kind: "DELAYED_EXIT",      perturbedExpectancyR: 0.17 },
    { kind: "REDUCED_LIQUIDITY", perturbedExpectancyR: 0.16 },
    { kind: "SPREAD_WIDENING",   perturbedExpectancyR: 0.17 },
    { kind: "SLIPPAGE_INCREASE", perturbedExpectancyR: 0.16 },
    { kind: "PARAM_SHIFT",       perturbedExpectancyR: 0.18 },
  ],
};}
function fragileEdge() { return {
  candidateId: CID, baselineExpectancyR: 0.20,
  attacks: [
    { kind: "DELAYED_ENTRY",     perturbedExpectancyR: 0.05 },
    { kind: "DELAYED_EXIT",      perturbedExpectancyR: 0.04 },
    { kind: "REDUCED_LIQUIDITY", perturbedExpectancyR: -0.30 },
    { kind: "SPREAD_WIDENING",   perturbedExpectancyR: 0.02 },
  ],
};}
function robustRegime() { return {
  candidateId: CID, baselineExpectancyR: 0.20,
  scenarios: [
    { kind: "WRONG_REGIME_USAGE",    perturbedExpectancyR: 0.16 },
    { kind: "SUDDEN_TREND_REVERSAL", perturbedExpectancyR: 0.15 },
    { kind: "VOLATILITY_EXPLOSION",  perturbedExpectancyR: 0.14 },
    { kind: "CHOP_TRANSITION",       perturbedExpectancyR: 0.16 },
    { kind: "LIQUIDITY_COLLAPSE",    perturbedExpectancyR: 0.13 },
  ],
};}
function robustExec() { return {
  candidateId: CID, baselineExpectancyR: 0.20,
  scenarios: [
    { kind: "PARTIAL_FILLS",       perturbedExpectancyR: 0.17 },
    { kind: "LATENCY_SPIKES",      perturbedExpectancyR: 0.16 },
    { kind: "REJECTED_ORDERS",     perturbedExpectancyR: 0.16 },
    { kind: "BROKER_INSTABILITY",  perturbedExpectancyR: 0.15 },
    { kind: "EXECUTION_DELAYS",    perturbedExpectancyR: 0.16 },
  ],
};}
function robustBehavior() { return {
  candidateId: CID, baselineExpectancyR: 0.20,
  scenarios: [
    { kind: "POST_LOSS_AGGRESSION",     perturbedExpectancyR: 0.16 },
    { kind: "OVERRIDE_FREQUENCY_HIGH",  perturbedExpectancyR: 0.16 },
    { kind: "FATIGUE_CONDITIONS",       perturbedExpectancyR: 0.15 },
    { kind: "REVENGE_TRADING",          perturbedExpectancyR: 0.15 },
    { kind: "OVERTRADING_PATTERN",      perturbedExpectancyR: 0.16 },
  ],
};}
function robustContradiction() { return {
  candidateId: CID, baselineExpectancyR: 0.20,
  scenarios: [
    { kind: "CONFLICTING_AGENT_VOTES",     perturbedExpectancyR: 0.17 },
    { kind: "STALE_SIGNALS",               perturbedExpectancyR: 0.18 },
    { kind: "INCOMPLETE_DATA",             perturbedExpectancyR: 0.18 },
    { kind: "CORRUPTED_DATA",              perturbedExpectancyR: 0.17 },
    { kind: "MISLEADING_MARKET_STRUCTURE", perturbedExpectancyR: 0.16 },
  ],
};}
function robustOverfit() { return {
  candidateId: CID, baselineExpectancyR: 0.20,
  probes: [
    { kind: "RANDOMIZATION",              perturbedExpectancyR: 0.02 }, // collapses → robust
    { kind: "SHUFFLED_TRADE_ORDER",       perturbedExpectancyR: 0.18 },
    { kind: "OUT_OF_SAMPLE",              perturbedExpectancyR: 0.18 },
    { kind: "SYNTHETIC_MARKET_VARIATIONS",perturbedExpectancyR: 0.17 },
    { kind: "HIDDEN_REGIME_EVALUATION",   perturbedExpectancyR: 0.16 },
  ],
};}
function fragileOverfit() { return {
  candidateId: CID, baselineExpectancyR: 0.50,
  probes: [
    // RANDOMIZATION stays close to baseline → suspicious of leakage
    { kind: "RANDOMIZATION",              perturbedExpectancyR: 0.45 },
    // OOS collapses → clear overfit
    { kind: "OUT_OF_SAMPLE",              perturbedExpectancyR: -0.10 },
    { kind: "SHUFFLED_TRADE_ORDER",       perturbedExpectancyR: -0.05 },
    { kind: "HIDDEN_REGIME_EVALUATION",   perturbedExpectancyR: 0.05 },
  ],
};}
function holdingAssumptions() { return {
  candidateId: CID,
  assumptions: [
    { kind: "SPREAD_LE_1PIP",     holds: true,  severity01: 0.5 },
    { kind: "BROKER_AVAILABLE",   holds: true,  severity01: 0.7 },
    { kind: "FEED_REAL_TIME",     holds: true,  severity01: 0.6 },
  ],
};}

// ── Per-engine endpoint tests ──────────────────────────────────────────────

test("AV1 edge-fragility ROBUST when no attacks break the edge", async () => {
  const r = await j("POST", "/adversarial/edge-fragility", robustEdge());
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "VALIDATION_PIPELINE");
  assert.ok(r.data.result.robustnessScore01 >= 0.7);
  assert.equal(r.data.result.breakingPoints.length, 0);
  assert.ok((await vaultTypes()).includes("ADVERSARIAL_EDGE_FRAGILITY_ASSESSED"));
});

test("AV2 edge-fragility FRAGILE identifies breaking attacks + worst", async () => {
  const r = await j("POST", "/adversarial/edge-fragility", fragileEdge());
  assert.equal(r.status, 200);
  assert.ok(r.data.result.fragilityScore01 >= 0.5);
  assert.ok(r.data.result.breakingPoints.length >= 2);
  assert.equal(r.data.result.worstAttackKind, "REDUCED_LIQUIDITY");
});

test("AV3 regime-collapse ROBUST", async () => {
  const r = await j("POST", "/adversarial/regime-collapse", robustRegime());
  assert.ok(r.data.result.fragilityScore01 < 0.4);
  assert.equal(r.data.result.collapsePoints.length, 0);
});

test("AV4 regime-collapse FRAGILE on liquidity collapse", async () => {
  const r = await j("POST", "/adversarial/regime-collapse", {
    candidateId: CID, baselineExpectancyR: 0.20,
    scenarios: [
      { kind: "WRONG_REGIME_USAGE",    perturbedExpectancyR: 0.18 },
      { kind: "LIQUIDITY_COLLAPSE",    perturbedExpectancyR: -0.40 },
      { kind: "VOLATILITY_EXPLOSION",  perturbedExpectancyR: -0.10 },
    ],
  });
  assert.equal(r.data.result.worstScenarioKind, "LIQUIDITY_COLLAPSE");
  assert.ok(r.data.result.collapsePoints.includes("LIQUIDITY_COLLAPSE"));
});

test("AV5 execution-sabotage ROBUST", async () => {
  const r = await j("POST", "/adversarial/execution-sabotage", robustExec());
  assert.ok(r.data.result.robustnessScore01 >= 0.7);
});

test("AV6 execution-sabotage flags broker instability", async () => {
  const r = await j("POST", "/adversarial/execution-sabotage", {
    candidateId: CID, baselineExpectancyR: 0.20,
    scenarios: [
      { kind: "PARTIAL_FILLS",      perturbedExpectancyR: 0.18 },
      { kind: "BROKER_INSTABILITY", perturbedExpectancyR: -0.20 },
    ],
  });
  assert.ok(r.data.result.sabotagePoints.includes("BROKER_INSTABILITY"));
});

test("AV7 behavioral-stress ROBUST", async () => {
  const r = await j("POST", "/adversarial/behavioral-stress", robustBehavior());
  assert.ok(r.data.result.robustnessScore01 >= 0.7);
});

test("AV8 behavioral-stress flags revenge trading", async () => {
  const r = await j("POST", "/adversarial/behavioral-stress", {
    candidateId: CID, baselineExpectancyR: 0.20,
    scenarios: [
      { kind: "POST_LOSS_AGGRESSION", perturbedExpectancyR: 0.18 },
      { kind: "REVENGE_TRADING",      perturbedExpectancyR: -0.30 },
    ],
  });
  assert.ok(r.data.result.stressPoints.includes("REVENGE_TRADING"));
});

test("AV9 contradiction-test produces toleranceScore", async () => {
  const r = await j("POST", "/adversarial/contradiction-test", robustContradiction());
  assert.ok(r.data.result.toleranceScore01 >= 0.7);
  assert.equal(r.data.result.intolerancePoints.length, 0);
});

test("AV10 contradiction-test FAIL on corrupted data", async () => {
  const r = await j("POST", "/adversarial/contradiction-test", {
    candidateId: CID, baselineExpectancyR: 0.20,
    scenarios: [
      { kind: "STALE_SIGNALS",  perturbedExpectancyR: 0.18 },
      { kind: "CORRUPTED_DATA", perturbedExpectancyR: -0.15 },
    ],
  });
  assert.ok(r.data.result.intolerancePoints.includes("CORRUPTED_DATA"));
  assert.ok(r.data.result.toleranceScore01 < 0.7);
});

test("AV11 overfit-exposure ROBUST when randomization collapses + OOS holds", async () => {
  const r = await j("POST", "/adversarial/overfit-exposure", robustOverfit());
  assert.ok(r.data.result.robustnessScore01 >= 0.6,
    `expected robustness ≥0.6, got ${r.data.result.robustnessScore01}`);
});

test("AV12 overfit-exposure HIGH when randomization stays high + OOS collapses", async () => {
  const r = await j("POST", "/adversarial/overfit-exposure", fragileOverfit());
  assert.ok(r.data.result.fragilityScore01 >= 0.5,
    `expected exposure ≥0.5, got ${r.data.result.fragilityScore01}`);
  assert.ok(r.data.result.exposurePoints.includes("OUT_OF_SAMPLE"));
});

test("AV13 assumption-audit holding all assumptions → score≈1, no restrictions", async () => {
  const r = await j("POST", "/adversarial/assumption-audit", holdingAssumptions());
  assert.equal(r.data.result.assumptionsViolated.length, 0);
  assert.ok(r.data.result.score01 >= 0.99);
  assert.equal(r.data.result.recommendedRestrictions.length, 0);
});

test("AV14 assumption-audit violations produce severity + restrictions", async () => {
  const r = await j("POST", "/adversarial/assumption-audit", {
    candidateId: CID,
    assumptions: [
      { kind: "BROKER_AVAILABLE", holds: false, severity01: 0.9,
        evidence: "broker dropped 8% of trades last week",
        recommendedRestriction: "REQUIRES_REDUNDANT_BROKER" },
      { kind: "SPREAD_LE_1PIP",   holds: true,  severity01: 0.4 },
      { kind: "FEED_REAL_TIME",   holds: false, severity01: 0.6,
        recommendedRestriction: "REQUIRES_PRIMARY_FEED" },
    ],
  });
  assert.ok(r.data.result.violationSeverity01 >= 0.7);
  assert.ok(r.data.result.recommendedRestrictions.includes("REQUIRES_REDUNDANT_BROKER"));
  assert.ok(r.data.result.recommendedRestrictions.includes("REQUIRES_PRIMARY_FEED"));
});

// ── Strategy attack bundle ─────────────────────────────────────────────────

test("AV15 strategy-attack runs every category supplied", async () => {
  const r = await j("POST", "/adversarial/attack", {
    candidateId: CID,
    edgeFragility:     { baselineExpectancyR: 0.20, attacks:   robustEdge().attacks },
    regimeCollapse:    { baselineExpectancyR: 0.20, scenarios: robustRegime().scenarios },
    executionSabotage: { baselineExpectancyR: 0.20, scenarios: robustExec().scenarios },
    behavioralStress:  { baselineExpectancyR: 0.20, scenarios: robustBehavior().scenarios },
    contradictionTest: { baselineExpectancyR: 0.20, scenarios: robustContradiction().scenarios },
    overfitExposure:   { baselineExpectancyR: 0.20, probes:    robustOverfit().probes },
    assumptionAudit:   { assumptions: holdingAssumptions().assumptions },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.categoriesRun.length, 7);
  assert.ok(r.data.result.edgeFragility);
  assert.ok(r.data.result.assumptionAudit);
  assert.ok((await vaultTypes()).includes("ADVERSARIAL_ATTACK_BUNDLE"));
});

// ── Master decision tree ───────────────────────────────────────────────────
//
// /validate accepts ONLY raw attack inputs (architect-flagged anti-bypass)
// and requires all six attack categories. Build full bundles below.

const robustBundle = () => ({
  candidateId: CID,
  edgeFragility:     { baselineExpectancyR: 0.20, attacks:   robustEdge().attacks },
  regimeCollapse:    { baselineExpectancyR: 0.20, scenarios: robustRegime().scenarios },
  executionSabotage: { baselineExpectancyR: 0.20, scenarios: robustExec().scenarios },
  behavioralStress:  { baselineExpectancyR: 0.20, scenarios: robustBehavior().scenarios },
  contradictionTest: { baselineExpectancyR: 0.20, scenarios: robustContradiction().scenarios },
  overfitExposure:   { baselineExpectancyR: 0.20, probes:    robustOverfit().probes },
  assumptionAudit:   { assumptions: holdingAssumptions().assumptions },
});

test("AV16 validate PROMOTE when every category robust + assumptions hold", async () => {
  const r = await j("POST", "/adversarial/validate", robustBundle());
  assert.equal(r.status, 200);
  assert.equal(r.data.result.decision, "PROMOTE");
  assert.equal(r.data.result.allowedToPromote, true);
  assert.equal(r.data.result.adversarialFailurePoints.length, 0);
  assert.equal(r.data.result.recommendedRestrictions.length, 0);
  assert.ok((await vaultTypes()).includes("ADVERSARIAL_VALIDATION_DECISION"));
});

test("AV17 validate RESTRICT when one category breaks (regime collapse)", async () => {
  const body = robustBundle();
  body.regimeCollapse = { baselineExpectancyR: 0.20, scenarios: [
    { kind: "WRONG_REGIME_USAGE",    perturbedExpectancyR: 0.18 },
    { kind: "LIQUIDITY_COLLAPSE",    perturbedExpectancyR: -0.30 },
    { kind: "VOLATILITY_EXPLOSION",  perturbedExpectancyR: -0.05 },
  ]};
  const r = await j("POST", "/adversarial/validate", body);
  assert.equal(r.data.result.decision, "RESTRICT");
  assert.equal(r.data.result.allowedToPromote, false);
  assert.ok(r.data.result.recommendedRestrictions.includes("REQUIRES_REGIME_GATE"));
  assert.ok(r.data.result.adversarialFailurePoints.length > 0);
});

test("AV18 validate DEMOTE when ≥2 categories severely weak", async () => {
  const body = robustBundle();
  body.regimeCollapse = { baselineExpectancyR: 0.20, scenarios: [
    { kind: "WRONG_REGIME_USAGE",    perturbedExpectancyR: -0.10 },
    { kind: "LIQUIDITY_COLLAPSE",    perturbedExpectancyR: -0.30 },
    { kind: "VOLATILITY_EXPLOSION",  perturbedExpectancyR: -0.20 },
  ]};
  body.overfitExposure = { baselineExpectancyR: 0.50, probes: fragileOverfit().probes };
  const r = await j("POST", "/adversarial/validate", body);
  assert.ok(["DEMOTE", "RETIRE"].includes(r.data.result.decision));
  assert.equal(r.data.result.allowedToPromote, false);
});

test("AV19 validate RETIRE when ≥3 categories severely weak", async () => {
  const broken = (scenarios) => scenarios.map(s => ({ ...s, perturbedExpectancyR: -0.30 }));
  const body = robustBundle();
  body.edgeFragility     = { baselineExpectancyR: 0.20, attacks:   broken(robustEdge().attacks) };
  body.regimeCollapse    = { baselineExpectancyR: 0.20, scenarios: broken(robustRegime().scenarios) };
  body.executionSabotage = { baselineExpectancyR: 0.20, scenarios: broken(robustExec().scenarios) };
  const r = await j("POST", "/adversarial/validate", body);
  assert.equal(r.data.result.decision, "RETIRE");
  assert.equal(r.data.result.allowedToPromote, false);
  // ≥3 categories with fragility > 0.6 triggers RETIRE regardless of the
  // weighted-average fragility (the robust categories pull it down).
  assert.ok(r.data.result.adversarialFailurePoints.length >= 3);
});

test("AV20 invariant: high profit cannot bypass adversarial weakness", async () => {
  // Robust everywhere except ONE breaking sabotage scenario must NEVER
  // PROMOTE — the breaking-attack restriction trigger must fire even when
  // the average sabotage fragility stays below the 0.4 weak threshold.
  const body = robustBundle();
  body.executionSabotage = { baselineExpectancyR: 0.20, scenarios: [
    { kind: "PARTIAL_FILLS",      perturbedExpectancyR: 0.18 },
    { kind: "LATENCY_SPIKES",     perturbedExpectancyR: 0.17 },
    { kind: "REJECTED_ORDERS",    perturbedExpectancyR: 0.16 },
    { kind: "BROKER_INSTABILITY", perturbedExpectancyR: -0.30 },  // breaking
    { kind: "EXECUTION_DELAYS",   perturbedExpectancyR: 0.16 },
  ]};
  const r = await j("POST", "/adversarial/validate", body);
  assert.notEqual(r.data.result.decision, "PROMOTE");
  assert.equal(r.data.result.allowedToPromote, false);
  assert.ok(r.data.result.adversarialFailurePoints.length >= 1);
  assert.ok(r.data.result.recommendedRestrictions.includes("REQUIRES_HIGH_QUALITY_BROKER"));
});

test("AV21 severe assumption violations force at least RESTRICT", async () => {
  const body = robustBundle();
  body.assumptionAudit = { assumptions: [
    { kind: "BROKER_AVAILABLE", holds: false, severity01: 0.9,
      recommendedRestriction: "REQUIRES_REDUNDANT_BROKER" },
    { kind: "FEED_REAL_TIME",   holds: false, severity01: 0.8,
      recommendedRestriction: "REQUIRES_PRIMARY_FEED" },
  ]};
  const r = await j("POST", "/adversarial/validate", body);
  assert.notEqual(r.data.result.decision, "PROMOTE");
  assert.ok(r.data.result.recommendedRestrictions.includes("REQUIRES_REDUNDANT_BROKER"));
  assert.ok(r.data.result.recommendedRestrictions.includes("REQUIRES_PRIMARY_FEED"));
  assert.ok(r.data.result.blockers.some(b => /SEVERE_ASSUMPTION_VIOLATIONS/.test(b)));
});

test("AV22 plain-English explanation describes the failure points", async () => {
  const body = robustBundle();
  body.regimeCollapse = { baselineExpectancyR: 0.20, scenarios: [
    { kind: "LIQUIDITY_COLLAPSE", perturbedExpectancyR: -0.30 },
  ]};
  const r = await j("POST", "/adversarial/validate", body);
  const exp = r.data.result.plainEnglishExplanation;
  assert.ok(exp.length > 0);
  assert.match(exp, /LIQUIDITY_COLLAPSE/);
  assert.match(exp, /regimeCollapse/);
});

// ── Anti-bypass invariants (architect-flagged) ─────────────────────────────

test("AV23 sparse-input bypass: missing categories fail closed (400)", async () => {
  // A caller that supplies only ONE robust category previously could
  // PROMOTE. /validate now requires all six attack categories.
  const r = await j("POST", "/adversarial/validate", {
    candidateId: CID,
    edgeFragility: { baselineExpectancyR: 0.20, attacks: robustEdge().attacks },
  });
  assert.equal(r.status, 400);
});

test("AV24 forged-result bypass: caller-computed result fields are rejected", async () => {
  // /validate accepts ONLY raw inputs. Submitting pre-computed result
  // fields (e.g. fragilityScore01, breakingPoints, attacks[].breaking)
  // must fail strict-schema validation, so a caller cannot suppress
  // breaking flags or under-report fragility to force a PROMOTE.
  const forged = {
    candidateId: CID,
    edgeFragility: {
      baselineExpectancyR: 0.20,
      attacks: robustEdge().attacks,
      // Forged result fields — must be rejected by .strict().
      fragilityScore01: 0,
      breakingPoints: [],
    },
    regimeCollapse:    { baselineExpectancyR: 0.20, scenarios: robustRegime().scenarios },
    executionSabotage: { baselineExpectancyR: 0.20, scenarios: robustExec().scenarios },
    behavioralStress:  { baselineExpectancyR: 0.20, scenarios: robustBehavior().scenarios },
    contradictionTest: { baselineExpectancyR: 0.20, scenarios: robustContradiction().scenarios },
    overfitExposure:   { baselineExpectancyR: 0.20, probes:    robustOverfit().probes },
  };
  const r = await j("POST", "/adversarial/validate", forged);
  assert.equal(r.status, 400);
});

test("AV25 forged scenario.breaking flags are IGNORED — engine recomputes", async () => {
  // Even if a caller could sneak per-scenario `breaking:false` past the
  // schema (it can't, .strict()), the route recomputes server-side using
  // the pure engines. Here we provide a catastrophic scenario; the engine
  // MUST flag it as breaking regardless.
  const body = robustBundle();
  body.executionSabotage = { baselineExpectancyR: 0.20, scenarios: [
    { kind: "BROKER_INSTABILITY", perturbedExpectancyR: -0.50 },
    { kind: "PARTIAL_FILLS",      perturbedExpectancyR: 0.18 },
  ]};
  const r = await j("POST", "/adversarial/validate", body);
  assert.notEqual(r.data.result.decision, "PROMOTE");
  assert.ok(r.data.result.adversarialFailurePoints.some(
    p => p.category === "executionSabotage" && p.attackKind === "BROKER_INSTABILITY"));
});

// ── Misc invariants ────────────────────────────────────────────────────────

test("AVZ1 adversarial endpoints never emit TRADE_*/MODE_*/SIGNAL_*", async () => {
  // Hit every per-engine endpoint plus the master /validate so we exercise
  // the full ADVERSARIAL_* namespace.
  await j("POST", "/adversarial/edge-fragility",     robustEdge());
  await j("POST", "/adversarial/regime-collapse",    robustRegime());
  await j("POST", "/adversarial/execution-sabotage", robustExec());
  await j("POST", "/adversarial/behavioral-stress",  robustBehavior());
  await j("POST", "/adversarial/contradiction-test", robustContradiction());
  await j("POST", "/adversarial/overfit-exposure",   robustOverfit());
  await j("POST", "/adversarial/assumption-audit",   holdingAssumptions());
  await j("POST", "/adversarial/validate",           robustBundle());
  const types = await vaultTypes();
  for (const t of types) {
    assert.ok(!/^TRADE_/.test(t),  `leaked TRADE_*: ${t}`);
    assert.ok(!/^MODE_/.test(t),   `leaked MODE_*: ${t}`);
    assert.ok(!/^SIGNAL_/.test(t), `leaked SIGNAL_*: ${t}`);
  }
  const adv = types.filter(t => t.startsWith("ADVERSARIAL_"));
  assert.ok(adv.length >= 8,
    `expected ≥8 ADVERSARIAL_* events, got ${adv.length} (${adv.join(",")})`);
});

test("AVZ2 invalid bodies return 400", async () => {
  const a = await j("POST", "/adversarial/edge-fragility", { candidateId: CID });
  assert.equal(a.status, 400);
  const b = await j("POST", "/adversarial/regime-collapse", {
    candidateId: CID, baselineExpectancyR: "nope", scenarios: [],
  });
  assert.equal(b.status, 400);
  const c = await j("POST", "/adversarial/validate", { candidateId: CID, edgeFragility: { foo: 1 } });
  assert.equal(c.status, 400);
  const d = await j("POST", "/adversarial/assumption-audit", {
    candidateId: CID,
    assumptions: [{ kind: "X", holds: true, severity01: 1.5 }],   // out of range
  });
  assert.equal(d.status, 400);
});
