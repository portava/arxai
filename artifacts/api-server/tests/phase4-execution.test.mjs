// ═══════════════════════════════════════════════════════════════════════════
// Phase 4 — Execution Realism tests.
// Verifies advisory pipeline, score components, verdict downgrade, replay
// comparison, broker health classification, vault logging.
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
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const assess  = (b) => j("POST", "/execution/assess",         b);
const replay  = (b) => j("POST", "/execution/replay-compare", b);

before(async () => { await pool.query(`SELECT 1`); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
});

function cleanOrder(over = {}) {
  return {
    symbolId: "Volatility 75 Index", brokerId: "DerivMT5",
    side: "BUY", type: "MARKET",
    intendedPrice: 100, intendedSizeLots: 0.5,
    stopLossPips: 100, takeProfitPips: 200,
    spreadPips: 0.5, avgSpreadPips: 0.5,
    topBookDepthLots: 5, recentVolumeZ: 0,
    recentVolatilityZ: 0, newsActiveWindow: false,
    ...over,
  };
}
function cleanBroker(over = {}) {
  return { recentRejects: 0, recentRequotes: 0, recentTotalOrders: 100, recentLatencyMs: 80, ...over };
}

// ─── Score & action mapping ─────────────────────────────────────────────
test("EX4-1 clean conditions → LOW risk, NONE action, no downgrade", async () => {
  const r = await assess({
    decisionId: "ex_clean", order: cleanOrder(), decisionLatencyMs: 80,
    broker: cleanBroker(), councilVerdict: "EXECUTE", baseSizeMultiplier: 1,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.riskScore.level, "LOW");
  assert.equal(r.data.riskScore.recommendedAction, "NONE");
  assert.equal(r.data.postExecutionVerdict.verdict, "EXECUTE");
  assert.equal(r.data.postExecutionVerdict.downgraded, false);
  assert.equal(r.data.brokerHealth.status, "HEALTHY");
});

test("EX4-2 spread spike → blocker + SPREAD_SPIKE event", async () => {
  const r = await assess({
    decisionId: "ex_spread",
    order: cleanOrder({ spreadPips: 5, avgSpreadPips: 1 }), // 5× avg → hard
    decisionLatencyMs: 80, broker: cleanBroker(),
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.riskScore.recommendedAction, "HARD_BLOCK");
  assert.ok(r.data.riskScore.blockers.some(b => /spread/i.test(b)));
  const rows = await pool.query(`SELECT event_type FROM audit_events ORDER BY id`);
  const types = rows.rows.map(r => r.event_type);
  assert.ok(types.includes("SPREAD_SPIKE"));
  assert.ok(types.includes("EXECUTION_RISK_ASSESSED"));
  assert.ok(types.includes("EXECUTION_FILL_ANOMALY"));
});

test("EX4-3 high latency → WAIT verdict (or HARD_BLOCK at hard cap) + LATENCY_ANOMALY", async () => {
  const r = await assess({
    decisionId: "ex_lat",
    order: cleanOrder(), decisionLatencyMs: 1000, broker: cleanBroker(),
    councilVerdict: "EXECUTE",
  });
  assert.equal(r.data.riskScore.recommendedAction, "WAIT");
  assert.equal(r.data.postExecutionVerdict.verdict, "WAIT");
  assert.equal(r.data.postExecutionVerdict.downgraded, true);
  const t = (await pool.query(`SELECT event_type FROM audit_events`)).rows.map(r => r.event_type);
  assert.ok(t.includes("LATENCY_ANOMALY"));
});

test("EX4-4 hard latency cap → HARD_BLOCK", async () => {
  const r = await assess({
    decisionId: "ex_hardlat",
    order: cleanOrder(), decisionLatencyMs: 1500, broker: cleanBroker(),
    councilVerdict: "EXECUTE",
  });
  assert.equal(r.data.riskScore.recommendedAction, "HARD_BLOCK");
  assert.equal(r.data.postExecutionVerdict.verdict, "HARD_BLOCK");
  assert.equal(r.data.postExecutionVerdict.sizeMultiplier, 0);
});

test("EX4-5 broker instability → SOFT_BLOCK / HARD_BLOCK + BROKER_INSTABILITY", async () => {
  const r = await assess({
    decisionId: "ex_broker",
    order: cleanOrder(),
    decisionLatencyMs: 80,
    broker: { recentRejects: 30, recentRequotes: 10, recentTotalOrders: 100, recentLatencyMs: 200 },
    councilVerdict: "EXECUTE",
  });
  assert.ok(["SOFT_BLOCK", "HARD_BLOCK"].includes(r.data.riskScore.recommendedAction));
  assert.ok(["UNSTABLE", "OUTAGE"].includes(r.data.brokerHealth.status));
  const t = (await pool.query(`SELECT event_type FROM audit_events`)).rows.map(r => r.event_type);
  assert.ok(t.includes("BROKER_INSTABILITY"));
});

test("EX4-6 liquidity shortfall → REDUCE_SIZE with size capped to fillable ratio", async () => {
  const r = await assess({
    decisionId: "ex_liq",
    order: cleanOrder({ intendedSizeLots: 4, topBookDepthLots: 1 }),
    decisionLatencyMs: 80, broker: cleanBroker(),
    councilVerdict: "EXECUTE", baseSizeMultiplier: 1,
  });
  // Either REDUCE_SIZE (partial) or HARD_BLOCK (>50% shortfall blocker).
  assert.ok(["REDUCE_SIZE", "HARD_BLOCK"].includes(r.data.riskScore.recommendedAction));
  if (r.data.riskScore.recommendedAction === "REDUCE_SIZE") {
    assert.ok(r.data.postExecutionVerdict.sizeMultiplier < 1);
    assert.equal(r.data.postExecutionVerdict.verdict, "REDUCE_SIZE");
  }
});

test("EX4-7 components scalars are all in [0,1]", async () => {
  const r = await assess({
    decisionId: "ex_comp", order: cleanOrder({ recentVolatilityZ: 5, recentVolumeZ: -3 }),
    decisionLatencyMs: 600, broker: cleanBroker({ recentRejects: 5, recentRequotes: 5 }),
  });
  for (const [k, v] of Object.entries(r.data.riskScore.components)) {
    assert.ok(v >= 0 && v <= 1, `${k} out of [0,1]: ${v}`);
  }
});

test("EX4-8 execution can NEVER upgrade verdict — base SOFT_BLOCK stays SOFT_BLOCK on clean exec", async () => {
  const r = await assess({
    decisionId: "ex_noupg", order: cleanOrder(), decisionLatencyMs: 50,
    broker: cleanBroker(), councilVerdict: "SOFT_BLOCK",
  });
  assert.equal(r.data.postExecutionVerdict.verdict, "SOFT_BLOCK");
  assert.equal(r.data.postExecutionVerdict.downgraded, false);
});

test("EX4-9 invalid body → 400", async () => {
  const r = await assess({ decisionId: "ex_bad", order: { foo: 1 }, decisionLatencyMs: -1, broker: {} });
  assert.equal(r.status, 400);
});

// ─── Replay comparison ──────────────────────────────────────────────────
function snap(over = {}) {
  return {
    decisionId: "rep_1", capturedAtIso: new Date().toISOString(),
    symbolId: "Volatility 75 Index", brokerId: "DerivMT5", side: "BUY",
    spreadAtEntryPips: 0.5, avgSpreadPips: 0.5,
    latencyAtDecisionMs: 100, brokerHealth01: 0.95, brokerHealthStatus: "HEALTHY",
    liquidityDepthLots: 5, newsActiveWindow: false,
    expectedFill: { fillPrice: 100, expectedSlippagePips: 0.5,
                    fillProbability01: 0.95, qualityScore01: 0.9 },
    ...over,
  };
}
function fill(over = {}) {
  return { fillPrice: 100, fillLatencyMs: 100, filledLots: 0.5, intendedLots: 0.5,
           rejected: false, requoted: false, ...over };
}

test("EX4-R1 perfect fill → NONE deviation, no anomaly event, INFO log only", async () => {
  const r = await replay({ snapshot: snap(), actual: fill(), actualQualityScore01: 0.9 });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.comparison.deviation, "NONE");
  const rows = (await pool.query(`SELECT event_type FROM audit_events`)).rows.map(r => r.event_type);
  assert.ok(rows.includes("EXECUTION_REPLAY_COMPARED"));
  assert.ok(!rows.includes("EXECUTION_FILL_ANOMALY"));
});

test("EX4-R2 rejected order → SEVERE deviation + EXECUTION_FILL_ANOMALY DANGER", async () => {
  const r = await replay({
    snapshot: snap({ decisionId: "rep_rej" }),
    actual: fill({ rejected: true, filledLots: 0 }),
  });
  assert.equal(r.data.comparison.deviation, "SEVERE");
  assert.ok(r.data.comparison.anomalies.some(s => /REJECTED/.test(s)));
  const row = await pool.query(`SELECT severity FROM audit_events WHERE event_type='EXECUTION_FILL_ANOMALY'`);
  assert.equal(row.rows[0].severity, "DANGER");
});

test("EX4-R3 large slippage on BUY (paid more) → MAJOR/SEVERE", async () => {
  // BUY filled higher than expected → trader paid more.
  const r = await replay({
    snapshot: snap({ decisionId: "rep_slip" }),
    actual: fill({ fillPrice: 100.001 }),  // +10 pips at 0.0001 pip
  });
  assert.ok(["MAJOR", "SEVERE"].includes(r.data.comparison.deviation));
  assert.ok(r.data.comparison.slippageDeltaPips > 5);
});

test("EX4-R4 slippage sign: SELL filled lower than expected → also adverse", async () => {
  const r = await replay({
    snapshot: snap({ decisionId: "rep_sell", side: "SELL" }),
    actual: fill({ fillPrice: 99.9994 }),  // SELL got 0.0006 less → ~6p adverse
  });
  assert.ok(r.data.comparison.slippageDeltaPips > 0);
});

test("EX4-R5 invalid replay body → 400", async () => {
  const r = await replay({ snapshot: { foo: 1 }, actual: {} });
  assert.equal(r.status, 400);
});

// ─── Safety invariants ──────────────────────────────────────────────────
test("EX4-Z execution endpoints never emit TRADE_* and don't touch safety_core", async () => {
  const before = await pool.query(`SELECT operational_mode FROM safety_core`);
  await assess({ decisionId: "z1", order: cleanOrder(), decisionLatencyMs: 80, broker: cleanBroker() });
  await replay({ snapshot: snap({ decisionId: "z2" }), actual: fill() });
  const after = await pool.query(`SELECT operational_mode FROM safety_core`);
  assert.equal(after.rows[0].operational_mode, before.rows[0].operational_mode);
  const trades = await pool.query(`
    SELECT COUNT(*)::int n FROM audit_events
     WHERE event_type IN ('TRADE_APPROVED','TRADE_EXECUTED','TRADE_BLOCKED','TRADE_REJECTED','TRADE_GATE')
  `);
  assert.equal(trades.rows[0].n, 0);
});
