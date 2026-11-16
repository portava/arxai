// ═══════════════════════════════════════════════════════════════════════════
// Phase 6b — Decision Simulation + Counterfactual Intelligence tests.
//
// 11 new engines under simulation/ + analysis/. All advisory, vault-logged,
// canPlaceTrades:false, and never emit TRADE_*/MODE_*/SIGNAL_* events.
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

// ── snapshot factories ──────────────────────────────────────────────
function candlesUp(n = 6, base = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base + i * 0.4;
    out.push({ ts: `2026-04-10T10:${String(i).padStart(2,"0")}:00.000Z`,
      open: o, high: o + 0.6, low: o - 0.2, close: o + 0.5, volume: 1000 });
  }
  return out;
}
function candlesDown(n = 6, base = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base - i * 0.5;
    out.push({ ts: `2026-04-10T10:${String(i).padStart(2,"0")}:00.000Z`,
      open: o, high: o + 0.2, low: o - 0.6, close: o - 0.4, volume: 1000 });
  }
  return out;
}
function snap(over = {}) {
  return {
    snapshotId: "s-" + Math.random().toString(36).slice(2, 10),
    recordedAt: "2026-04-10T10:00:00.000Z",
    market: { ts: "2026-04-10T10:00:00.000Z", symbol: "Volatility 75 Index",
      regime: "TRENDING", volatilityBand: "NORMAL",
      realizedVolPct: 1.0, spreadPips: 1, newsFlag: false, liquidityScore01: 0.9 },
    candles: candlesUp(),
    agentVotes: [
      { agentId: "trend",   vote: "BUY",  confidence01: 0.8, rationale: "" },
      { agentId: "momentum",vote: "BUY",  confidence01: 0.7, rationale: "" },
      { agentId: "mean",    vote: "SELL", confidence01: 0.6, rationale: "" },
    ],
    judgeVerdict: { decision: "APPROVE", confidence01: 0.75, blockReasons: [], agreementScore01: 0.66 },
    intent: { symbol: "Volatility 75 Index", direction: "BUY",
      entryPrice: 100, stopLoss: 99, takeProfit: 102, lotSize: 1,
      intendedAt: "2026-04-10T10:00:00.000Z" },
    execution: { slippagePips: 0.2, latencyMs: 100, partialFill: false, brokerReject: false,
      filledLotSize: 1, requestedLotSize: 1 },
    traderDNA: { baselineMature: true, disciplineScore01: 0.7, behaviorRiskScore01: 0.2,
      baselineLot: 1, baselineGapMin: 15 },
    cognitive: { cognitiveLoad01: 0.2, fatigueScore01: 0.1, stressScore01: 0.1 },
    globalState: "GREEN", controlTowerMode: "NORMAL",
    riskState: { accountBalance: 10000, openRiskPct: 0.5, dayPnl: 0,
      dayDrawdownPct: 0, maxAllowedRiskPct: 2 },
    recordedOutcome: null,
    decisionKind: "EXECUTED",
    ...over,
  };
}
function record(snapOver, outcome) {
  return { snapshot: snap(snapOver),
           outcome: { exitTs: null, exitPrice: null, durationMin: 0, reason: "test", ...outcome } };
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMULATION
// ═══════════════════════════════════════════════════════════════════════════

test("S1 /replay/sim/decision-tree explores branches and ranks them", async () => {
  const body = {
    snapshot: snap(),
    branches: [
      { name: "AS_IS", mutations: [{ kind: "REDUCED_SIZE", sizeFactor: 1.0 }] },
      { name: "HALF",  mutations: [{ kind: "REDUCED_SIZE", sizeFactor: 0.5 }] },
      { name: "BLOCK", mutations: [{ kind: "BLOCKED_INSTEAD" }] },
    ],
  };
  const { status, data } = await j("POST", "/replay/sim/decision-tree", body);
  assert.equal(status, 200);
  assert.equal(data.canPlaceTrades, false);
  assert.equal(data.mode, "REPLAY_LAB");
  assert.equal(data.tree.branches.length, 3);
  // Winning baseline → BLOCK is worst
  assert.equal(data.tree.worstBranchName, "BLOCK");
  const types = await vaultTypes();
  assert.ok(types.includes("DECISION_TREE_EXPLORED"));
});

test("S2 /replay/sim/alternate-paths surfaces 5 canonical paths", async () => {
  const { status, data } = await j("POST", "/replay/sim/alternate-paths", { snapshot: snap() });
  assert.equal(status, 200);
  assert.equal(data.report.paths.length, 5);
  const names = data.report.paths.map(p => p.name).sort();
  assert.deepEqual(names, ["AS_IS","BLOCKED","EXIT_AT_1R","HALF_SIZE","WIDER_STOP_2X"]);
  const types = await vaultTypes();
  assert.ok(types.includes("ALTERNATE_PATH_EVALUATED"));
});

test("S3 /replay/sim/counterfactual-batch aggregates many scenarios on a loser", async () => {
  // Losing baseline so blocked/half-size can improve
  const losing = snap({ candles: candlesDown() });
  const body = { snapshot: losing, scenarios: [
    { kind: "BLOCKED_INSTEAD" },
    { kind: "REDUCED_SIZE", sizeFactor: 0.5 },
    { kind: "DIFFERENT_STOP", stopPrice: 95 },
    { kind: "EXIT_EARLIER", atRMultiple: 0.1 },
  ]};
  const { status, data } = await j("POST", "/replay/sim/counterfactual-batch", body);
  assert.equal(status, 200);
  assert.equal(data.report.scenarioCount, 4);
  assert.ok(data.report.improvedFraction01 >= 0.5,
    `expected >=50% improved, got ${data.report.improvedFraction01}`);
  assert.ok(data.report.bestScenario);
  const types = await vaultTypes();
  assert.ok(types.includes("COUNTERFACTUAL_BATCH_RUN"));
});

test("S4 /replay/sim/survival classifies a fragile path with deep drawdown", async () => {
  // Path with -3R drawdown but +0.5 cumulative → drawdown control fails
  const { status, data } = await j("POST", "/replay/sim/survival", {
    rMultiples: [-2, -1, 1, 1, 1.5],
    maxAllowedDrawdownR: 3,
    maxAllowedConsecutiveLosses: 4,
  });
  assert.equal(status, 200);
  assert.ok(["RUINED","FRAGILE"].includes(data.report.classification),
    `unexpected classification ${data.report.classification}`);
  assert.ok(data.report.maxDrawdownR >= 2.99);
  const types = await vaultTypes();
  assert.ok(types.includes("SURVIVAL_REPLAY_SCORED"));
});

test("S5 /replay/sim/survival ROBUST path has high survivalScore01", async () => {
  const { status, data } = await j("POST", "/replay/sim/survival", {
    rMultiples: [1, 1, -0.5, 1, 0.8, 1.2],
  });
  assert.equal(status, 200);
  assert.equal(data.report.classification, "ROBUST");
  assert.ok(data.report.survivalScore01 >= 0.70);
});

test("S6 /replay/sim/stress-injection FAKE_BREAKOUT flips a winner into a stop-out", async () => {
  const { status, data } = await j("POST", "/replay/sim/stress-injection", {
    snapshot: snap(),
    stress: { kind: "FAKE_BREAKOUT", pierceFraction: 1.5 },
  });
  assert.equal(status, 200);
  assert.equal(data.canPlaceTrades, false);
  assert.equal(data.replay.simulatedOutcome.status, "STOPPED_OUT");
  const types = await vaultTypes();
  assert.ok(types.includes("STRESS_INJECTION_REPLAYED"));
});

test("S7 stress injection VOLATILITY_SHOCK widens candle ranges", async () => {
  const { data } = await j("POST", "/replay/sim/stress-injection", {
    snapshot: snap(), stress: { kind: "VOLATILITY_SHOCK", rangeMultiplier: 3.0 },
    rerunReplay: false,
  });
  const c0 = data.mutatedSnapshot.candles[0];
  assert.ok(c0.high - c0.low >= 0.8 * 3 - 0.01); // original range 0.8 × 3
  assert.equal(data.mutatedSnapshot.market.volatilityBand, "EXTREME");
});

// ═══════════════════════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

function lossOutcome()  { return { status: "STOPPED_OUT", pnl: -100, rMultiple: -1.0 }; }
function winOutcome()   { return { status: "TARGET_HIT",  pnl:  200, rMultiple:  2.0 }; }
function flatOutcome()  { return { status: "TIME_EXIT",   pnl:    0, rMultiple:  0.0 }; }

test("A1 /replay/analysis/cluster groups by signature and sorts by size", async () => {
  const records = [
    record({}, winOutcome()),
    record({}, winOutcome()),
    record({ candles: candlesDown() }, lossOutcome()),
    record({ market: { ts: "2026-04-10T10:00:00.000Z", symbol: "X",
      regime: "CHOPPY", volatilityBand: "LOW", realizedVolPct: 0.5,
      spreadPips: 1, newsFlag: false, liquidityScore01: 0.9 } }, flatOutcome()),
  ];
  const { status, data } = await j("POST", "/replay/analysis/cluster", { records });
  assert.equal(status, 200);
  assert.equal(data.report.totalRecords, 4);
  assert.ok(data.report.clusterCount >= 2);
  // Largest cluster should be size 2
  assert.equal(data.report.clusters[0].size, 2);
  const types = await vaultTypes();
  assert.ok(types.includes("REPLAY_CLUSTER_FORMED"));
});

test("A2 /replay/analysis/patterns detects LOSS_DOMINATED_REGIME and OVERRIDE_HARM_PATTERN", async () => {
  const records = [
    record({}, lossOutcome()), record({}, lossOutcome()), record({}, lossOutcome()),
    record({}, winOutcome()),
    record({ decisionKind: "OVERRIDE" }, lossOutcome()),
    record({ decisionKind: "OVERRIDE" }, lossOutcome()),
    record({ decisionKind: "OVERRIDE" }, lossOutcome()),
  ];
  const { status, data } = await j("POST", "/replay/analysis/patterns", { records });
  assert.equal(status, 200);
  const kinds = data.patterns.map(p => p.kind);
  assert.ok(kinds.includes("LOSS_DOMINATED_REGIME"), `kinds=${kinds.join(",")}`);
  assert.ok(kinds.includes("OVERRIDE_HARM_PATTERN"), `kinds=${kinds.join(",")}`);
  const types = await vaultTypes();
  assert.ok(types.includes("REPLAY_PATTERN_DETECTED"));
});

test("A3 /replay/analysis/risk-heatmap surfaces hottest cell", async () => {
  const records = [
    record({}, lossOutcome()), record({}, lossOutcome()), record({}, winOutcome()),
    record({ market: { ts: "2026-04-10T10:00:00.000Z", symbol: "X", regime: "CHOPPY",
      volatilityBand: "LOW", realizedVolPct: 0.3, spreadPips: 1,
      newsFlag: false, liquidityScore01: 0.9 } }, winOutcome()),
  ];
  const { status, data } = await j("POST", "/replay/analysis/risk-heatmap", { records });
  assert.equal(status, 200);
  assert.ok(data.heatmap.hottest);
  assert.equal(data.heatmap.hottest.regime, "TRENDING");
  assert.ok(data.heatmap.hottest.risk01 >= data.heatmap.safest.risk01);
  const types = await vaultTypes();
  assert.ok(types.includes("REPLAY_RISK_HEATMAP_BUILT"));
});

test("A4 /replay/analysis/lesson-confidence DEFER on tiny sample, REINFORCE on strong", async () => {
  const tiny = await j("POST", "/replay/analysis/lesson-confidence", {
    supportingSampleSize: 1, totalSampleSize: 2, effectSize: 0.2, opposingSampleSize: 0,
  });
  assert.equal(tiny.status, 200);
  assert.equal(tiny.data.report.recommendation, "DEFER");

  const strong = await j("POST", "/replay/analysis/lesson-confidence", {
    supportingSampleSize: 8, totalSampleSize: 10, effectSize: 1.5, opposingSampleSize: 1,
  });
  assert.equal(strong.data.report.recommendation, "REINFORCE");
  assert.ok(strong.data.report.confidence01 >= 0.7);
});

test("A5 /replay/analysis/decision-sequence flags BREAKDOWN on harmful overrides", async () => {
  const decisions = [
    { decisionKind: "EXECUTED", outcomeR: -1, disciplineFollowed: true,  cognitiveLoad01: 0.3 },
    { decisionKind: "OVERRIDE", outcomeR: -2, disciplineFollowed: false, cognitiveLoad01: 0.8 },
    { decisionKind: "OVERRIDE", outcomeR: -1.5, disciplineFollowed: false, cognitiveLoad01: 0.85 },
    { decisionKind: "EXECUTED", outcomeR: -1, disciplineFollowed: false, cognitiveLoad01: 0.7 },
    { decisionKind: "OVERRIDE", outcomeR: -2, disciplineFollowed: false, cognitiveLoad01: 0.9 },
  ];
  const { status, data } = await j("POST", "/replay/analysis/decision-sequence", { decisions });
  assert.equal(status, 200);
  assert.ok(["WEAK","BREAKDOWN"].includes(data.report.classification),
    `expected WEAK or BREAKDOWN, got ${data.report.classification}`);
  assert.ok(data.report.disciplineRate01 <= 0.3);
  assert.ok(data.report.overrideHarmRate01 >= 0.9);
  const types = await vaultTypes();
  assert.ok(types.includes("DECISION_SEQUENCE_SCORED"));
});

test("A6 /replay/analysis/regret-relief classifies blocked-loss-avoided and confidence-damaging", async () => {
  const records = [
    // Block + would-lose → BLOCKED_LOSS_AVOIDED (relief)
    record({ decisionKind: "BLOCKED" }, lossOutcome()),
    // Block + would-win → BLOCKED_WINNER_MISSED (regret)
    record({ decisionKind: "BLOCKED" }, winOutcome()),
    // High confidence loss → CONFIDENCE_DAMAGING
    record({ judgeVerdict: { decision: "APPROVE", confidence01: 0.9, blockReasons: [], agreementScore01: 0.9 } },
            lossOutcome()),
    // Discipline followed + flat outcome → DISCIPLINE_IMPROVING
    record({}, winOutcome()),
  ];
  const { status, data } = await j("POST", "/replay/analysis/regret-relief", { records });
  assert.equal(status, 200);
  assert.equal(data.aggregate.totalRecords, 4);
  assert.ok(data.aggregate.perBucketCount.BLOCKED_LOSS_AVOIDED >= 1);
  assert.ok(data.aggregate.perBucketCount.BLOCKED_WINNER_MISSED >= 1);
  assert.ok(data.aggregate.perBucketCount.CONFIDENCE_DAMAGING >= 1);
  assert.ok(data.aggregate.perBucketCount.DISCIPLINE_IMPROVING >= 1);
  const types = await vaultTypes();
  assert.ok(types.includes("REGRET_RELIEF_CLASSIFIED"));
});

// ═══════════════════════════════════════════════════════════════════════════
// Invariants
// ═══════════════════════════════════════════════════════════════════════════
test("TZ phase6b never emits TRADE_*/MODE_*/SIGNAL_* and always sets canPlaceTrades:false", async () => {
  // Hit several phase6b endpoints
  await j("POST", "/replay/sim/decision-tree", {
    snapshot: snap(),
    branches: [{ name: "AS_IS", mutations: [{ kind: "REDUCED_SIZE", sizeFactor: 1 }] }],
  });
  await j("POST", "/replay/sim/alternate-paths", { snapshot: snap() });
  await j("POST", "/replay/sim/survival", { rMultiples: [1, -0.5, 1] });
  await j("POST", "/replay/sim/stress-injection", {
    snapshot: snap(), stress: { kind: "LATENCY", latencyMs: 250 } });
  await j("POST", "/replay/analysis/lesson-confidence", {
    supportingSampleSize: 6, totalSampleSize: 8, effectSize: 1.0, opposingSampleSize: 1 });

  const types = await vaultTypes();
  for (const t of types) {
    assert.ok(!/^TRADE_/.test(t),  `forbidden TRADE_ event ${t}`);
    assert.ok(!/^MODE_/.test(t),   `forbidden MODE_  event ${t}`);
    assert.ok(!/^SIGNAL_/.test(t), `forbidden SIGNAL_ event ${t}`);
  }
});

test("TZ2 invalid bodies return 400", async () => {
  const r = await j("POST", "/replay/sim/decision-tree", { snapshot: snap(), branches: [] });
  assert.equal(r.status, 400);
  const r2 = await j("POST", "/replay/analysis/lesson-confidence", { supportingSampleSize: -1 });
  assert.equal(r2.status, 400);
});
