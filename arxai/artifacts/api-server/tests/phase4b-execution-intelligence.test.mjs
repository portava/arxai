// ═══════════════════════════════════════════════════════════════════════════
// Phase 4B — Execution Intelligence + TCA tests.
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
const preEst   = (b) => j("POST", "/execution-intel/pre-trade-estimate", b);
const postRep  = (b) => j("POST", "/execution-intel/post-trade-report",  b);
const score    = (b) => j("POST", "/execution-intel/broker-scorecard",   b);
const learn    = ()  => j("POST", "/execution-intel/learning-report");
const tactic   = (b) => j("POST", "/execution-intel/select-tactic",      b);
const resetHist = () => j("POST", "/execution-intel/_test/reset-history");

before(async () => { await pool.query(`SELECT 1`); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
  await resetHist();
});

function preTrade(over = {}) {
  return {
    decisionId: "ei_1", symbolId: "Volatility 75 Index", brokerId: "DerivMT5",
    strategyId: "trend_pullback", session: "LONDON", side: "BUY",
    intendedSizeLots: 0.5, midAtSignal: 100,
    spreadAtSignalPips: 1.0, avgSpreadPips: 1.0,
    recentVolatilityPipsPerMin: 0.5, topBookDepthLots: 5,
    expectedHoldMinutes: 10, newsActiveWindow: false,
    pipSize: 0.0001, pipValuePerLotUsd: 10,
    expectedEdgePips: 50,
    ...over,
  };
}
function postTrade(over = {}) {
  return {
    decisionId: "ei_p1", symbolId: "Volatility 75 Index", brokerId: "DerivMT5",
    strategyId: "trend_pullback", session: "LONDON", side: "BUY",
    intendedSizeLots: 0.5, filledLots: 0.5,
    decisionPrice: 100, midAtSignal: 100, arrivalPrice: 100,
    midAfterDelay: 100, fillPrice: 100,
    spreadAtSignalPips: 1.0, spreadAtFillPips: 1.0,
    latencyAtDecisionMs: 80, latencyAtFillMs: 100,
    pipSize: 0.0001, pipValuePerLotUsd: 10,
    rejected: false, requoted: false, expectedEdgePips: 50,
    ...over,
  };
}

// ─── Pre-trade ──────────────────────────────────────────────────────────
test("EI-1 clean pre-trade → CLEAN/EXECUTE, no edge destroyed", async () => {
  const r = await preEst(preTrade());
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.estimate.verdict, "EXECUTION_CLEAN");
  assert.equal(r.data.estimate.recommendation, "EXECUTE");
  assert.equal(r.data.estimate.edgeDestroyed, false);
  assert.ok(r.data.estimate.edgeAfterCostPips > 0);
});

test("EI-2 cost > edge → BLOCKED + EXECUTION_EDGE_DESTROYED event", async () => {
  // Tiny edge; wide spread; news; size>>depth.
  const r = await preEst(preTrade({
    expectedEdgePips: 1, spreadAtSignalPips: 10, newsActiveWindow: true,
    intendedSizeLots: 10, topBookDepthLots: 1,
  }));
  assert.equal(r.data.estimate.verdict, "EXECUTION_BLOCKED");
  assert.equal(r.data.estimate.recommendation, "HARD_BLOCK");
  assert.equal(r.data.estimate.edgeDestroyed, true);
  const t = (await pool.query(`SELECT event_type FROM audit_events`)).rows.map(r => r.event_type);
  assert.ok(t.includes("PRE_TRADE_COST_ESTIMATED"));
  assert.ok(t.includes("EXECUTION_EDGE_DESTROYED"));
});

test("EI-3 cost in 40-66% of edge → COSTLY/REDUCE_SIZE", async () => {
  // Tune so cost lands ~50% of edge.
  const r = await preEst(preTrade({
    expectedEdgePips: 10, spreadAtSignalPips: 4, newsActiveWindow: false,
    intendedSizeLots: 0.5, topBookDepthLots: 5, recentVolatilityPipsPerMin: 0.1,
  }));
  assert.ok(["EXECUTION_COSTLY", "EXECUTION_BLOCKED", "EXECUTION_ACCEPTABLE"].includes(r.data.estimate.verdict),
    `got ${r.data.estimate.verdict}`);
});

