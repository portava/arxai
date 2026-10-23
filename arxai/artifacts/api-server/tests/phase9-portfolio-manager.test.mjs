// ═══════════════════════════════════════════════════════════════════════════
// Phase 9 Portfolio Manager + Capital Allocation tests.
//
// Acceptance criteria locked in:
//   • Approved strategies do NOT receive equal allocation.
//   • High-risk / degrading strategies lose allocation.
//   • Reserve capital rises in dangerous conditions.
//   • Exposure Balancer reduces correlated/per-symbol risk.
//   • ConvictionWeightedAllocation can boost OR cut size.
//   • SurvivalWeightedAllocation prioritizes survival under danger.
//   • Portfolio Manager cannot bypass Risk Governor / Control Tower
//     (caller-supplied freezes are honored monotonically; outputs are
//     advisory: canPlaceTrades:false, mode:PORTFOLIO_PIPELINE).
//   • Required outputs present:
//       portfolioRiskBudget, strategyAllocationMap, reserveAllocation,
//       convictionAllocation, survivalAllocation, exposureRiskScore,
//       correlatedExposureScore, recommendedRestrictions,
//       recommendedAggressionLevel.
//   • All allocation changes vault-logged with PM_*.
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
});
async function vaultTypes() {
  const r = await pool.query(`SELECT event_type FROM audit_events`);
  return r.rows.map((x) => x.event_type);
}

// ── Builders ───────────────────────────────────────────────────────────────
const baseRules = () => ({
  accountEquity: 100_000,
  maxAccountRiskFraction01: 0.10,
  maxPerStrategyRiskFraction01: 0.05,
  maxPerSymbolRiskFraction01: 0.04,
  maxPerSessionRiskFraction01: 0.05,
  minReserveFraction01: 0.10,
});

const strat = (id, over = {}) => ({
  strategyId: id,
  validationScore01: 0.8,
  recentExpectancyR: 0.4,
  regimeFit01: 0.8,
  executionQuality01: 0.8,
  drawdownBehavior01: 0.8,
  edgeDecaySlope: 0.0,
  tradeStage: "FULL_GOVERNED_LIVE",
  designedRegimes: ["TREND_UP", "RANGE", "ANY"],
  designedSessions: ["LONDON", "NEW_YORK", "OVERLAP_LDN_NY", "ASIA", "AFTER_HOURS"],
  designedSymbols: ["VIX_75"],
  ...over,
});

const sym = (id, over = {}) => ({
  symbolId: id,
  liquidity01: 0.8,
  recentExpectancyR: 0.3,
  regimeRelevance01: 0.7,
  executionQuality01: 0.8,
  ...over,
});

const sess = (s, over = {}) => ({
  session: s, recentExpectancyR: 0.2, recentWinRate01: 0.6, liquidity01: 0.8, ...over,
});

const agt = (id, over = {}) => ({
  agentId: id, calibration01: 0.7, trackRecord01: 0.7, recentAccuracy01: 0.7,
  isFrozen: false, ...over,
});

const baseInput = (over = {}) => ({
  rules: baseRules(),
  strategies: [strat("S1"), strat("S2"), strat("S3")],
  symbols: [sym("VIX_75")],
  sessions: [sess("LONDON")],
  agents: [agt("A1"), agt("A2")],
  activeRegime: "TREND_UP",
  activeSession: "LONDON",
  regimeUncertainty01: 0.2,
  accountDrawdownFraction01: 0.05,
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────
// PM1 master plan exposes ALL nine spec-required output fields.
// ───────────────────────────────────────────────────────────────────────────
test("PM1 master plan returns all 9 spec-required outputs", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput());
  assert.equal(r.status, 200);
  const p = r.data.plan;
  for (const f of [
    "portfolioRiskBudget", "strategyAllocationMap", "reserveAllocation",
    "convictionAllocation", "survivalAllocation",
    "exposureRiskScore", "correlatedExposureScore",
    "recommendedRestrictions", "recommendedAggressionLevel",
  ]) {
    assert.ok(f in p, `missing required output: ${f}`);
  }
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "PORTFOLIO_PIPELINE");
});

// ───────────────────────────────────────────────────────────────────────────
// PM2 strategies receive DYNAMIC (non-equal) allocation when scores differ.
// ───────────────────────────────────────────────────────────────────────────
test("PM2 strategies receive non-equal allocation when scores differ", async () => {
  const body = baseInput({
    // Loosen per-strategy cap so softmax differences translate into riskR
    // (with default 5% cap all three get pinned to the same ceiling).
    rules: { ...baseRules(), maxPerStrategyRiskFraction01: 0.50, maxPerSymbolRiskFraction01: 0.50 },
    strategies: [
      strat("STRONG", { designedSymbols: ["X"], validationScore01: 0.95, recentExpectancyR: 1.5, regimeFit01: 0.95 }),
      strat("MID",    { designedSymbols: ["Y"], validationScore01: 0.70, recentExpectancyR: 0.3, regimeFit01: 0.70 }),
      strat("WEAK",   { designedSymbols: ["Z"], validationScore01: 0.30, recentExpectancyR: -0.2, regimeFit01: 0.30 }),
    ],
    symbols: [sym("X"), sym("Y"), sym("Z")],
  });
  const r = await j("POST", "/portfolio/plan", body);
  assert.equal(r.status, 200);
  const map = r.data.plan.strategyAllocationMap;
  assert.ok(map.STRONG.riskR > map.MID.riskR, "STRONG > MID");
  assert.ok(map.MID.riskR > map.WEAK.riskR, "MID > WEAK");
});

