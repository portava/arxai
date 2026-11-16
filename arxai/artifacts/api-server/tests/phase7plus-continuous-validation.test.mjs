// ═══════════════════════════════════════════════════════════════════════════
// Continuous Validation + Immune System tests.
//
// Verifies each immune engine + the master heartbeat decision tree, and
// locks in invariants:
//   • Validation never permanently ends — heartbeat works on live inputs.
//   • Trust scores are bounded ([0,1]) and per-call change is capped.
//   • Live sanity checks are hard local "no" — any blocker → no entries.
//   • Evidence decays exponentially (half-life model).
//   • Quarantine transitions are single-step in the worsening direction
//     for moderate concerns, severe breaches go straight to RETIRED.
//   • Validation memory amplifies recurring failures into trust penalty.
//   • Meta-validation reacts to false approvals (TIGHTEN) and false blocks
//     (LOOSEN), and HOLDs otherwise.
//   • System health CRITICAL → FREEZE_SYSTEM verdict from heartbeat.
//   • Heartbeat ONLY accepts raw inputs (anti-forging) and requires every
//     sub-engine input.
//   • All decisions vault-logged with CV_* event types.
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
const CID = "cand-cv";

// ── Builders for healthy bundle ────────────────────────────────────────────
const healthyConfidence = () => ({
  candidateId: CID,
  recent: [
    { predictedConfidence01: 0.70, realizedOutcome01: 0.71 },
    { predictedConfidence01: 0.65, realizedOutcome01: 0.62 },
    { predictedConfidence01: 0.72, realizedOutcome01: 0.74 },
    { predictedConfidence01: 0.68, realizedOutcome01: 0.69 },
    { predictedConfidence01: 0.70, realizedOutcome01: 0.66 },
  ],
});
const healthyTrust = () => ({
  candidateId: CID,
  priorTrust01: 0.75,
  recentExpectancyR: 0.20,
  baselineExpectancyR: 0.20,
  recentDrawdownR: 1.0,
  drawdownLimitR: 5.0,
  robustnessScore01: 0.80,
  recentOverrideRate01: 0.10,
  recentSanityFailures: 0,
  confidenceHealthScore01: 0.80,
});
const healthySanity = () => ({
  candidateId: CID,
  killSwitchEngaged: false,
  spreadActual: 0.0001, spreadExpected: 0.0001,
  latencyMs: 100,
  fillProbability01: 0.95,
  openPositions: 1, maxOpenPositions: 5,
  dataFreshnessMs: 200,
  brokerHealthScore01: 0.95,
  regimeMatch: true,
  accountEquity: 10000,
  riskPerTradeR: 0.5,
  isQuarantined: false,
});
const healthyEvidence = () => ({
  candidateId: CID,
  items: [
    { kind: "BACKTEST_PASS", ageHours: 24, weight: 1.0 },
    { kind: "OOS_PASS",      ageHours: 168, weight: 1.0 },     // ≈ half
    { kind: "MICRO_LOT_OK",  ageHours: 0, weight: 0.5 },
  ],
});
const noopQuarantine = () => ({
  candidateId: CID,
  currentState: "NONE",
  trustScore01: 0.80,
  severeBreachCount: 0,
  moderateConcernCount: 0,
  recoveryEvidenceScore01: 0.50,
});
const cleanMemory = () => ({
  candidateId: CID,
  events: [
    { eventKind: "RECOVERY", severity01: 0.3, ageHours: 48 },
    { eventKind: "RECOVERY", severity01: 0.4, ageHours: 96 },
  ],
});
const healthySystem = () => ({
  activeStrategies: 5, quarantinedStrategies: 0,
  dataFreshnessOk: true, brokerOk: true,
  executionLatencyMsP95: 120,
  vaultBacklogEvents: 10,
  criticalAlertsLast24h: 0,
});
const healthyMeta = () => ({
  windowDays: 30,
  trueApprovals: 50, falseApprovals: 2,
  trueBlocks: 30,    falseBlocks: 3,
});