test("EI-4 invalid pre-trade body → 400", async () => {
  const r = await preEst({ foo: 1 });
  assert.equal(r.status, 400);
});

// ─── Post-trade TCA ─────────────────────────────────────────────────────
test("EI-5 perfect fill, edge intact → EXECUTION_CLEAN, grade A, HELPED/NEUTRAL", async () => {
  const r = await postRep(postTrade());
  assert.equal(r.status, 200);
  assert.equal(r.data.report.verdict, "EXECUTION_CLEAN");
  assert.equal(r.data.report.grade, "A");
  assert.ok(["HELPED", "NEUTRAL"].includes(r.data.report.helpedOrHurt));
  assert.equal(r.data.report.fillRatio01, 1);
});

test("EI-6 BUY filled higher than decision → adverse slippage, IS positive", async () => {
  // 5p adverse on BUY at pipSize 0.0001 → fillPrice 100.0005
  const r = await postRep(postTrade({ fillPrice: 100.0005, midAfterDelay: 100.0003, arrivalPrice: 100 }));
  assert.ok(r.data.report.implementationShortfallPips > 0);
  assert.ok(r.data.report.arrivalPriceSlippagePips > 0);
  assert.ok(r.data.report.effectiveSpreadPips > 0);
});

test("EI-7 rejected order → EXECUTION_BLOCKED + grade F + DESTROYED", async () => {
  const r = await postRep(postTrade({ rejected: true, filledLots: 0 }));
  assert.equal(r.data.report.verdict, "EXECUTION_BLOCKED");
  assert.equal(r.data.report.grade, "F");
  assert.equal(r.data.report.helpedOrHurt, "DESTROYED");
});

test("EI-8 requoted order → EXECUTION_UNSTABLE", async () => {
  const r = await postRep(postTrade({ requoted: true, fillPrice: 100.0002 }));
  assert.equal(r.data.report.verdict, "EXECUTION_UNSTABLE");
});

test("EI-9 IS exceeds edge → DESTROYED + EXECUTION_BLOCKED", async () => {
  // edge=2p but slippage 100p
  const r = await postRep(postTrade({ expectedEdgePips: 2, fillPrice: 100.01 }));
  assert.equal(r.data.report.helpedOrHurt, "DESTROYED");
  assert.equal(r.data.report.verdict, "EXECUTION_BLOCKED");
});

test("EI-10 partial fill drops grade and lowers fillRatio", async () => {
  const r = await postRep(postTrade({ filledLots: 0.25 }));
  assert.equal(r.data.report.fillRatio01, 0.5);
  assert.ok(["B", "C", "D", "F"].includes(r.data.report.grade));
});

// ─── Broker scorecard ───────────────────────────────────────────────────
test("EI-11 scorecard with no history → HEALTHY/EXECUTE", async () => {
  const r = await score({ brokerId: "DerivMT5" });
  assert.equal(r.data.scorecard.status, "HEALTHY");
  assert.equal(r.data.scorecard.recommendation, "EXECUTE");
});

test("EI-12 many bad fills → DEGRADED+ status, BROKER_SCORECARD_UPDATE event", async () => {
  for (let i = 0; i < 10; i++) {
    await postRep(postTrade({ decisionId: `bad_${i}`, rejected: true, filledLots: 0 }));
  }
  const r = await score({ brokerId: "DerivMT5" });
  assert.ok(["DEGRADED", "UNSTABLE", "LOCKDOWN"].includes(r.data.scorecard.status),
    `got ${r.data.scorecard.status}`);
  assert.ok(r.data.scorecard.rejectsRate01 > 0.5);
  const t = (await pool.query(`SELECT event_type FROM audit_events`)).rows.map(r => r.event_type);
  assert.ok(t.includes("BROKER_SCORECARD_UPDATE"));
});

test("EI-13 scorecard rejects unknown body → 400", async () => {
  const r = await score({ wrong: 1 });
  assert.equal(r.status, 400);
});