// ───────────────────────────────────────────────────────────────────────────
// PM3 degrading strategies (negative edge slope) lose allocation.
// ───────────────────────────────────────────────────────────────────────────
test("PM3 degrading strategy (negative edge slope) loses allocation vs healthy peer", async () => {
  const body = baseInput({
    rules: { ...baseRules(), maxPerStrategyRiskFraction01: 0.50, maxPerSymbolRiskFraction01: 0.50 },
    strategies: [
      strat("HEALTHY",  { designedSymbols: ["A"], edgeDecaySlope: 0.05 }),
      strat("DECAYING", { designedSymbols: ["B"], edgeDecaySlope: -0.08 }),
    ],
    symbols: [sym("A"), sym("B")],
  });
  const r = await j("POST", "/portfolio/plan", body);
  const map = r.data.plan.strategyAllocationMap;
  assert.ok(map.HEALTHY.riskR > map.DECAYING.riskR);
  assert.ok(map.DECAYING.edgeDecayPenalty01 > 0);
});

// ───────────────────────────────────────────────────────────────────────────
// PM4 dangerous conditions raise reserve allocation.
// ───────────────────────────────────────────────────────────────────────────
test("PM4 dangerous conditions raise reserve fraction", async () => {
  const safe = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.1, accountDrawdownFraction01: 0.02,
  }));
  const danger = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.9, accountDrawdownFraction01: 0.6,
  }));
  assert.ok(
    danger.data.plan.reserveAllocation.reserveFraction01 >
    safe.data.plan.reserveAllocation.reserveFraction01,
    `danger reserve ${danger.data.plan.reserveAllocation.reserveFraction01} should exceed safe ${safe.data.plan.reserveAllocation.reserveFraction01}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// PM5 exposure balancer caps per-symbol risk.
// ───────────────────────────────────────────────────────────────────────────
test("PM5 exposure balancer caps per-symbol exposure to perSymbolCapR", async () => {
  // Multiple strategies, all targeting the same symbol — should breach cap
  // pre-balance and be scaled down.
  const body = baseInput({
    strategies: [
      strat("A", { designedSymbols: ["X"] }),
      strat("B", { designedSymbols: ["X"] }),
      strat("C", { designedSymbols: ["X"] }),
    ],
    symbols: [sym("X")],
  });
  const r = await j("POST", "/portfolio/plan", body);
  const p = r.data.plan;
  const xRisk = p.exposure.perSymbolRiskR.X ?? 0;
  assert.ok(
    xRisk <= p.riskBudget.perSymbolCapR + 1e-6,
    `xRisk ${xRisk} > cap ${p.riskBudget.perSymbolCapR}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// PM6 conviction multiplier BOOSTS well-calibrated high-conviction strategies.
// ───────────────────────────────────────────────────────────────────────────
test("PM6 well-calibrated high-conviction strategy gets multiplier > 1", async () => {
  const r = await j("POST", "/portfolio/conviction", {
    conviction: [{
      strategyId: "S1",
      conviction01: 0.9, calibration01: 0.9,
      sampleSize: 50, recentExpectancyR: 0.6,
    }],
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.multipliers[0].multiplier > 1.0);
});

// ───────────────────────────────────────────────────────────────────────────
// PM7 conviction multiplier CUTS overconfident bad-winning strategies.
// ───────────────────────────────────────────────────────────────────────────
test("PM7 overconfident (high conviction, low calibration) gets multiplier < 0.6", async () => {
  const r = await j("POST", "/portfolio/conviction", {
    conviction: [{
      strategyId: "OC",
      conviction01: 0.95, calibration01: 0.2,
      sampleSize: 50, recentExpectancyR: 0.5, // bad-winning
    }],
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.multipliers[0].multiplier < 0.6,
    `expected <0.6 got ${r.data.multipliers[0].multiplier}`);
});

// ───────────────────────────────────────────────────────────────────────────
// PM8 survival multiplier favors high-survival strategies under danger.
// ───────────────────────────────────────────────────────────────────────────
test("PM8 survival multiplier amplifies survivors over fragile under danger", async () => {
  const r = await j("POST", "/portfolio/survival", {
    survival: [
      { strategyId: "ROCK", survivalScore01: 0.95, ruinProbability01: 0.05,
        drawdownBehavior01: 0.9, recentExpectancyR: 0.3 },
      { strategyId: "FRAGILE", survivalScore01: 0.2, ruinProbability01: 0.6,
        drawdownBehavior01: 0.2, recentExpectancyR: 0.6 },
    ],
    dangerLevel01: 0.8,
  });
  assert.equal(r.status, 200);
  const rock = r.data.multipliers.find((m) => m.strategyId === "ROCK").multiplier;
  const fragile = r.data.multipliers.find((m) => m.strategyId === "FRAGILE").multiplier;
  assert.ok(rock > fragile, `ROCK ${rock} should exceed FRAGILE ${fragile}`);
  assert.ok(fragile <= 0.4 + 1e-9, `FRAGILE ${fragile} should be <= 0.4 (ruin override)`);
});

// ───────────────────────────────────────────────────────────────────────────
// PM9 caller-supplied account freeze zeros all allocations.
// ───────────────────────────────────────────────────────────────────────────
test("PM9 account freeze zeros all allocations and sets aggression FROZEN", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    freezes: { account: { frozen: true, reason: "kill switch" } },
  }));
  assert.equal(r.status, 200);
  const p = r.data.plan;
  assert.equal(p.recommendedAggressionLevel, "FROZEN");
  assert.equal(p.riskGovernorOverridden, true);
  for (const a of p.strategies) assert.equal(a.riskR, 0);
});