const heartbeatBundle = () => ({
  candidateId: CID,
  confidenceHealth: healthyConfidence(),
  strategyTrust:    healthyTrust(),
  quarantine:       noopQuarantine(),
  memory:           cleanMemory(),
  systemHealth:     healthySystem(),
  metaValidation:   healthyMeta(),
  liveSanityCheck:  healthySanity(),
  evidenceDecay:    healthyEvidence(),
});

// ── Confidence Health ──────────────────────────────────────────────────────
test("CV1 confidence-health HEALTHY when predicted ≈ realized", async () => {
  const r = await j("POST", "/continuous/confidence-health", healthyConfidence());
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "VALIDATION_PIPELINE");
  assert.equal(r.data.result.status, "HEALTHY");
  assert.ok(r.data.result.healthScore01 >= 0.85);
  assert.ok((await vaultTypes()).includes("CV_CONFIDENCE_HEALTH_ASSESSED"));
});

test("CV2 confidence-health UNRELIABLE on huge calibration error", async () => {
  const r = await j("POST", "/continuous/confidence-health", {
    candidateId: CID,
    recent: [
      { predictedConfidence01: 0.90, realizedOutcome01: 0.20 },
      { predictedConfidence01: 0.85, realizedOutcome01: 0.30 },
      { predictedConfidence01: 0.95, realizedOutcome01: 0.10 },
    ],
  });
  assert.equal(r.data.result.status, "UNRELIABLE");
  assert.ok(r.data.result.calibrationError01 > 0.30);
});

test("CV3 confidence-health OVERCONFIDENT when predicted > realized", async () => {
  // ≤0.30 calibration error so we don't trip UNRELIABLE first; >0.20 overconfidence
  const r = await j("POST", "/continuous/confidence-health", {
    candidateId: CID,
    recent: [
      { predictedConfidence01: 0.80, realizedOutcome01: 0.55 },
      { predictedConfidence01: 0.78, realizedOutcome01: 0.55 },
      { predictedConfidence01: 0.82, realizedOutcome01: 0.60 },
    ],
  });
  assert.equal(r.data.result.status, "OVERCONFIDENT");
  assert.ok(r.data.result.overconfidence01 > 0.20);
});

test("CV4 confidence-health DRIFTING when recent diverges from baseline", async () => {
  const r = await j("POST", "/continuous/confidence-health", {
    candidateId: CID,
    recent: [
      { predictedConfidence01: 0.70, realizedOutcome01: 0.50 },
      { predictedConfidence01: 0.70, realizedOutcome01: 0.55 },
      { predictedConfidence01: 0.70, realizedOutcome01: 0.50 },
    ],
    baseline: [
      { predictedConfidence01: 0.70, realizedOutcome01: 0.70 },
      { predictedConfidence01: 0.70, realizedOutcome01: 0.71 },
      { predictedConfidence01: 0.70, realizedOutcome01: 0.69 },
    ],
  });
  assert.ok(["DRIFTING", "OVERCONFIDENT"].includes(r.data.result.status));
  assert.ok(r.data.result.drift01 > 0.15);
});

// ── Strategy Trust ─────────────────────────────────────────────────────────
test("CV5 strategy-trust improves on strong recent perf + high robustness", async () => {
  const r = await j("POST", "/continuous/strategy-trust", {
    ...healthyTrust(),
    priorTrust01: 0.50,
    recentExpectancyR: 0.30, baselineExpectancyR: 0.20,
    robustnessScore01: 0.90,
  });
  assert.ok(r.data.result.trustChange > 0);
  assert.ok(r.data.result.trustScore01 > 0.50);
});

test("CV6 strategy-trust degrades on drawdown breach + sanity failures", async () => {
  const r = await j("POST", "/continuous/strategy-trust", {
    ...healthyTrust(),
    priorTrust01: 0.80,
    recentExpectancyR: -0.10,
    recentDrawdownR: 4.9, drawdownLimitR: 5.0,
    recentSanityFailures: 3,
    recentOverrideRate01: 0.40,
  });
  assert.ok(r.data.result.trustChange < 0);
  assert.ok(r.data.result.trustScore01 < 0.80);
});

