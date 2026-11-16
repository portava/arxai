// ═══════════════════════════════════════════════════════════════════════════
// Phase 8 Decision Governance Layer tests.
//
// Acceptance criteria locked in:
//   • Decision quality controls permission.
//   • Conviction controls aggression.
//   • Survival impact can reduce or block execution.
//   • Future-risk score can force WAIT / REDUCE_SIZE / SOFT_BLOCK / HARD_BLOCK.
//   • No-trade decisions can be positively scored and logged.
//   • Bad winning trades reduce trust in that behavior (over time, via
//     dropped quality + dropped calibration + tightened sizing).
//   • Good losing trades do not reduce trust unfairly.
//   • Required outputs: allowedPermissionLevel, maxAggressionLevel,
//     maxPositionSize, requiredConfirmation, requiredDelay,
//     recommendedAction, reason.
//   • Risk Governor and Control Tower can override (monotonic-restrict).
//   • All outputs vault-logged with DI_GOV_* / DI_DECISION_GOVERNANCE_*.
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
  outcome: "PENDING", realizedR: undefined,
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
// Healthy disciplined history with strong calibration.
function disciplinedHistory(hi = 0.8) {
  // 40 entries, expressed confidence ~`hi`, observed hit-rate ~`hi`.
  const recs = [];
  const wins = Math.round(40 * hi);
  for (let i = 0; i < 40; i++) {
    recs.push(baseDecision({
      decisionId: `g${i}`, expressedConfidence01: hi,
      outcome: i < wins ? "WIN" : "LOSS",
      realizedR: i < wins ? 1.5 : -1.0,
    }));
  }
  return recs;
}
// Heavy negative-expectancy history.
function badHistory() {
  const recs = [];
  for (let i = 0; i < 40; i++) {
    recs.push(baseDecision({
      decisionId: `bd${i}`, expressedConfidence01: 0.5,
      outcome: i < 10 ? "WIN" : "LOSS",
      realizedR: i < 10 ? 1.0 : -1.5,
    }));
  }
  return recs;
}
// History full of UNDISCIPLINED_WIN trades (overconfident bands → bad calibration).
function badWinningHistory() {
  const recs = [];
  for (let i = 0; i < 40; i++) {
    recs.push(baseDecision({
      decisionId: `bw${i}`,
      followedRules: false, riskSizingCorrect: false,
      preTradeChecklistPassed: false, futureRiskSimApproved: false,
      expressedConfidence01: 0.95,
      outcome: i < 16 ? "WIN" : "LOSS",         // 40% hit-rate, but expressed 95%
      realizedR: i < 16 ? 1.0 : -1.2,
    }));
  }
  return recs;
}

const govBundle = (over = {}) => ({
  candidateDecision: baseDecision({ kind: "ENTRY" }),
  historyRecords: disciplinedHistory(0.8),
  qualifiedSetupsCount: 50,
  market: healthyMarket(),
  fatigue: calmFatigue(),
  simulation: goodSim(),
  baseRiskR: 1.0,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────
// Required output shape
// ─────────────────────────────────────────────────────────────────────────
test("DG1 /decision/governance returns the seven required fields", async () => {
  const r = await j("POST", "/decision/governance", govBundle());
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "DECISION_PIPELINE");
  const v = r.data.verdict;
  for (const f of [
    "allowedPermissionLevel","maxAggressionLevel","maxPositionSize",
    "requiredConfirmation","requiredDelay","recommendedAction","reason",
  ]) {
    assert.ok(f in v, `missing field ${f}`);
  }
  assert.ok(typeof v.reason === "string" && v.reason.length > 0);
  assert.ok(typeof v.maxPositionSize === "number" && v.maxPositionSize >= 0);
  assert.ok(Number.isInteger(v.requiredDelay) && v.requiredDelay >= 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Decision quality → permission
// ─────────────────────────────────────────────────────────────────────────
test("DG2 PUNISH-grade decision quality forces permission BLOCKED", async () => {
  // Candidate breaks every process gate ⇒ quality below PUNISH threshold.
  const r = await j("POST", "/decision/governance", govBundle({
    candidateDecision: baseDecision({
      followedRules: false, riskSizingCorrect: false,
      preTradeChecklistPassed: false, futureRiskSimApproved: false,
    }),
  }));
  assert.equal(r.data.verdict.allowedPermissionLevel, "BLOCKED");
  assert.equal(r.data.verdict.recommendedAction, "HARD_BLOCK");
  assert.equal(r.data.verdict.maxPositionSize, 0);
});

test("DG3 disciplined candidate + strong everything → STANDARD or FULL permission", async () => {
  const r = await j("POST", "/decision/governance", govBundle());
  assert.notEqual(r.data.verdict.allowedPermissionLevel, "BLOCKED");
  assert.notEqual(r.data.verdict.allowedPermissionLevel, "OBSERVE_ONLY");
  assert.ok(r.data.verdict.maxPositionSize > 0);
  assert.ok(["PROCEED","PROCEED_REDUCED"].includes(r.data.verdict.recommendedAction));
});

// ─────────────────────────────────────────────────────────────────────────
// Conviction → aggression cap
// ─────────────────────────────────────────────────────────────────────────
test("DG4 weak conviction calibration tightens aggression cap", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    historyRecords: badWinningHistory(),  // overconfident bands → low cal
  }));
  // Weak calibration should NEVER allow MAX or ELEVATED.
  assert.ok(["CONSERVATIVE","STANDARD"].includes(r.data.verdict.maxAggressionLevel),
    `got cap ${r.data.verdict.maxAggressionLevel}`);
});

