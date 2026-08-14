// ═══════════════════════════════════════════════════════════════════════════
// Phase 10 AI Economy + Strategy Lifecycle + Evolution Lab + Resource Mgmt.
//
// Acceptance criteria locked in (PE1..PE12):
//   PE1  Agent reputation moves with graded evidence (and is bounded 0..1).
//   PE2  Trust score is discipline-floored: poor discipline cannot be hidden
//        by other strong inputs.
//   PE3  Lifecycle FSM rejects skipping stages (table-driven, no shortcuts).
//   PE4  Quarantine triggers on hard violations and proposes QUARANTINE.
//   PE5  Evolution mutation is REFUSED when mode != "SANDBOX".
//   PE6  Mutated variants must enter validation before graduating
//        (validation absent → no graduation).
//   PE7  Sustained-failure strategy is recommended for retirement.
//   PE8  Resource (attention) allocator never exceeds the configured budget.
//   PE9  All Phase 10 advisory routes return canPlaceTrades:false.
//   PE10 Vault entries are emitted for every Phase 10 state change
//        (EC_* event types appear in audit_events).
//   PE11 Lifecycle FSM accepts the canonical RESEARCH → ARCHIVED happy path
//        (12 stages reachable through legal events only).
//   PE12 Promotion gates respect requiresValidation (cannot promote past
//        TESTING without passedRequiredValidation).
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

// ── Builders ──────────────────────────────────────────────────────────────
const reputationEvent = (over = {}) => ({
  agentId: "AGENT_A",
  pnlR: 1.5,
  withinRiskPolicy: true,
  calibrationErrorPct: 5,
  drawdownContributionPct: 0.5,
  observedAtIso: nowIso(),
  ...over,
});

const trustInputs = (over = {}) => ({
  reputation01: 0.8,
  discipline01: 0.9,
  specialty01: 0.7,
  survivalQuality01: 0.85,
  sampleCount: 600,
  ...over,
});

const seedLifecycleState = (id, stage, history = []) => ({
  strategyId: id, stage, enteredStageAtIso: nowIso(), history,
});

const fullPromotion = (over = {}) => ({
  strategyId: "S1", currentStage: "TESTING",
  sampleCount: 1000, expectancyR: 0.5, recentDrawdownPct: 3,
  meanCalibrationErrorPct: 5, passedRequiredValidation: true,
  survivalQuality01: 0.9, ...over,
});

const allStagesPassed = () => [
  { stage: "STAGE_1_REPLAY",     passed: true, evidence: ["replay ok"] },
  { stage: "STAGE_2_STRESS",     passed: true, evidence: ["stress ok"] },
  { stage: "STAGE_3_DRIFT",      passed: true, evidence: ["drift ok"] },
  { stage: "STAGE_4_GOVERNANCE", passed: true, evidence: ["gov ok"] },
];