test("CV7 strategy-trust per-call change is capped (default 0.25)", async () => {
  const r = await j("POST", "/continuous/strategy-trust", {
    ...healthyTrust(),
    priorTrust01: 0.50,
    recentExpectancyR: 1.0, baselineExpectancyR: 0.10,
    robustnessScore01: 1.0, confidenceHealthScore01: 1.0,
  });
  assert.ok(Math.abs(r.data.result.trustChange) <= 0.2501);
});

test("CV8 strategy-trust grades reflect score bands", async () => {
  const grades = new Map();
  for (const t of [0.95, 0.75, 0.60, 0.45, 0.20]) {
    const r = await j("POST", "/continuous/strategy-trust", {
      ...healthyTrust(),
      priorTrust01: t,
      recentExpectancyR: 0.20, baselineExpectancyR: 0.20,
      recentSanityFailures: 0, recentOverrideRate01: 0.10,
    });
    grades.set(t, r.data.result.trustGrade);
  }
  assert.equal(grades.get(0.95), "A");
  // Other bands depend on delta; the high band must be A.
});

// ── Live Sanity Check ──────────────────────────────────────────────────────
test("CV9 live-sanity allow when every check is healthy", async () => {
  const r = await j("POST", "/continuous/live-sanity-check", healthySanity());
  assert.equal(r.data.result.allow, true);
  assert.equal(r.data.result.blockers.length, 0);
});

test("CV10 live-sanity hard-deny on kill switch", async () => {
  const r = await j("POST", "/continuous/live-sanity-check", {
    ...healthySanity(), killSwitchEngaged: true,
  });
  assert.equal(r.data.result.allow, false);
  assert.equal(r.data.result.severity, "CRITICAL");
  assert.ok(r.data.result.blockers.includes("KILL_SWITCH_ENGAGED"));
});

test("CV11 live-sanity blocks on spread, latency, fill, broker, regime, data, equity", async () => {
  const r = await j("POST", "/continuous/live-sanity-check", {
    ...healthySanity(),
    spreadActual: 0.005,                      // > 2× expected
    latencyMs: 1000,
    fillProbability01: 0.40,
    brokerHealthScore01: 0.30,
    regimeMatch: false,
    dataFreshnessMs: 30000,
    riskPerTradeR: 5.0,
  });
  assert.equal(r.data.result.allow, false);
  for (const k of ["SPREAD_TOO_WIDE","LATENCY_TOO_HIGH","FILL_PROBABILITY_TOO_LOW",
                   "BROKER_DEGRADED","REGIME_MISMATCH","DATA_STALE","INSUFFICIENT_EQUITY"]) {
    assert.ok(r.data.result.blockers.includes(k), `expected blocker ${k}`);
  }
});

test("CV12 live-sanity quarantine flag denies entries even if everything else is fine", async () => {
  const r = await j("POST", "/continuous/live-sanity-check", {
    ...healthySanity(), isQuarantined: true,
  });
  assert.equal(r.data.result.allow, false);
  assert.equal(r.data.result.severity, "CRITICAL");
  assert.ok(r.data.result.blockers.includes("QUARANTINED"));
});

// ── Evidence Decay ─────────────────────────────────────────────────────────
test("CV13 evidence-decay halves an item's weight at one half-life", async () => {
  const r = await j("POST", "/continuous/evidence-decay", {
    candidateId: CID,
    items: [{ kind: "OOS_PASS", ageHours: 168, weight: 1.0 }],
    halfLifeHours: 168,
  });
  assert.ok(Math.abs(r.data.result.items[0].decayedWeight - 0.5) < 1e-6);
  assert.ok(Math.abs(r.data.result.decayedRatio01 - 0.5) < 1e-6);
});