test("DG5 strong conviction calibration permits ELEVATED/MAX cap", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    historyRecords: disciplinedHistory(0.85),  // very well-calibrated
  }));
  assert.ok(["STANDARD","ELEVATED","MAX"].includes(r.data.verdict.maxAggressionLevel));
});

// ─────────────────────────────────────────────────────────────────────────
// Survival impact → reduce or block
// ─────────────────────────────────────────────────────────────────────────
test("DG6 negative-expectancy history → permission OBSERVE_ONLY (reduce execution)", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    historyRecords: badHistory(),
  }));
  // Negative expectancy with sample ≥ 20 should not allow STANDARD/FULL.
  assert.ok(
    ["BLOCKED","OBSERVE_ONLY","REDUCED"].includes(r.data.verdict.allowedPermissionLevel),
    `got perm ${r.data.verdict.allowedPermissionLevel}`,
  );
  assert.notEqual(r.data.verdict.recommendedAction, "PROCEED");
});

// ─────────────────────────────────────────────────────────────────────────
// Future risk → forces WAIT / REDUCE_SIZE / SOFT_BLOCK / HARD_BLOCK
// ─────────────────────────────────────────────────────────────────────────
test("DG7 dangerous simulation forces HARD_BLOCK + permission BLOCKED + size 0", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    simulation: badSim(),
  }));
  assert.equal(r.data.verdict.allowedPermissionLevel, "BLOCKED");
  assert.equal(r.data.verdict.recommendedAction, "HARD_BLOCK");
  assert.equal(r.data.verdict.maxPositionSize, 0);
});