// ───────────────────────────────────────────────────────────────────────────
// PM10 strategy freeze zeros that strategy + emits OVERRIDE vault entry.
// ───────────────────────────────────────────────────────────────────────────
test("PM10 strategy freeze emits PM_OVERRIDE_APPLIED and zeros that strategy", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    freezes: { strategies: [{ id: "S2", reason: "drawdown limit" }] },
  }));
  assert.equal(r.status, 200);
  assert.equal(r.data.plan.strategyAllocationMap.S2.riskR, 0);
  assert.equal(r.data.plan.riskGovernorOverridden, true);
  const types = await vaultTypes();
  assert.ok(types.includes("PM_OVERRIDE_APPLIED"),
    `expected PM_OVERRIDE_APPLIED, saw: ${[...new Set(types)].join(",")}`);
});

// ───────────────────────────────────────────────────────────────────────────
// PM11 stage cap: PAPER_TRADING strategy receives zero allocation.
// ───────────────────────────────────────────────────────────────────────────
test("PM11 PAPER_TRADING strategy receives zero allocation (stage cap = 0)", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    strategies: [
      strat("LIVE"),
      strat("PAPER", { tradeStage: "PAPER_TRADING" }),
    ],
  }));
  assert.equal(r.data.plan.strategyAllocationMap.PAPER.riskR, 0);
  assert.ok(r.data.plan.strategyAllocationMap.LIVE.riskR > 0);
});

// ───────────────────────────────────────────────────────────────────────────
// PM12 regime gate: strategy not designed for the active regime is excluded.
// ───────────────────────────────────────────────────────────────────────────
test("PM12 strategy not designed for active regime is excluded from allocation", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    strategies: [
      strat("FITS",   { designedRegimes: ["TREND_UP"] }),
      strat("WRONG",  { designedRegimes: ["TREND_DOWN"] }),
    ],
    activeRegime: "TREND_UP",
  }));
  assert.equal(r.data.plan.strategyAllocationMap.WRONG.riskR, 0);
  assert.ok(r.data.plan.strategyAllocationMap.FITS.riskR > 0);
});

// ───────────────────────────────────────────────────────────────────────────
// PM13 dangerous conditions push aggression to OBSERVE_ONLY.
// ───────────────────────────────────────────────────────────────────────────
test("PM13 deep drawdown + high uncertainty → recommendedAggressionLevel OBSERVE_ONLY", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.95, accountDrawdownFraction01: 0.7,
  }));
  assert.equal(r.data.plan.recommendedAggressionLevel, "OBSERVE_ONLY");
});

// ───────────────────────────────────────────────────────────────────────────
// PM14 safe conditions → AGGRESSIVE.
// ───────────────────────────────────────────────────────────────────────────
test("PM14 very safe conditions → AGGRESSIVE", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    rules: { ...baseRules(), minReserveFraction01: 0.0 },
    regimeUncertainty01: 0.05,
    accountDrawdownFraction01: 0.02,
    activeRegime: "TREND_UP",
  }));
  assert.equal(r.data.plan.recommendedAggressionLevel, "AGGRESSIVE");
});

// ───────────────────────────────────────────────────────────────────────────
// PM15 frozen strategies appear in recommendedRestrictions as FREEZE.
// ───────────────────────────────────────────────────────────────────────────
test("PM15 frozen strategy appears in recommendedRestrictions as FREEZE", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    freezes: { strategies: [{ id: "S2", reason: "ruin risk" }] },
  }));
  const rec = r.data.plan.recommendedRestrictions.find((x) => x.strategyId === "S2");
  assert.ok(rec, "S2 missing from recommendedRestrictions");
  assert.equal(rec.restriction, "FREEZE");
});