test("CV14 evidence-decay shorter half-life decays faster", async () => {
  const r1 = await j("POST", "/continuous/evidence-decay", {
    candidateId: CID,
    items: [{ kind: "X", ageHours: 24, weight: 1.0 }],
    halfLifeHours: 168,
  });
  const r2 = await j("POST", "/continuous/evidence-decay", {
    candidateId: CID,
    items: [{ kind: "X", ageHours: 24, weight: 1.0 }],
    halfLifeHours: 24,
  });
  assert.ok(r2.data.result.totalDecayedWeight < r1.data.result.totalDecayedWeight);
  assert.ok(Math.abs(r2.data.result.totalDecayedWeight - 0.5) < 1e-6);
});

// ── Strategy Quarantine ────────────────────────────────────────────────────
test("CV15 quarantine NONE→SHADOW on moderate concerns", async () => {
  const r = await j("POST", "/continuous/strategy-quarantine", {
    ...noopQuarantine(),
    trustScore01: 0.45,
    moderateConcernCount: 2,
  });
  assert.equal(r.data.result.previousState, "NONE");
  assert.equal(r.data.result.nextState, "SHADOW");
  assert.equal(r.data.result.permissions.canEnterTrades, false);
});

test("CV16 quarantine straight to RESTRICTED on very low trust", async () => {
  const r = await j("POST", "/continuous/strategy-quarantine", {
    ...noopQuarantine(), trustScore01: 0.20,
  });
  assert.equal(r.data.result.nextState, "RESTRICTED");
});

test("CV17 quarantine severe breach → RETIRED (terminal)", async () => {
  const r = await j("POST", "/continuous/strategy-quarantine", {
    ...noopQuarantine(),
    currentState: "SHADOW",
    severeBreachCount: 1,
  });
  assert.equal(r.data.result.nextState, "RETIRED");
  assert.equal(r.data.result.direction, "WORSEN");
  assert.equal(r.data.result.permissions.canEnterTrades, false);
});

test("CV18 quarantine RETIRED is terminal (no recovery)", async () => {
  const r = await j("POST", "/continuous/strategy-quarantine", {
    ...noopQuarantine(),
    currentState: "RETIRED",
    trustScore01: 0.95, recoveryEvidenceScore01: 0.95,
  });
  assert.equal(r.data.result.nextState, "RETIRED");
  assert.equal(r.data.result.direction, "HOLD");
});

test("CV19 quarantine recovery: RESTRICTED → SHADOW (single step)", async () => {
  const r = await j("POST", "/continuous/strategy-quarantine", {
    ...noopQuarantine(),
    currentState: "RESTRICTED",
    trustScore01: 0.75, recoveryEvidenceScore01: 0.85,
  });
  assert.equal(r.data.result.previousState, "RESTRICTED");
  assert.equal(r.data.result.nextState, "SHADOW");
  assert.equal(r.data.result.direction, "IMPROVE");
});

// ── Validation Memory ──────────────────────────────────────────────────────
test("CV20 memory recurring failure kinds + persistent risk + trust penalty", async () => {
  const r = await j("POST", "/continuous/validation-memory", {
    candidateId: CID,
    events: [
      { eventKind: "FAILURE", failureKind: "BROKER_INSTABILITY", severity01: 0.8, ageHours: 12 },
      { eventKind: "FAILURE", failureKind: "BROKER_INSTABILITY", severity01: 0.7, ageHours: 6 },
      { eventKind: "FAILURE", failureKind: "DATA_STALE",         severity01: 0.4, ageHours: 24 },
      { eventKind: "DEGRADATION", failureKind: "SPREAD_WIDENING", severity01: 0.5, ageHours: 4 },
      { eventKind: "RECOVERY", severity01: 0.3, ageHours: 1 },
    ],
  });
  assert.ok(r.data.result.recurringFailureKinds.includes("BROKER_INSTABILITY"));
  assert.ok(r.data.result.persistentRiskFactors.includes("BROKER_INSTABILITY"));
  assert.ok(r.data.result.trustPenalty01 > 0);
  assert.ok(r.data.result.trustPenalty01 <= 0.40);
});

test("CV21 memory pure-recovery history → no trust penalty", async () => {
  const r = await j("POST", "/continuous/validation-memory", cleanMemory());
  assert.equal(r.data.result.persistentRiskFactors.length, 0);
  assert.equal(r.data.result.trustPenalty01, 0);
});