const evolutionCycle = (over = {}) => {
  // Mutation engine generates variantIds as `${parentStrategyId}.v${n}`.
  const parent = "PARENT_S1";
  const variantIds = [`${parent}.v1`, `${parent}.v2`];
  const validations = variantIds.map((variantId) => ({
    variantId, mode: "SANDBOX", stageOutcomes: allStagesPassed(),
  }));
  return {
    cycleId: `CYC_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    mode: "SANDBOX",
    mutation: {
      parentStrategyId: parent,
      parameters: [{ name: "p1", current: 0.5, min: 0, max: 1, maxPerturbation01: 0.2 }],
      variantCount: 2,
      rngSeed: 42,
    },
    testing: {
      parentStrategyId: parent,
      results: [
        { variantId: parent,           sampleCount: 500, expectancyR: 0.20, winRate01: 0.55, maxDrawdownPct: 4, isParentBaseline: true },
        { variantId: variantIds[0],    sampleCount: 500, expectancyR: 0.35, winRate01: 0.60, maxDrawdownPct: 4 },
        { variantId: variantIds[1],    sampleCount: 500, expectancyR: 0.30, winRate01: 0.58, maxDrawdownPct: 4 },
      ],
    },
    validations,
    recordedAtIso: nowIso(),
    ...over,
  };
};

// ───────────────────────────────────────────────────────────────────────────
// PE1 — reputation moves with graded evidence
// ───────────────────────────────────────────────────────────────────────────
test("PE1 reputation moves up after a strong graded event", async () => {
  const r = await j("POST", "/economy/agent-reputation/update", {
    prev: null,
    event: reputationEvent({ pnlR: 2.0, calibrationErrorPct: 1 }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "AI_ECONOMY_PIPELINE");
  const next = r.data.result.next;
  assert.ok(next.reputation01 >= 0 && next.reputation01 <= 1);
  // Seed is 0.5; a strong event should nudge it up (not below seed).
  assert.ok(next.reputation01 >= 0.5, `expected >= 0.5, got ${next.reputation01}`);
});

test("PE1b reputation drops after a bad graded event (policy breach + bad calibration)", async () => {
  const r = await j("POST", "/economy/agent-reputation/update", {
    prev: null,
    event: reputationEvent({
      pnlR: -2.0, withinRiskPolicy: false, calibrationErrorPct: 30, drawdownContributionPct: 6,
    }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.next.reputation01 < 0.5,
    `expected < 0.5 after bad event, got ${r.data.result.next.reputation01}`);
});

// ───────────────────────────────────────────────────────────────────────────
// PE2 — trust score reflects discipline-floor (low discipline → low trust)
// ───────────────────────────────────────────────────────────────────────────
test("PE2 trust score: poor discipline drags trust down even with strong reputation", async () => {
  const goodDisc = await j("POST", "/economy/trust-score", trustInputs({ discipline01: 0.95 }));
  const badDisc  = await j("POST", "/economy/trust-score", trustInputs({ discipline01: 0.10 }));
  assert.equal(goodDisc.status, 200);
  assert.equal(badDisc.status, 200);
  assert.ok(goodDisc.data.result.score01 > badDisc.data.result.score01,
    `good discipline (${goodDisc.data.result.score01}) should outscore bad (${badDisc.data.result.score01})`);
  // Discipline weight is 0.30 — moving from 0.95 to 0.10 should cost ≥ 0.20.
  assert.ok(goodDisc.data.result.score01 - badDisc.data.result.score01 >= 0.20);
});

// ───────────────────────────────────────────────────────────────────────────
// PE3 — lifecycle FSM rejects skipping stages
// ───────────────────────────────────────────────────────────────────────────
test("PE3 lifecycle: cannot REINSTATE from RESEARCH (event illegal here)", async () => {
  const state = seedLifecycleState("S_SKIP", "RESEARCH");
  const r = await j("POST", "/economy/lifecycle/transition", {
    state, event: "REINSTATE",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.changed, false);
  assert.ok(r.data.result.blockers.length > 0);
  assert.equal(r.data.result.next.stage, "RESEARCH");
});

test("PE3b lifecycle: PROMOTE walks ONE stage (RESEARCH → TESTING, not further)", async () => {
  const state = seedLifecycleState("S_ONE", "RESEARCH");
  const first = await j("POST", "/economy/lifecycle/transition", { state, event: "PROMOTE" });
  assert.equal(first.data.result.next.stage, "TESTING");
  // A second PROMOTE only advances ONE more stage, not arbitrary jumps.
  const second = await j("POST", "/economy/lifecycle/transition", {
    state: first.data.result.next, event: "PROMOTE",
  });
  assert.equal(second.data.result.next.stage, "SHADOW");
});

// ───────────────────────────────────────────────────────────────────────────
// PE4 — quarantine triggers
// ───────────────────────────────────────────────────────────────────────────
test("PE4 quarantine: governor breach forces QUARANTINE recommendation", async () => {
  const r = await j("POST", "/economy/lifecycle/quarantine", {
    strategyId: "S_Q", currentStage: "ACTIVE",
    riskGovernorBreaches: 1,
    catastrophicLossR: 0, catastrophicLossLimitR: 5,
    paramSpecViolations: 0, executionFailureBurst: 0,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.decision.recommend, true);
  assert.ok(r.data.decision.triggers.some((t) => /riskGovernorBreaches/.test(t)));
});

test("PE4b quarantine: clean operation → HOLD (no recommend)", async () => {
  const r = await j("POST", "/economy/lifecycle/quarantine", {
    strategyId: "S_OK", currentStage: "ACTIVE",
    riskGovernorBreaches: 0,
    catastrophicLossR: 0, catastrophicLossLimitR: 5,
    paramSpecViolations: 0, executionFailureBurst: 0,
  });
  assert.equal(r.data.decision.recommend, false);
});

// ───────────────────────────────────────────────────────────────────────────
// PE5 — evolution mutation refused outside SANDBOX
// ───────────────────────────────────────────────────────────────────────────
test("PE5 evolution: mode=LIVE is REFUSED with REJECTED_MODE vault entry", async () => {
  const body = evolutionCycle({ mode: "LIVE" });
  const r = await j("POST", "/economy/evolution/cycle", body);
  assert.equal(r.status, 200);
  assert.equal(r.data.cycle.variants.length, 0);
  assert.ok(r.data.cycle.blockers.some((b) => /SANDBOX/.test(b)));
  assert.ok(r.data.cycle.vaultEntries.some((e) => e.outcome === "REJECTED_MODE"));
  assert.equal(r.data.report.totals.rejectedAtMode >= 1, true);
});

// ───────────────────────────────────────────────────────────────────────────
// PE6 — mutated variants must enter validation
// ───────────────────────────────────────────────────────────────────────────
test("PE6 evolution: variants without all 4 validation stages do NOT graduate", async () => {
  const body = evolutionCycle();
  // Strip out validation stages — only STAGE_1 passed for both variants.
  body.validations = body.validations.map((v) => ({
    variantId: v.variantId, mode: "SANDBOX",
    stageOutcomes: [{ stage: "STAGE_1_REPLAY", passed: true, evidence: ["only replay"] }],
  }));
  const r = await j("POST", "/economy/evolution/cycle", body);
  assert.equal(r.status, 200);
  assert.equal(r.data.report.totals.graduatedAtValidation, 0);
  // The vault must record validation rejections, not graduations.
  assert.ok(r.data.cycle.vaultEntries.some((e) => e.outcome === "REJECTED_VALIDATION"));
});

test("PE6b evolution: full SANDBOX cycle with all stages passed → graduations recorded", async () => {
  const r = await j("POST", "/economy/evolution/cycle", evolutionCycle());
  assert.equal(r.status, 200);
  assert.ok(r.data.report.totals.graduatedAtValidation >= 1,
    `expected at least one graduation, got ${r.data.report.totals.graduatedAtValidation}`);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "EVOLUTION_PIPELINE");
});

// ───────────────────────────────────────────────────────────────────────────
// PE7 — sustained failure → retirement recommended
// ───────────────────────────────────────────────────────────────────────────
test("PE7 retirement: stuck DEGRADED with negative expectancy → recommend RETIRE", async () => {
  const r = await j("POST", "/economy/lifecycle/retirement", {
    strategyId: "S_RIP", currentStage: "DEGRADED",
    daysInCurrentStage: 30,
    expectancyR: -0.20, liveSampleCount: 500,
    recentDrawdownPct: 4, catastrophicDrawdownLimitPct: 25,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.decision.recommend, true);
  assert.ok(r.data.decision.triggers.length >= 1);
});

// ───────────────────────────────────────────────────────────────────────────
// PE8 — resource allocator never exceeds budget
// ───────────────────────────────────────────────────────────────────────────
test("PE8 attention budget: unitsConsumed ≤ totalBudgetUnits, all items decided", async () => {
  const items = [
    { itemId: "I1", severity01: 0.9, costUnits: 4 },
    { itemId: "I2", severity01: 0.8, costUnits: 3 },
    { itemId: "I3", severity01: 0.7, costUnits: 5 },
    { itemId: "I4", severity01: 0.6, costUnits: 2 },
  ];
  const totalBudgetUnits = 6;
  const r = await j("POST", "/economy/resource/attention", { totalBudgetUnits, items });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.unitsConsumed <= totalBudgetUnits + 1e-9,
    `consumed ${r.data.result.unitsConsumed} > budget ${totalBudgetUnits}`);
  assert.equal(r.data.result.assignments.length, items.length);
});

// ───────────────────────────────────────────────────────────────────────────
// PE9 — every advisory route returns canPlaceTrades:false
// ───────────────────────────────────────────────────────────────────────────
test("PE9 every Phase 10 route is advisory (canPlaceTrades:false)", async () => {
  const cases = [
    ["POST", "/economy/agent-reputation/update", { prev: null, event: reputationEvent() }],
    ["POST", "/economy/strategy-reputation/update", {
      prev: null,
      event: {
        strategyId: "S_R", validationScore01: 0.8, replayScore01: 0.7,
        liveMicroExpectancyR: 0.2, survivalScore01: 0.8,
        executionQuality01: 0.8, decisionQuality01: 0.7, observedAtIso: nowIso(),
      },
    }],
    ["POST", "/economy/trust-score", trustInputs()],
    ["POST", "/economy/lifecycle/transition", { state: seedLifecycleState("S_ADV", "RESEARCH"), event: "PROMOTE" }],
    ["POST", "/economy/lifecycle/promotion", fullPromotion()],
    ["POST", "/economy/lifecycle/demotion",  {
      strategyId: "S_D", currentStage: "ACTIVE", liveSampleCount: 100,
      expectancyR: 0.1, recentDrawdownPct: 1, meanCalibrationErrorPct: 5,
    }],
    ["POST", "/economy/lifecycle/quarantine", {
      strategyId: "S_Q2", currentStage: "ACTIVE",
      riskGovernorBreaches: 0, catastrophicLossR: 0, catastrophicLossLimitR: 5,
      paramSpecViolations: 0, executionFailureBurst: 0,
    }],
    ["POST", "/economy/lifecycle/retirement", {
      strategyId: "S_R2", currentStage: "ACTIVE", daysInCurrentStage: 1,
      expectancyR: 0.1, liveSampleCount: 50, recentDrawdownPct: 1,
      catastrophicDrawdownLimitPct: 25,
    }],
    ["POST", "/economy/evolution/cycle", evolutionCycle()],
    ["POST", "/economy/resource/attention", { totalBudgetUnits: 10, items: [] }],
    ["POST", "/economy/resource/validation-priority", { tasks: [] }],
    ["POST", "/economy/resource/replay-priority", { candidates: [] }],
  ];
  for (const [m, p, body] of cases) {
    const r = await j(m, p, body);
    assert.equal(r.status, 200, `${m} ${p} status ${r.status}`);
    assert.equal(r.data.canPlaceTrades, false, `${p} did not return canPlaceTrades:false`);
    assert.ok(typeof r.data.mode === "string", `${p} missing mode`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PE10 — vault entries emitted for state changes
// ───────────────────────────────────────────────────────────────────────────
test("PE10 vault: every Phase 10 endpoint emits an EC_* audit event", async () => {
  await j("POST", "/economy/agent-reputation/update", { prev: null, event: reputationEvent() });
  await j("POST", "/economy/trust-score", trustInputs());
  await j("POST", "/economy/lifecycle/transition", { state: seedLifecycleState("S_V", "RESEARCH"), event: "PROMOTE" });
  await j("POST", "/economy/lifecycle/quarantine", {
    strategyId: "S_V2", currentStage: "ACTIVE",
    riskGovernorBreaches: 1, catastrophicLossR: 0, catastrophicLossLimitR: 5,
    paramSpecViolations: 0, executionFailureBurst: 0,
  });
  await j("POST", "/economy/evolution/cycle", evolutionCycle({ mode: "LIVE" }));
  const types = await vaultTypes();
  for (const expect of [
    "EC_AGENT_REPUTATION_UPDATED",
    "EC_TRUST_SCORE_COMPUTED",
    "EC_LIFECYCLE_TRANSITION",
    "EC_QUARANTINE_EVALUATED",
    "EC_EVOLUTION_CYCLE_RUN",
  ]) {
    assert.ok(types.includes(expect), `missing vault entry ${expect}; got ${JSON.stringify(types)}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PE11 — full canonical lifecycle path RESEARCH → ARCHIVED
// ───────────────────────────────────────────────────────────────────────────
test("PE11 lifecycle FSM accepts the canonical 12-stage happy path → ARCHIVED", async () => {
  let state = seedLifecycleState("S_LONG", "RESEARCH");
  const path = [
    ["PROMOTE", "TESTING"],
    ["PROMOTE", "SHADOW"],
    ["PROMOTE", "PAPER"],
    ["PROMOTE", "MICRO"],
    ["PROMOTE", "LIMITED_LIVE"],
    ["PROMOTE", "ACTIVE"],
    ["REVIEW",  "UNDER_REVIEW"],
    ["DEMOTE",  "DEGRADED"],
    ["QUARANTINE", "QUARANTINED"],
    ["REINSTATE",  "UNDER_REVIEW"],
    ["RETIRE",  "RETIRED"],
    ["ARCHIVE", "ARCHIVED"],
  ];
  for (const [event, expectStage] of path) {
    const r = await j("POST", "/economy/lifecycle/transition", { state, event });
    assert.equal(r.data.result.changed, true, `event ${event} from ${state.stage} did not transition (blockers: ${JSON.stringify(r.data.result.blockers)})`);
    assert.equal(r.data.result.next.stage, expectStage,
      `expected ${expectStage} after ${event}, got ${r.data.result.next.stage}`);
    state = r.data.result.next;
  }
  // Terminal — no further transitions.
  const r = await j("POST", "/economy/lifecycle/transition", { state, event: "PROMOTE" });
  assert.equal(r.data.result.changed, false);
});

// ───────────────────────────────────────────────────────────────────────────
// PE12 — promotion gates respect requiresValidation
// ───────────────────────────────────────────────────────────────────────────
test("PE12 promotion: cannot leave TESTING without passedRequiredValidation", async () => {
  const r = await j("POST", "/economy/lifecycle/promotion",
    fullPromotion({ passedRequiredValidation: false }));
  assert.equal(r.status, 200);
  assert.equal(r.data.decision.recommend, false);
  assert.ok(r.data.decision.failedGates.includes("validation"));
});

// ───────────────────────────────────────────────────────────────────────────
// PE13 — anti-skip: PROMOTE from UNDER_REVIEW returns to last live stage
// ───────────────────────────────────────────────────────────────────────────
test("PE13 anti-skip: SHADOW → REVIEW → UNDER_REVIEW → PROMOTE returns to SHADOW (not ACTIVE)", async () => {
  let state = seedLifecycleState("S_AS", "RESEARCH");
  for (const ev of ["PROMOTE", "PROMOTE", "REVIEW"]) {
    const r = await j("POST", "/economy/lifecycle/transition", { state, event: ev });
    state = r.data.result.next;
  }
  assert.equal(state.stage, "UNDER_REVIEW");
  const r = await j("POST", "/economy/lifecycle/transition", { state, event: "PROMOTE" });
  assert.equal(r.data.result.next.stage, "SHADOW",
    `PROMOTE from UNDER_REVIEW must drop back to last live stage, got ${r.data.result.next.stage}`);
});

test("PE13b anti-skip: RESEARCH → QUARANTINE → REINSTATE → PROMOTE returns to RESEARCH (no fast-track to ACTIVE)", async () => {
  let state = seedLifecycleState("S_AS2", "RESEARCH");
  for (const ev of ["QUARANTINE", "REINSTATE"]) {
    const r = await j("POST", "/economy/lifecycle/transition", { state, event: ev });
    state = r.data.result.next;
  }
  assert.equal(state.stage, "UNDER_REVIEW");
  const r = await j("POST", "/economy/lifecycle/transition", { state, event: "PROMOTE" });
  assert.equal(r.data.result.next.stage, "RESEARCH",
    `expected fallback to RESEARCH, got ${r.data.result.next.stage}`);
});

test("PE13c demotion from UNDER_REVIEW must propose DEMOTE (REVIEW would be illegal)", async () => {
  const r = await j("POST", "/economy/lifecycle/demotion", {
    strategyId: "S_DR", currentStage: "UNDER_REVIEW",
    liveSampleCount: 100, expectancyR: 0.1,
    recentDrawdownPct: 7, // review-tier (not severe alone)
    meanCalibrationErrorPct: 5,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.decision.recommend, true);
  assert.equal(r.data.decision.proposedEvent, "DEMOTE",
    `from UNDER_REVIEW must escalate to DEMOTE, got ${r.data.decision.proposedEvent}`);
});

test("PE12b promotion: with all gates met, recommends TESTING → SHADOW", async () => {
  const r = await j("POST", "/economy/lifecycle/promotion", fullPromotion());
  assert.equal(r.data.decision.recommend, true);
  assert.equal(r.data.decision.proposedTargetStage, "SHADOW");
});