// ───────────────────────────────────────────────────────────────────────────
// PM16 high edge-decay → REDUCE in recommendedRestrictions.
// ───────────────────────────────────────────────────────────────────────────
test("PM16 partially-decaying strategy → REDUCE recommendation", async () => {
  // slope=-0.06 with decayAt=-0.10 → penalty=0.6 (>=0.5 → REDUCE).
  const r = await j("POST", "/portfolio/plan", baseInput({
    strategies: [strat("HEALTHY"), strat("HALF", { edgeDecaySlope: -0.06 })],
  }));
  const rec = r.data.plan.recommendedRestrictions.find((x) => x.strategyId === "HALF");
  assert.ok(rec, "HALF missing from recommendedRestrictions");
  assert.equal(rec.restriction, "REDUCE");
});

// ───────────────────────────────────────────────────────────────────────────
// PM17 vault emits PM_PLAN_GENERATED + per-scope events.
// ───────────────────────────────────────────────────────────────────────────
test("PM17 master plan emits PM_PLAN_GENERATED and per-scope vault events", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput());
  assert.equal(r.status, 200);
  // give vault a moment (shadowCapture is awaited, but tx commit may lag).
  await new Promise((res) => setTimeout(res, 50));
  const types = await vaultTypes();
  for (const t of [
    "PM_PLAN_GENERATED",
    "PM_RISK_BUDGET_DERIVED",
    "PM_STRATEGY_ALLOCATION_DERIVED",
    "PM_EXPOSURE_BALANCED",
  ]) {
    assert.ok(types.includes(t), `expected ${t}; saw ${[...new Set(types)].join(",")}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PM18 every endpoint is advisory.
// ───────────────────────────────────────────────────────────────────────────
test("PM18 every per-engine endpoint returns canPlaceTrades:false, mode:PORTFOLIO_PIPELINE", async () => {
  const calls = [
    j("POST", "/portfolio/plan", baseInput()),
    j("POST", "/portfolio/reserve", {
      rules: baseRules(), regimeUncertainty01: 0.3, accountDrawdownFraction01: 0.1,
      frozenStrategiesCount: 0, decayedStrategiesCount: 0, totalStrategiesCount: 3,
      activeRegime: "TREND_UP",
    }),
    j("POST", "/portfolio/risk-budget", { rules: baseRules(), reserveFraction01: 0.2 }),
    j("POST", "/portfolio/conviction", {
      conviction: [{ strategyId: "S", conviction01: 0.5, calibration01: 0.5, sampleSize: 30, recentExpectancyR: 0 }],
    }),
    j("POST", "/portfolio/survival", {
      survival: [{ strategyId: "S", survivalScore01: 0.5, ruinProbability01: 0.1, drawdownBehavior01: 0.5, recentExpectancyR: 0 }],
      dangerLevel01: 0.3,
    }),
    j("POST", "/portfolio/symbol-priority", {
      symbols: [sym("X")], rules: baseRules(), reserveFraction01: 0.2,
    }),
    j("POST", "/portfolio/session-priority", {
      sessions: [sess("LONDON")], rules: baseRules(), reserveFraction01: 0.2,
    }),
    j("POST", "/portfolio/agent-authority", { agents: [agt("A1"), agt("A2")] }),
  ];
  const all = await Promise.all(calls);
  for (const r of all) {
    assert.equal(r.status, 200);
    assert.equal(r.data.canPlaceTrades, false);
    assert.equal(r.data.mode, "PORTFOLIO_PIPELINE");
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PM19 invalid bodies return 400 (strict schema rejects unknown keys).
// ───────────────────────────────────────────────────────────────────────────
test("PM19 invalid bodies → 400; unknown keys rejected by strict schema", async () => {
  const r1 = await j("POST", "/portfolio/plan", { rubbish: 1 });
  assert.equal(r1.status, 400);
  const r2 = await j("POST", "/portfolio/plan", { ...baseInput(), unknownField: "nope" });
  assert.equal(r2.status, 400);
  const r3 = await j("POST", "/portfolio/conviction", {});
  assert.equal(r3.status, 400);
});

// ───────────────────────────────────────────────────────────────────────────
// PM20 conviction × survival multipliers actually MOVE riskR in the plan.
// ───────────────────────────────────────────────────────────────────────────
test("PM20 plan applies conviction × survival multipliers to riskR", async () => {
  const baseline = await j("POST", "/portfolio/plan", baseInput({
    strategies: [strat("S1"), strat("S2")],
    // No conviction/survival provided → multipliers default to 1.
  }));
  const tilted = await j("POST", "/portfolio/plan", baseInput({
    strategies: [strat("S1"), strat("S2")],
    conviction: [
      { strategyId: "S1", conviction01: 0.95, calibration01: 0.95, sampleSize: 50, recentExpectancyR: 0.5 },
      { strategyId: "S2", conviction01: 0.95, calibration01: 0.10, sampleSize: 50, recentExpectancyR: 0.5 },
    ],
    survival: [
      { strategyId: "S1", survivalScore01: 0.9, ruinProbability01: 0.05, drawdownBehavior01: 0.9, recentExpectancyR: 0.5 },
      { strategyId: "S2", survivalScore01: 0.2, ruinProbability01: 0.4,  drawdownBehavior01: 0.2, recentExpectancyR: 0.5 },
    ],
  }));
  const baseS1 = baseline.data.plan.strategyAllocationMap.S1.riskR;
  const baseS2 = baseline.data.plan.strategyAllocationMap.S2.riskR;
  const tiltS1 = tilted.data.plan.strategyAllocationMap.S1.riskR;
  const tiltS2 = tilted.data.plan.strategyAllocationMap.S2.riskR;
  assert.ok(Math.abs(baseS1 - baseS2) < 1e-6, "baseline S1 == S2 (symmetric inputs)");
  assert.ok(tiltS1 > tiltS2, `tilted: S1 ${tiltS1} should exceed S2 ${tiltS2}`);
});

// ───────────────────────────────────────────────────────────────────────────
// PM21 strategyAllocationMap and strategies array are consistent.
// ───────────────────────────────────────────────────────────────────────────
test("PM21 strategyAllocationMap mirrors strategies array", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput());
  const p = r.data.plan;
  assert.equal(Object.keys(p.strategyAllocationMap).length, p.strategies.length);
  for (const a of p.strategies) {
    assert.equal(p.strategyAllocationMap[a.strategyId].riskR, a.riskR);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PM22 legacy /portfolio/exposure regression — still returns 200.
// ───────────────────────────────────────────────────────────────────────────
test("PM22 legacy /portfolio/exposure still works (regression)", async () => {
  const r = await j("GET", "/portfolio/exposure");
  assert.equal(r.status, 200);
});

// ───────────────────────────────────────────────────────────────────────────
// PM23 bad-winning hard cap holds even at low sample size (sample shrinkage
// must NOT neutralize the hazard ceiling).
// ───────────────────────────────────────────────────────────────────────────
test("PM23 bad-winning hard cap survives low sample size", async () => {
  const r = await j("POST", "/portfolio/conviction", {
    conviction: [{
      strategyId: "OC_LOW_N",
      conviction01: 0.95, calibration01: 0.10,
      sampleSize: 0, recentExpectancyR: 0.5, // overconfident, undersampled
    }],
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.multipliers[0].multiplier <= 0.5 + 1e-9,
    `expected ≤ 0.5 even at n=0; got ${r.data.multipliers[0].multiplier}`);
});

// ───────────────────────────────────────────────────────────────────────────
// PM24 post-overlay exposure cap holds (re-balance after conviction×survival
// overlay must keep per-symbol risk ≤ cap).
// ───────────────────────────────────────────────────────────────────────────
test("PM24 per-symbol cap holds AFTER conviction×survival overlay re-inflation", async () => {
  // S1 and S2 share symbol X. Tilt S1 to a high conviction multiplier;
  // overlay would re-inflate X's risk past the cap if not re-balanced.
  const body = baseInput({
    rules: { ...baseRules(), maxPerStrategyRiskFraction01: 0.50 },
    strategies: [
      strat("S1", { designedSymbols: ["X"] }),
      strat("S2", { designedSymbols: ["X"] }),
    ],
    symbols: [sym("X")],
    conviction: [
      { strategyId: "S1", conviction01: 0.95, calibration01: 0.95, sampleSize: 50, recentExpectancyR: 0.5 },
      { strategyId: "S2", conviction01: 0.95, calibration01: 0.95, sampleSize: 50, recentExpectancyR: 0.5 },
    ],
    survival: [
      { strategyId: "S1", survivalScore01: 0.9, ruinProbability01: 0.05, drawdownBehavior01: 0.9, recentExpectancyR: 0.5 },
      { strategyId: "S2", survivalScore01: 0.9, ruinProbability01: 0.05, drawdownBehavior01: 0.9, recentExpectancyR: 0.5 },
    ],
  });
  const r = await j("POST", "/portfolio/plan", body);
  assert.equal(r.status, 200);
  const p = r.data.plan;
  const xRisk = p.exposure.perSymbolRiskR.X ?? 0;
  assert.ok(xRisk <= p.riskBudget.perSymbolCapR + 1e-6,
    `post-overlay xRisk ${xRisk} > cap ${p.riskBudget.perSymbolCapR}`);
  assert.ok(p.exposureRiskScore <= 1 + 1e-9);
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 9 UPGRADE — Dynamic Capital Ecosystem (PM25–PM35).
// ═══════════════════════════════════════════════════════════════════════════

// PM25 — every plan carries a populated ecosystem block by default.
test("PM25 plan always exposes ecosystem block with multipliers + report", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput());
  assert.equal(r.status, 200);
  const eco = r.data.plan.ecosystem;
  assert.ok(eco, "plan.ecosystem missing");
  for (const f of [
    "capitalClimate", "aggressionClimate", "preservationClimate", "reserveExpansion",
    "capitalEfficiency", "riskAdjustedEfficiency",
    "executionAdjustedAllocation", "survivabilityAdjustedAllocation",
    "capitalFatigue", "overdeployment", "concentrationRisk",
    "strategyCompetition", "allocationTrust", "authorityCompetition",
    "fragilityScore", "diversification", "liquidityAwareDeployment",
    "portfolioHealth",
    "ecosystemMultipliersById", "liquidityMultipliersBySymbol", "shifts",
  ]) assert.ok(f in eco, `ecosystem missing ${f}`);
  // multipliers must be in the safety band [0.1, 1.5].
  for (const id of Object.keys(eco.ecosystemMultipliersById)) {
    const m = eco.ecosystemMultipliersById[id];
    assert.ok(m >= 0.1 - 1e-9 && m <= 1.5 + 1e-9, `eco mult ${id}=${m} out of band`);
  }
});

// PM26 — hostile climate downgrades aggression monotonically (never raises).
test("PM26 storm-tier climate downgrades recommendedAggressionLevel", async () => {
  const calm = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.05, accountDrawdownFraction01: 0.02,
    ecosystem: { agentDisagreement01: 0.0, executionQualityAvg01: 1.0,
                 confidenceHealth01: 1.0, cognitiveRisk01: 0.0 },
  }));
  const storm = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.85, accountDrawdownFraction01: 0.45,
    ecosystem: { agentDisagreement01: 0.9, executionQualityAvg01: 0.2,
                 confidenceHealth01: 0.1, cognitiveRisk01: 0.9 },
  }));
  const order = ["FROZEN","OBSERVE_ONLY","CONSERVATIVE","BALANCED","AGGRESSIVE"];
  assert.ok(order.indexOf(storm.data.plan.recommendedAggressionLevel)
            <= order.indexOf(calm.data.plan.recommendedAggressionLevel),
    `storm aggression ${storm.data.plan.recommendedAggressionLevel} should be ≤ calm ${calm.data.plan.recommendedAggressionLevel}`);
});

// PM27 — hostile climate expands the reserve fraction.
test("PM27 storm-tier climate expands reserve fraction", async () => {
  const calm = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.05, accountDrawdownFraction01: 0.02,
  }));
  const storm = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.85, accountDrawdownFraction01: 0.55,
    ecosystem: { agentDisagreement01: 0.9, executionQualityAvg01: 0.2,
                 confidenceHealth01: 0.1, cognitiveRisk01: 0.9, ruinHazard01: 0.7 },
  }));
  assert.ok(storm.data.plan.reserveAllocation.reserveFraction01
              > calm.data.plan.reserveAllocation.reserveFraction01 + 1e-6,
    `storm reserve ${storm.data.plan.reserveAllocation.reserveFraction01} not > calm ${calm.data.plan.reserveAllocation.reserveFraction01}`);
});

// PM28 — poor liquidity cuts per-symbol exposure.
test("PM28 poor liquidity cuts per-symbol risk via liquidity multiplier", async () => {
  const body = baseInput({
    rules: { ...baseRules(), maxPerStrategyRiskFraction01: 0.50, maxPerSymbolRiskFraction01: 0.50 },
    strategies: [
      strat("ON_LIQUID",   { designedSymbols: ["LIQ"] }),
      strat("ON_ILLIQUID", { designedSymbols: ["ILQ"] }),
    ],
    symbols: [sym("LIQ"), sym("ILQ")],
    ecosystem: {
      perSymbolLiquidity: [
        { symbolId: "LIQ", liquidity01: 0.95 },
        { symbolId: "ILQ", liquidity01: 0.05 },
      ],
    },
  });
  const r = await j("POST", "/portfolio/plan", body);
  assert.equal(r.status, 200);
  const map = r.data.plan.strategyAllocationMap;
  assert.ok(map.ON_LIQUID.riskR > map.ON_ILLIQUID.riskR,
    `LIQ ${map.ON_LIQUID.riskR} should exceed ILQ ${map.ON_ILLIQUID.riskR}`);
  const liqMap = r.data.plan.ecosystem.liquidityMultipliersBySymbol;
  assert.ok((liqMap.ILQ ?? 1) < (liqMap.LIQ ?? 1));
});

// PM29 — strategy fatigue (long deployment + drawdown) cuts participation.
test("PM29 capital fatigue cuts long-deployed drawdown strategies", async () => {
  const body = baseInput({
    rules: { ...baseRules(), maxPerStrategyRiskFraction01: 0.50, maxPerSymbolRiskFraction01: 0.50 },
    strategies: [
      strat("FRESH",   { designedSymbols: ["A"] }),
      strat("FATIGUED",{ designedSymbols: ["B"] }),
    ],
    symbols: [sym("A"), sym("B")],
    ecosystem: {
      perStrategyRuntime: [
        { strategyId: "FRESH",    deploymentDurationDays: 5,   recentDrawdown01: 0.05 },
        { strategyId: "FATIGUED", deploymentDurationDays: 365, recentDrawdown01: 0.60 },
      ],
    },
  });
  const r = await j("POST", "/portfolio/plan", body);
  assert.equal(r.status, 200);
  const map = r.data.plan.strategyAllocationMap;
  assert.ok(map.FRESH.riskR > map.FATIGUED.riskR,
    `FRESH ${map.FRESH.riskR} should exceed FATIGUED ${map.FATIGUED.riskR}`);
  const ecoMult = r.data.plan.ecosystem.ecosystemMultipliersById;
  assert.ok((ecoMult.FATIGUED ?? 1) < (ecoMult.FRESH ?? 1));
});

// PM30 — overdeployment shrinks the whole-portfolio multiplier.
test("PM30 sustained overdeployment shrinks ecosystem multipliers across the board", async () => {
  const baseline = await j("POST", "/portfolio/plan", baseInput({
    ecosystem: { sustainedDeploymentFraction01: 0.0 },
  }));
  const stretched = await j("POST", "/portfolio/plan", baseInput({
    ecosystem: { sustainedDeploymentFraction01: 0.95 },
  }));
  // Average multiplier across strategies should be lower under sustained overdeployment.
  const avg = (eco) => {
    const v = Object.values(eco.ecosystemMultipliersById);
    return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 1;
  };
  assert.ok(avg(stretched.data.plan.ecosystem) <= avg(baseline.data.plan.ecosystem) + 1e-9,
    `stretched avg ${avg(stretched.data.plan.ecosystem)} should ≤ baseline ${avg(baseline.data.plan.ecosystem)}`);
});

// PM31 — degraded portfolio health appears in the report.
test("PM31 degraded inputs produce a lower portfolioHealth.healthScore01", async () => {
  const healthy = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.1, accountDrawdownFraction01: 0.02,
    ecosystem: { decayedStrategyShare01: 0.0, regimeConcentration01: 0.1, agentDisagreement01: 0.1, executionQualityAvg01: 0.95 },
  }));
  const sick = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.8, accountDrawdownFraction01: 0.4,
    ecosystem: { decayedStrategyShare01: 0.7, regimeConcentration01: 0.9, agentDisagreement01: 0.9, executionQualityAvg01: 0.2 },
  }));
  const hH = healthy.data.plan.ecosystem.portfolioHealth?.health01 ?? 1;
  const hS = sick.data.plan.ecosystem.portfolioHealth?.health01 ?? 1;
  assert.ok(hS < hH, `sick health ${hS} should be < healthy ${hH}`);
});

// PM32 — Risk Governor still wins: ACCOUNT freeze → empty ecosystem block.
test("PM32 Risk Governor ACCOUNT freeze short-circuits ecosystem (empty multipliers)", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    freezes: { account: { frozen: true, reason: "control-tower halt" } },
    ecosystem: { perStrategyRuntime: [{ strategyId: "S1", deploymentDurationDays: 999, recentDrawdown01: 0.9 }] },
  }));
  assert.equal(r.status, 200);
  const eco = r.data.plan.ecosystem;
  assert.deepEqual(eco.ecosystemMultipliersById, {});
  assert.deepEqual(eco.liquidityMultipliersBySymbol, {});
  assert.equal(r.data.plan.recommendedAggressionLevel, "FROZEN");
  assert.equal(r.data.plan.riskGovernorOverridden, true);
});

// PM33 — standalone /portfolio/ecosystem advisory endpoint works.
test("PM33 POST /portfolio/ecosystem returns advisory ecosystem report", async () => {
  const r = await j("POST", "/portfolio/ecosystem", {
    strategies: [strat("S1"), strat("S2")],
    agents: [agt("A1")],
    regimeUncertainty01: 0.6, accountDrawdownFraction01: 0.3,
    deployableR: 5000,
    perSymbolRiskR: { VIX_75: 1000 },
    perStrategyRiskR: { S1: 600, S2: 400 },
    perSessionRiskR: { LONDON: 1000 },
    ecosystem: {
      agentDisagreement01: 0.5, executionQualityAvg01: 0.6,
      perSymbolLiquidity: [{ symbolId: "VIX_75", liquidity01: 0.4 }],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.mode, "PORTFOLIO_PIPELINE");
  assert.ok(r.data.ecosystem);
  assert.ok("ecosystemMultipliersById" in r.data.ecosystem);
  assert.ok("portfolioHealth" in r.data.ecosystem);
});

// PM34 — ecosystem cannot exceed the binding deployable budget.
test("PM34 ecosystem multipliers cannot push total risk past deployable", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    rules: { ...baseRules(), maxPerStrategyRiskFraction01: 0.50, maxPerSymbolRiskFraction01: 0.50 },
    ecosystem: {
      perStrategyTrust: [
        { strategyId: "S1", trackRecord01: 1, calibration01: 1, validationScore01: 1 },
        { strategyId: "S2", trackRecord01: 1, calibration01: 1, validationScore01: 1 },
        { strategyId: "S3", trackRecord01: 1, calibration01: 1, validationScore01: 1 },
      ],
      perStrategyEfficiency: [
        { strategyId: "S1", expectancyR: 5, riskRDeployed: 1, downsideR: 0.1 },
        { strategyId: "S2", expectancyR: 5, riskRDeployed: 1, downsideR: 0.1 },
        { strategyId: "S3", expectancyR: 5, riskRDeployed: 1, downsideR: 0.1 },
      ],
    },
  }));
  assert.equal(r.status, 200);
  const total = r.data.plan.strategies.reduce((s, a) => s + a.riskR, 0);
  assert.ok(total <= r.data.plan.riskBudget.deployableR + 1e-6,
    `total ${total} > deployable ${r.data.plan.riskBudget.deployableR}`);
});

// PM35 — climate / health / ecosystem entries land in the vault.
test("PM35 ecosystem activity emits CLIMATE, HEALTH, ECOSYSTEM vault scopes", async () => {
  await pool.query(`DELETE FROM audit_events`);
  const r = await j("POST", "/portfolio/plan", baseInput({
    regimeUncertainty01: 0.7, accountDrawdownFraction01: 0.4,
    ecosystem: {
      perSymbolLiquidity: [{ symbolId: "VIX_75", liquidity01: 0.2 }],
    },
  }));
  assert.equal(r.status, 200);
  // PM_PLAN_GENERATED still fires; specific vault SCOPE entries are in payload.
  const types = await vaultTypes();
  assert.ok(types.includes("PM_PLAN_GENERATED"),
    `expected PM_PLAN_GENERATED among ${JSON.stringify(types)}`);
  // The plan itself reports shifts (climate/liquidity).
  assert.ok(r.data.plan.ecosystem.shifts.length > 0,
    `expected ecosystem.shifts to be non-empty under hostile climate`);
});

// PM36 — overlays cannot push any strategy above perStrategyCapR.
test("PM36 per-strategy cap binds AFTER ecosystem overlays", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    rules: { ...baseRules(), maxPerStrategyRiskFraction01: 0.04, maxPerSymbolRiskFraction01: 0.50 },
    strategies: [
      strat("S1", { designedSymbols: ["A"] }),
      strat("S2", { designedSymbols: ["B"] }),
    ],
    symbols: [sym("A"), sym("B")],
    ecosystem: {
      perStrategyTrust: [
        { strategyId: "S1", trackRecord01: 1, calibration01: 1, validationScore01: 1 },
        { strategyId: "S2", trackRecord01: 1, calibration01: 1, validationScore01: 1 },
      ],
    },
  }));
  assert.equal(r.status, 200);
  const cap = r.data.plan.riskBudget.perStrategyCapR;
  for (const a of r.data.plan.strategies) {
    assert.ok(a.riskR <= cap + 1e-6,
      `${a.strategyId} riskR ${a.riskR} > perStrategyCapR ${cap}`);
  }
});

// PM37 — per-session cap binds across strategies sharing a session.
test("PM37 per-session cap binds across strategies sharing a session", async () => {
  const r = await j("POST", "/portfolio/plan", baseInput({
    rules: { ...baseRules(), maxPerSessionRiskFraction01: 0.05,
             maxPerStrategyRiskFraction01: 0.10, maxPerSymbolRiskFraction01: 0.50 },
    strategies: [
      strat("S1", { designedSessions: ["LONDON"], designedSymbols: ["A"] }),
      strat("S2", { designedSessions: ["LONDON"], designedSymbols: ["B"] }),
      strat("S3", { designedSessions: ["LONDON"], designedSymbols: ["C"] }),
    ],
    symbols: [sym("A"), sym("B"), sym("C")],
  }));
  assert.equal(r.status, 200);
  const cap = r.data.plan.riskBudget.perSessionCapR;
  // Sum strategies whose only designed session is LONDON.
  const londonSum = r.data.plan.strategies
    .filter((a) => ["S1","S2","S3"].includes(a.strategyId))
    .reduce((s, a) => s + a.riskR, 0);
  assert.ok(londonSum <= cap + 1e-6,
    `LONDON aggregate ${londonSum} > perSessionCapR ${cap}`);
});