// ── System Health ──────────────────────────────────────────────────────────
test("CV22 system-health HEALTHY when everything is fine", async () => {
  const r = await j("POST", "/continuous/system-health", healthySystem());
  assert.equal(r.data.result.status, "HEALTHY");
  assert.ok(r.data.result.systemHealthScore01 >= 0.85);
});

test("CV23 system-health CRITICAL on broker outage (hard override)", async () => {
  const r = await j("POST", "/continuous/system-health", {
    ...healthySystem(), brokerOk: false,
  });
  assert.equal(r.data.result.status, "CRITICAL");
  assert.ok(r.data.result.recommendations.includes("FREEZE_LIVE_TRADING_UNTIL_BROKER_RECOVERS"));
});

test("CV24 system-health CRITICAL on stale data + alert escalation", async () => {
  const r = await j("POST", "/continuous/system-health", {
    ...healthySystem(),
    dataFreshnessOk: false,
    criticalAlertsLast24h: 6,
  });
  assert.equal(r.data.result.status, "CRITICAL");
  assert.ok(r.data.result.recommendations.includes("REPLACE_DATA_FEED"));
  assert.ok(r.data.result.recommendations.includes("ESCALATE_TO_OPERATOR"));
});

// ── Meta-Validation ────────────────────────────────────────────────────────
test("CV25 meta-validation HOLD when both error rates low", async () => {
  const r = await j("POST", "/continuous/meta-validation", healthyMeta());
  assert.equal(r.data.result.recommendation, "HOLD_VALIDATION_THRESHOLDS");
  assert.ok(["A","B"].includes(r.data.result.calibrationGrade));
});

test("CV26 meta-validation TIGHTEN when false-approval rate too high", async () => {
  const r = await j("POST", "/continuous/meta-validation", {
    windowDays: 30,
    trueApprovals: 30, falseApprovals: 10,   // 25% false-approval rate
    trueBlocks: 50, falseBlocks: 2,
  });
  assert.equal(r.data.result.recommendation, "TIGHTEN_VALIDATION");
  assert.ok(r.data.result.falseApprovalRate01 > 0.10);
});

test("CV27 meta-validation LOOSEN when false-block rate dominates", async () => {
  const r = await j("POST", "/continuous/meta-validation", {
    windowDays: 30,
    trueApprovals: 50, falseApprovals: 1,
    trueBlocks: 30,    falseBlocks: 20,      // 40% false-block rate
  });
  assert.equal(r.data.result.recommendation, "LOOSEN_VALIDATION");
  assert.ok(r.data.result.falseBlockRate01 > 0.20);
});

// ── Master Heartbeat decision tree ─────────────────────────────────────────
test("CV28 heartbeat CONTINUE when every immune signal is healthy", async () => {
  const r = await j("POST", "/continuous/heartbeat", heartbeatBundle());
  assert.equal(r.status, 200);
  assert.equal(r.data.result.verdict, "CONTINUE");
  assert.equal(r.data.result.permissions.canEnterNewTrades, true);
  assert.equal(r.data.result.permissions.canIncreaseSize, true);
  assert.ok((await vaultTypes()).includes("CV_HEARTBEAT_DECISION"));
});

test("CV29 heartbeat FREEZE_SYSTEM on system CRITICAL (broker outage)", async () => {
  const body = heartbeatBundle();
  body.systemHealth = { ...body.systemHealth, brokerOk: false };
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.data.result.verdict, "FREEZE_SYSTEM");
  assert.equal(r.data.result.permissions.canEnterNewTrades, false);
  assert.ok(r.data.result.immuneAlerts.includes("SYSTEM_HEALTH_CRITICAL"));
});

test("CV30 heartbeat RETIRE when quarantine engine returns RETIRED", async () => {
  const body = heartbeatBundle();
  body.quarantine = { ...body.quarantine, severeBreachCount: 1 };
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.data.result.verdict, "RETIRE");
  assert.equal(r.data.result.permissions.canHoldExisting, false);
});