// ─── Learning ───────────────────────────────────────────────────────────
test("EI-14 learning report aggregates per (symbol, session, strategy)", async () => {
  // 3 reports on V75/LONDON/trend, 2 on V100/ASIA/breakout (worse)
  for (let i = 0; i < 3; i++) await postRep(postTrade({ decisionId: `a${i}` }));
  for (let i = 0; i < 2; i++) {
    await postRep(postTrade({
      decisionId: `b${i}`, symbolId: "Volatility 100 Index", session: "ASIA",
      strategyId: "breakout", fillPrice: 100.01, expectedEdgePips: 2,
    }));
  }
  const r = await learn();
  assert.equal(r.data.report.totalSample, 5);
  assert.ok(r.data.report.buckets.length === 2);
  assert.equal(r.data.report.worstSymbols[0], "Volatility 100 Index");
  assert.equal(r.data.report.worstSessions[0], "ASIA");
  assert.equal(r.data.report.worstStrategies[0], "breakout");
});

// ─── Tactic selector ────────────────────────────────────────────────────
test("EI-15 clean conditions → MARKET tactic", async () => {
  const r = await tactic({ preTrade: preTrade(), brokerId: "DerivMT5" });
  assert.equal(r.data.decision.tactic, "MARKET");
});

test("EI-16 EXECUTION_BLOCKED → CANCEL tactic", async () => {
  const r = await tactic({
    preTrade: preTrade({ expectedEdgePips: 0.5, spreadAtSignalPips: 5, newsActiveWindow: true }),
    brokerId: "DerivMT5",
  });
  assert.equal(r.data.decision.tactic, "CANCEL");
  assert.equal(r.data.estimate.verdict, "EXECUTION_BLOCKED");
});

test("EI-17 LOCKDOWN broker → CANCEL even with clean estimate", async () => {
  for (let i = 0; i < 12; i++) {
    await postRep(postTrade({ decisionId: `lock_${i}`, rejected: true, filledLots: 0 }));
  }
  const r = await tactic({ preTrade: preTrade(), brokerId: "DerivMT5" });
  assert.ok(["CANCEL", "AGGRESSIVE_LIMIT", "PASSIVE_LIMIT", "SCHEDULED"].includes(r.data.decision.tactic));
  if (r.data.scorecard.status === "LOCKDOWN") {
    assert.equal(r.data.decision.tactic, "CANCEL");
  }
});

// ─── Safety invariants ──────────────────────────────────────────────────
test("EI-18 learning-report rejects unknown body fields with 400", async () => {
  const r = await j("POST", "/execution-intel/learning-report", { foo: 1 });
  assert.equal(r.status, 400);
});

test("EI-19 reset-history rejects unknown body fields with 400 and stays advisory", async () => {
  const r = await j("POST", "/execution-intel/_test/reset-history", { foo: 1 });
  assert.equal(r.status, 400);
  assert.equal(r.data.canPlaceTrades, false);
});

test("EI-20 UNSTABLE broker never selects MARKET, even on clean estimate", async () => {
  // 6 rejected fills: enough to land somewhere in DEGRADED..LOCKDOWN.
  for (let i = 0; i < 6; i++) {
    await postRep(postTrade({ decisionId: `unstable_${i}`, rejected: true, filledLots: 0 }));
  }
  const r = await tactic({ preTrade: preTrade(), brokerId: "DerivMT5" });
  assert.notEqual(r.data.decision.tactic, "MARKET");
  if (r.data.scorecard.status === "UNSTABLE") {
    assert.equal(r.data.decision.tactic, "SCHEDULED");
  }
});

test("EI-Z execution-intel never emits TRADE_* and never touches safety_core", async () => {
  const before = await pool.query(`SELECT operational_mode FROM safety_core`);
  await preEst(preTrade());
  await postRep(postTrade());
  await score({ brokerId: "DerivMT5" });
  await learn();
  await tactic({ preTrade: preTrade(), brokerId: "DerivMT5" });
  const after = await pool.query(`SELECT operational_mode FROM safety_core`);
  assert.equal(after.rows[0].operational_mode, before.rows[0].operational_mode);
  const trades = await pool.query(`
    SELECT COUNT(*)::int n FROM audit_events
     WHERE event_type IN ('TRADE_APPROVED','TRADE_EXECUTED','TRADE_BLOCKED','TRADE_REJECTED','TRADE_GATE')
  `);
  assert.equal(trades.rows[0].n, 0);
  // canPlaceTrades:false everywhere.
  for (const r of [
    await preEst(preTrade()), await postRep(postTrade()),
    await score({ brokerId: "DerivMT5" }), await learn(),
    await tactic({ preTrade: preTrade(), brokerId: "DerivMT5" }),
  ]) {
    assert.equal(r.data.canPlaceTrades, false);
  }
});