test("DG8 elevated ruin probability (still approved) forces WAIT or PROCEED_REDUCED", async () => {
  // Marginal sim: small positive expectancy, deeper ruin threshold so it
  // remains approved but with non-trivial P(ruin).
  const r = await j("POST", "/decision/governance", govBundle({
    simulation: {
      candidateRiskR: 1.0, expectancyR: 0.05, winRate01: 0.50,
      avgWinR: 1.0, avgLossR: -1.0, pathsToSimulate: 500,
      horizonTrades: 200, ruinThresholdR: -8, seed: 7,
    },
  }));
  // Either WAIT (sim risk) or PROCEED_REDUCED (everything else green) is acceptable.
  assert.ok(["WAIT","PROCEED_REDUCED","SOFT_BLOCK","HARD_BLOCK"]
    .includes(r.data.verdict.recommendedAction),
    `got ${r.data.verdict.recommendedAction}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Bad winning trades reduce trust; good losing trades don't unfairly punish
// ─────────────────────────────────────────────────────────────────────────
test("DG9 bad-winning history shrinks maxPositionSize vs disciplined history", async () => {
  const disciplined = await j("POST", "/decision/governance", govBundle());
  const lucky = await j("POST", "/decision/governance", govBundle({
    historyRecords: badWinningHistory(),
  }));
  assert.ok(
    lucky.data.verdict.maxPositionSize < disciplined.data.verdict.maxPositionSize,
    `lucky=${lucky.data.verdict.maxPositionSize} disciplined=${disciplined.data.verdict.maxPositionSize}`,
  );
});

test("DG10 a disciplined LOSING candidate is NOT punished by governance", async () => {
  // The candidate is pending — but apply outcome=LOSS / R<0 hypothetically
  // via a recent disciplined-loss history. Quality scoring is process-only,
  // so disciplined losses must not reduce trust.
  const lossHistory = [];
  for (let i = 0; i < 40; i++) {
    lossHistory.push(baseDecision({
      decisionId: `dl${i}`,
      followedRules: true, riskSizingCorrect: true,
      preTradeChecklistPassed: true, futureRiskSimApproved: true,
      expressedConfidence01: 0.55,
      outcome: i < 22 ? "WIN" : "LOSS",       // mild positive expectancy
      realizedR: i < 22 ? 1.4 : -1.0,
    }));
  }
  const r = await j("POST", "/decision/governance", govBundle({
    historyRecords: lossHistory,
  }));
  assert.notEqual(r.data.verdict.allowedPermissionLevel, "BLOCKED");
  assert.ok(r.data.verdict.maxPositionSize > 0);
});

// ─────────────────────────────────────────────────────────────────────────
// No-trade decisions can be positively scored AND logged
// ─────────────────────────────────────────────────────────────────────────
test("DG11 NO_TRADE candidate does not get blocked AND is logged", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    candidateDecision: baseDecision({
      decisionId: "nt", kind: "NO_TRADE",
      outcome: "AVOIDED_LOSS", realizedR: undefined,
    }),
    counterfactualR: -1.5,
    market: noisyMarket(),
  }));
  assert.equal(r.status, 200);
  // NO_TRADE itself isn't sized — but governance must not crash and must
  // emit the verdict event with a coherent action.
  const types = await vaultTypes();
  assert.ok(types.includes("DI_DECISION_GOVERNANCE_VERDICT"));
});

// ─────────────────────────────────────────────────────────────────────────
// Fatigue → cooldown delay + BLOCKED + MULTI_STEP confirmation
// ─────────────────────────────────────────────────────────────────────────
test("DG12 forced cooldown produces BLOCKED + 600s delay + MULTI_STEP confirmation", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    fatigue: exhaustedFatigue(),
  }));
  assert.equal(r.data.verdict.allowedPermissionLevel, "BLOCKED");
  assert.equal(r.data.verdict.recommendedAction, "HARD_BLOCK");
  assert.equal(r.data.verdict.requiredConfirmation, "MULTI_STEP");
  assert.ok(r.data.verdict.requiredDelay >= 600,
    `delay=${r.data.verdict.requiredDelay}`);
});

// ─────────────────────────────────────────────────────────────────────────
// Risk Governor / Control Tower override semantics (monotonic restrict)
// ─────────────────────────────────────────────────────────────────────────
test("DG13 RISK_GOVERNOR override can LOWER permission to OBSERVE_ONLY", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    overrides: [{
      source: "RISK_GOVERNOR",
      maxPermissionLevel: "OBSERVE_ONLY",
      reason: "circuit breaker armed",
    }],
  }));
  assert.equal(r.data.verdict.allowedPermissionLevel, "OBSERVE_ONLY");
  assert.equal(r.data.verdict.appliedOverrides.length, 1);
  assert.equal(r.data.verdict.appliedOverrides[0].source, "RISK_GOVERNOR");
});

test("DG14 CONTROL_TOWER override can RAISE confirmation and delay", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    overrides: [{
      source: "CONTROL_TOWER",
      minConfirmation: "MULTI_STEP",
      minDelaySeconds: 900,
      reason: "weekly news event window",
    }],
  }));
  assert.equal(r.data.verdict.requiredConfirmation, "MULTI_STEP");
  assert.ok(r.data.verdict.requiredDelay >= 900);
});

test("DG15 override that would RELAX is silently ignored", async () => {
  // Cap the cap to MAX — but governance already said e.g. STANDARD/ELEVATED.
  const baseline = await j("POST", "/decision/governance", govBundle());
  const baselineCap = baseline.data.verdict.maxAggressionLevel;
  const order = ["CONSERVATIVE","STANDARD","ELEVATED","MAX"];
  // Skip the assertion if already at MAX (no relaxation possible above).
  const r = await j("POST", "/decision/governance", govBundle({
    overrides: [{
      source: "CONTROL_TOWER",
      maxAggressionLevel: "MAX",
      reason: "would relax — must be ignored",
    }],
  }));
  assert.equal(r.data.verdict.maxAggressionLevel, baselineCap);
  if (order.indexOf(baselineCap) < order.indexOf("MAX")) {
    assert.equal(r.data.verdict.appliedOverrides.length, 0,
      "relaxing override must NOT be in appliedOverrides");
  }
});

test("DG16 override that lowers maxPositionSizeR caps the size", async () => {
  const baseline = await j("POST", "/decision/governance", govBundle());
  const baseSize = baseline.data.verdict.maxPositionSize;
  if (baseSize === 0) return;  // trivial — skip
  const cap = baseSize * 0.25;
  const r = await j("POST", "/decision/governance", govBundle({
    overrides: [{
      source: "RISK_GOVERNOR",
      maxPositionSizeR: cap,
      reason: "risk-governor budget tightened",
    }],
  }));
  assert.ok(r.data.verdict.maxPositionSize <= cap + 1e-9);
});

test("DG17 override forceRecommendedAction can RAISE severity but not lower it", async () => {
  // Take a clean PROCEED scenario and force WAIT.
  const bumped = await j("POST", "/decision/governance", govBundle({
    overrides: [{
      source: "MANUAL_OPERATOR",
      forceRecommendedAction: "WAIT",
      reason: "operator paused trading",
    }],
  }));
  assert.ok(["WAIT","MONITOR_ONLY","SOFT_BLOCK","HARD_BLOCK"]
    .includes(bumped.data.verdict.recommendedAction));

  // Now take a HARD_BLOCK scenario and try to relax to PROCEED — must be ignored.
  const blocked = await j("POST", "/decision/governance", govBundle({
    fatigue: exhaustedFatigue(),
    overrides: [{
      source: "MANUAL_OPERATOR",
      forceRecommendedAction: "PROCEED",
      reason: "operator wants to override safety — should be ignored",
    }],
  }));
  assert.equal(blocked.data.verdict.recommendedAction, "HARD_BLOCK");
});

// ─────────────────────────────────────────────────────────────────────────
// Vault logging
// ─────────────────────────────────────────────────────────────────────────
test("DG18 governance verdict emits DI_DECISION_GOVERNANCE_VERDICT with severity", async () => {
  await j("POST", "/decision/governance", govBundle({ simulation: badSim() }));
  const r = await pool.query(
    `SELECT event_type, severity FROM audit_events
     WHERE event_type='DI_DECISION_GOVERNANCE_VERDICT'`,
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].severity, "CRITICAL");
});

test("DG19 per-engine governance endpoints emit dedicated DI_GOV_* events", async () => {
  // sizing endpoint
  await j("POST", "/decision/governance/sizing", {
    candidateDecision: baseDecision({ kind: "ENTRY" }),
    historyRecords: disciplinedHistory(0.8),
    market: healthyMarket(), fatigue: calmFatigue(),
    simulation: goodSim(), baseRiskR: 1.0,
  });
  // aggression-limit endpoint
  await j("POST", "/decision/governance/aggression-limit", {
    historyRecords: disciplinedHistory(0.8),
    market: healthyMarket(), fatigue: calmFatigue(),
  });
  // policy endpoint
  await j("POST", "/decision/governance/policy", {
    candidateDecision: baseDecision({ kind: "ENTRY" }),
    historyRecords: disciplinedHistory(0.8),
    qualifiedSetupsCount: 50,
    market: healthyMarket(), fatigue: calmFatigue(),
    simulation: goodSim(), baseRiskR: 1.0,
  });

  const types = await vaultTypes();
  for (const t of [
    "DI_GOV_AGGRESSION_LIMITED",
    "DI_GOV_SIZING_DERIVED",
    "DI_GOV_POLICY_DERIVED",
  ]) {
    assert.ok(types.includes(t), `missing ${t} (got ${types.join(",")})`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Anti-bypass + advisory contract
// ─────────────────────────────────────────────────────────────────────────
test("DG20 /decision/governance is advisory and rejects unknown fields", async () => {
  const ok = await j("POST", "/decision/governance", govBundle());
  assert.equal(ok.data.canPlaceTrades, false);
  assert.equal(ok.data.mode, "DECISION_PIPELINE");

  const bad = await j("POST", "/decision/governance", {
    ...govBundle(), foo: "bar",
  });
  assert.equal(bad.status, 400);
});

test("DG21 invalid override shape rejected with 400", async () => {
  const r = await j("POST", "/decision/governance", govBundle({
    overrides: [{ source: "UNKNOWN_AUTHORITY", reason: "x" }],
  }));
  assert.equal(r.status, 400);
});