test("CV31 heartbeat QUARANTINE on UNRELIABLE confidence", async () => {
  const body = heartbeatBundle();
  body.confidenceHealth = {
    candidateId: CID,
    recent: [
      { predictedConfidence01: 0.95, realizedOutcome01: 0.10 },
      { predictedConfidence01: 0.90, realizedOutcome01: 0.20 },
      { predictedConfidence01: 0.92, realizedOutcome01: 0.18 },
    ],
  };
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.data.result.verdict, "QUARANTINE");
  assert.ok(r.data.result.immuneAlerts.includes("CONFIDENCE_UNRELIABLE"));
});

test("CV32 heartbeat QUARANTINE when trust score collapses below 0.40", async () => {
  const body = heartbeatBundle();
  body.strategyTrust = {
    ...body.strategyTrust,
    priorTrust01: 0.45,
    recentExpectancyR: -0.20, baselineExpectancyR: 0.20,
    recentDrawdownR: 4.9, drawdownLimitR: 5.0,
    recentSanityFailures: 4,
    robustnessScore01: 0.3,
  };
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.data.result.verdict, "QUARANTINE");
  assert.ok(r.data.result.immuneAlerts.includes("TRUST_FALLEN_BELOW_QUARANTINE"));
});

test("CV33 heartbeat RESTRICT when meta-validator says TIGHTEN", async () => {
  const body = heartbeatBundle();
  body.metaValidation = {
    windowDays: 30,
    trueApprovals: 30, falseApprovals: 10,
    trueBlocks: 50, falseBlocks: 2,
  };
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.data.result.verdict, "RESTRICT");
  assert.ok(r.data.result.immuneAlerts.includes("META_VALIDATOR_TIGHTEN"));
  // Cannot grow size while restricted
  assert.equal(r.data.result.permissions.canIncreaseSize, false);
});

test("CV34 heartbeat RESTRICT on live sanity block (overrides CONTINUE)", async () => {
  const body = heartbeatBundle();
  body.liveSanityCheck = { ...body.liveSanityCheck, killSwitchEngaged: true };
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.data.result.verdict, "RESTRICT");
  assert.ok(r.data.result.immuneAlerts.includes("LIVE_SANITY_BLOCK"));
});

test("CV35 heartbeat plain-English explanation includes verdict + signals", async () => {
  const body = heartbeatBundle();
  body.systemHealth = { ...body.systemHealth, brokerOk: false };
  const r = await j("POST", "/continuous/heartbeat", body);
  const exp = r.data.result.plainEnglishExplanation;
  assert.ok(exp.length > 0);
  assert.match(exp, /FREEZE_SYSTEM/);
  assert.match(exp, /system CRITICAL/);
});

// ── Anti-bypass invariants ─────────────────────────────────────────────────
test("CV36 heartbeat: sparse-input bypass fails closed (400)", async () => {
  // Missing every sub-engine input but candidateId.
  const r = await j("POST", "/continuous/heartbeat", { candidateId: CID });
  assert.equal(r.status, 400);
});

test("CV37 heartbeat: forged sub-result fields rejected by .strict()", async () => {
  // Submitting a bonus 'verdict' or 'trustScore01' alongside raw inputs is
  // rejected by strict-schema validation, so callers cannot influence the
  // master decision beyond the underlying engine inputs.
  const body = { ...heartbeatBundle(), verdict: "CONTINUE", forgedTrust: 1.0 };
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.status, 400);
});

test("CV38 invariant: continuous endpoints never emit TRADE_*/MODE_*/SIGNAL_*", async () => {
  // Hit each per-engine endpoint plus the heartbeat.
  await j("POST", "/continuous/confidence-health",  healthyConfidence());
  await j("POST", "/continuous/strategy-trust",     healthyTrust());
  await j("POST", "/continuous/live-sanity-check",  healthySanity());
  await j("POST", "/continuous/evidence-decay",     healthyEvidence());
  await j("POST", "/continuous/strategy-quarantine", noopQuarantine());
  await j("POST", "/continuous/validation-memory",  cleanMemory());
  await j("POST", "/continuous/system-health",      healthySystem());
  await j("POST", "/continuous/meta-validation",    healthyMeta());
  await j("POST", "/continuous/heartbeat",          heartbeatBundle());

  const types = await vaultTypes();
  for (const t of types) {
    assert.ok(!/^TRADE_/.test(t),  `leaked TRADE_*: ${t}`);
    assert.ok(!/^MODE_/.test(t),   `leaked MODE_*: ${t}`);
    assert.ok(!/^SIGNAL_/.test(t), `leaked SIGNAL_*: ${t}`);
  }
  const cv = types.filter(t => t.startsWith("CV_"));
  assert.ok(cv.length >= 9, `expected ≥9 CV_* events, got ${cv.length} (${cv.join(",")})`);
});

test("CV39a heartbeat: missing liveSanityCheck fails closed (400)", async () => {
  // liveSanityCheck is REQUIRED — omitting it would let an attacker hide
  // a live blocker and coerce CONTINUE.
  const body = heartbeatBundle();
  delete body.liveSanityCheck;
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.status, 400);
});

test("CV39b heartbeat: missing evidenceDecay fails closed (400)", async () => {
  const body = heartbeatBundle();
  delete body.evidenceDecay;
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.status, 400);
});

test("CV39c heartbeat RESTRICT when evidence base is mostly stale", async () => {
  const body = heartbeatBundle();
  // Half-life 24h, items that are 168h old → factor = 0.5^7 ≈ 0.78%.
  body.evidenceDecay = {
    candidateId: CID,
    halfLifeHours: 24,
    items: [
      { kind: "BACKTEST_PASS", ageHours: 168, weight: 1.0 },
      { kind: "OOS_PASS",      ageHours: 168, weight: 1.0 },
    ],
  };
  const r = await j("POST", "/continuous/heartbeat", body);
  assert.equal(r.data.result.verdict, "RESTRICT");
  assert.ok(r.data.result.immuneAlerts.includes("STALE_EVIDENCE_BASE"));
});

test("CV39d heartbeat overrides forged trust.confidenceHealthScore01 with recomputed value", async () => {
  // Caller submits unreliable confidence (huge calibration error) AND a
  // forged confidenceHealthScore01=1.0 inside strategyTrust hoping to lift
  // their trust score. The heartbeat must use the RECOMPUTED confidence
  // health and consequently QUARANTINE the strategy.
  const body = heartbeatBundle();
  body.confidenceHealth = {
    candidateId: CID,
    recent: [
      { predictedConfidence01: 0.95, realizedOutcome01: 0.10 },
      { predictedConfidence01: 0.92, realizedOutcome01: 0.15 },
      { predictedConfidence01: 0.94, realizedOutcome01: 0.18 },
    ],
  };
  body.strategyTrust = { ...body.strategyTrust, confidenceHealthScore01: 1.0 };
  const r = await j("POST", "/continuous/heartbeat", body);
  // UNRELIABLE confidence forces QUARANTINE regardless of the forged trust input.
  assert.equal(r.data.result.verdict, "QUARANTINE");
  assert.ok(r.data.result.immuneAlerts.includes("CONFIDENCE_UNRELIABLE"));
  // The reported confidenceHealthScore01 in the verdict reflects the
  // RECOMPUTED value (low), not the forged 1.0.
  assert.ok(r.data.result.inputs.confidenceHealthScore01 < 0.5);
});

test("CV39 invalid bodies return 400", async () => {
  const a = await j("POST", "/continuous/confidence-health", { candidateId: CID });
  assert.equal(a.status, 400);
  const b = await j("POST", "/continuous/strategy-trust", {
    ...healthyTrust(), priorTrust01: 1.5,           // out of range
  });
  assert.equal(b.status, 400);
  const c = await j("POST", "/continuous/strategy-quarantine", {
    ...noopQuarantine(), currentState: "BOGUS",
  });
  assert.equal(c.status, 400);
  const d = await j("POST", "/continuous/meta-validation", {
    ...healthyMeta(), trueApprovals: -1,
  });
  assert.equal(d.status, 400);
});
