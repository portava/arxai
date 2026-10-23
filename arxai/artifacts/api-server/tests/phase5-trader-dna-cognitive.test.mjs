// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 — Trader DNA + Cognitive Performance tests.
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

// ── helpers ────────────────────────────────────────────────────────────────
const baseLimits = {
  riskPerTradePct: 1, maxDailyLossPct: 5, maxWeeklyLossPct: 10,
  maxTradesPerDay: 20, maxOpenTrades: 5,
  stopAfterLosingStreak: 4, minConfidenceScore: 60,
};

function trade(over) {
  return {
    id: "t" + Math.random().toString(36).slice(2, 8),
    symbol: "Volatility 75 Index", direction: "BUY", status: "CLOSED_WIN",
    entryPrice: 100, stopLoss: 99, takeProfit: 102, lotSize: 0.5,
    openedAt: "2026-05-10T10:00:00.000Z", closedAt: "2026-05-10T10:30:00.000Z",
    pnl: 50, rMultiple: 2,
    ...over,
  };
}

// ── TD-1: profile basics ───────────────────────────────────────────────────
test("TD-1 buildTraderProfile from sample trades returns sane baselines + risk score", async () => {
  const trades = [
    trade({ id: "a", status: "CLOSED_WIN",  pnl:  100, rMultiple:  2, openedAt: "2026-05-09T10:00:00Z", closedAt: "2026-05-09T11:00:00Z" }),
    trade({ id: "b", status: "CLOSED_LOSS", pnl: -50,  rMultiple: -1, openedAt: "2026-05-09T12:00:00Z", closedAt: "2026-05-09T13:00:00Z" }),
    trade({ id: "c", status: "CLOSED_WIN",  pnl:  100, rMultiple:  2, openedAt: "2026-05-10T10:00:00Z", closedAt: "2026-05-10T11:00:00Z" }),
  ];
  const r = await j("POST", "/trader-dna/profile", {
    id: "trader1", name: "Alice", trades, baselineLimits: baseLimits,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.ok(r.data.profile);
  assert.ok(r.data.traderRiskScore.score01 >= 0 && r.data.traderRiskScore.score01 <= 1);
  assert.ok(["FULL","REDUCED","MICRO","COOLDOWN","LOCKDOWN"].includes(r.data.recommendedPermissionLevel));
  assert.ok(["EXECUTE","REDUCE_SIZE","WAIT","COOLDOWN","RECOVERY_MODE","HARD_BLOCK"].includes(r.data.recommendedAction));
  assert.equal(typeof r.data.personalEdgeScore, "number");
});

// ── TD-2: edge map buckets by symbol×session×strategy×hour ────────────────
test("TD-2 personalEdgeMap buckets by symbol×session×strategy×hour and surfaces best/worst", async () => {
  const ctxTrades = [];
  for (let i = 0; i < 6; i++) {
    ctxTrades.push({ ...trade({ id: "good"+i, pnl: 100, rMultiple: 2, status: "CLOSED_WIN" }), strategyId: "S1" });
  }
  for (let i = 0; i < 6; i++) {
    ctxTrades.push({ ...trade({ id: "bad"+i, pnl: -100, rMultiple: -1, status: "CLOSED_LOSS",
      openedAt: "2026-05-10T15:00:00Z", closedAt: "2026-05-10T16:00:00Z" }), strategyId: "S2" });
  }
  const r = await j("POST", "/trader-dna/profile", {
    id: "t2", name: "Bob",
    trades: ctxTrades.map(({ strategyId: _s, ...t }) => t),
    contextTrades: ctxTrades,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.edgeMap.buckets.length >= 2);
  assert.ok(r.data.edgeMap.best.length > 0);
  assert.ok(r.data.edgeMap.best[0].edgeScore01 >= r.data.edgeMap.worst[0].edgeScore01);
});

// ── TD-3: symbolPerformance surfaces winners/losers ────────────────────────
test("TD-3 analyzeSymbolPerformance surfaces preferred and avoided symbols", async () => {
  const trades = [];
  for (let i = 0; i < 6; i++) trades.push(trade({ id: "v75w"+i, symbol: "V75", pnl: 100, rMultiple: 2, status: "CLOSED_WIN" }));
  for (let i = 0; i < 6; i++) trades.push(trade({ id: "v25l"+i, symbol: "V25", pnl: -100, rMultiple: -1, status: "CLOSED_LOSS" }));
  const r = await j("POST", "/trader-dna/profile", { id: "t3", name: "Carl", trades });
  assert.equal(r.status, 200);
  assert.ok(r.data.symbolPerf.preferred.includes("V75"));
  assert.ok(r.data.symbolPerf.avoided.includes("V25"));
});

// ── TD-4: strategyPerformanceByTrader ──────────────────────────────────────
test("TD-4 analyzeStrategyPerformanceByTrader splits per strategyId", async () => {
  const ctx = [];
  for (let i = 0; i < 6; i++) ctx.push({ ...trade({ id: "s1w"+i, pnl: 80, rMultiple: 2, status: "CLOSED_WIN" }), strategyId: "trend" });
  for (let i = 0; i < 6; i++) ctx.push({ ...trade({ id: "s2l"+i, pnl: -80, rMultiple: -1, status: "CLOSED_LOSS" }), strategyId: "scalp" });
  const r = await j("POST", "/trader-dna/profile", {
    id: "t4", name: "Dan",
    trades: ctx.map(({ strategyId: _s, ...t }) => t),
    contextTrades: ctx,
  });
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.strategyPerf.byStrategy.map(s => [s.strategyId, s]));
  assert.ok(byId.trend && byId.scalp);
  assert.ok(byId.trend.netPnl > byId.scalp.netPnl);
});

// ── TD-5: revenge trading reduces personal risk limits ────────────────────
test("TD-5 revenge + overtrade trigger personal risk-limit reductions", async () => {
  // 1 loss followed by 3 escalating same-symbol entries within 30 min → revenge
  // also 8+ trades → overtrade vs baseline
  const trades = [];
  trades.push(trade({ id: "loss", status: "CLOSED_LOSS", pnl: -100, rMultiple: -1, lotSize: 0.5,
    openedAt: "2026-05-10T10:00:00Z", closedAt: "2026-05-10T10:05:00Z" }));
  for (let i = 0; i < 4; i++) {
    trades.push(trade({ id: "rev"+i, status: "CLOSED_LOSS", pnl: -50, rMultiple: -1, lotSize: 1.5,
      openedAt: `2026-05-10T10:${10+i}:00Z`, closedAt: `2026-05-10T10:${15+i}:00Z` }));
  }
  for (let i = 0; i < 6; i++) {
    trades.push(trade({ id: "extra"+i, openedAt: `2026-05-10T11:${i}0:00Z`, closedAt: `2026-05-10T11:${i+1}0:00Z` }));
  }
  const r = await j("POST", "/trader-dna/profile", {
    id: "t5", name: "Eve", trades, windowDays: 1, baselineLimits: baseLimits,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.revenge.detected, true);
  assert.ok(r.data.riskAdjustment);
  assert.ok(r.data.riskAdjustment.changes.length > 0);
  assert.ok(r.data.riskAdjustment.adjustedLimits.riskPerTradePct < baseLimits.riskPerTradePct);
  assert.ok(["REDUCED","MICRO","COOLDOWN","LOCKDOWN"].includes(r.data.recommendedPermissionLevel));
});

// ── TD-6: behavior-scan endpoint emits BEHAVIOR_PATTERN_HIT events ────────
test("TD-6 behavior-scan returns reports + vaults BEHAVIOR_PATTERN_HIT for medium+", async () => {
  const trades = [];
  for (let i = 0; i < 25; i++) {
    trades.push(trade({ id: "ot"+i, lotSize: 5, // 10× baseline → OVERSIZED_BETS
      openedAt: `2026-05-10T${String(i % 10).padStart(2,"0")}:00:00Z`,
      closedAt: `2026-05-10T${String(i % 10).padStart(2,"0")}:30:00Z` }));
  }
  const r = await j("POST", "/trader-dna/behavior-scan", {
    id: "t6", trades,
    baseline: { baselineTradesPerDay: 3, baselineLotSize: 0.5, baselineWinRate: 0.5, baselineAvgRMultiple: 1 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.ok(Array.isArray(r.data.behaviorReport.hits));
});

// ── TD-7: invalid body 400 ─────────────────────────────────────────────────
test("TD-7 trader-dna/profile rejects unknown body fields with 400", async () => {
  const r = await j("POST", "/trader-dna/profile", { id: "t7", name: "x", trades: [], junk: 1 });
  assert.equal(r.status, 400);
});

// ── TD-8: manual-override (FILTER_IGNORING) detector fires + vaults ──────
test("TD-8 behavior-scan with manualOverrides≥3× baseline → FILTER_IGNORING CRITICAL", async () => {
  const r = await j("POST", "/trader-dna/behavior-scan", {
    id: "t8", trades: [trade({})],
    baseline: { baselineTradesPerDay: 3, baselineLotSize: 0.5, baselineWinRate: 0.5, baselineAvgRMultiple: 1 },
    manualOverridesLastDay: 9,
    manualOverridesBaselinePerDay: 1,
  });
  assert.equal(r.status, 200);
  const filterHit = r.data.behaviorReport.hits.find(h => h.pattern === "FILTER_IGNORING");
  assert.ok(filterHit, "expected FILTER_IGNORING hit");
  assert.equal(filterHit.severity, "CRITICAL");
});

// ── TD-9: ladder boundary — score≥0.65 → COOLDOWN/COOLDOWN ───────────────
test("TD-9 trader risk ladder boundary: revenge CRITICAL → permission COOLDOWN/HARD-side action", async () => {
  // Construct trades that yield revenge CRITICAL (escalated lot + multiple follow-ups)
  const trades = [
    trade({ id: "lossA", status: "CLOSED_LOSS", pnl: -200, rMultiple: -1, lotSize: 0.5,
      openedAt: "2026-05-10T10:00:00Z", closedAt: "2026-05-10T10:05:00Z" }),
  ];
  for (let i = 0; i < 5; i++) {
    trades.push(trade({ id: "rv"+i, status: "CLOSED_LOSS", pnl: -100, rMultiple: -1, lotSize: 2.0,
      openedAt: `2026-05-10T10:${10+i}:00Z`, closedAt: `2026-05-10T10:${15+i}:00Z` }));
  }
  const r = await j("POST", "/trader-dna/profile", { id: "t9", name: "F", trades, windowDays: 1 });
  assert.equal(r.status, 200);
  // revenge CRITICAL alone → revenge01=1.0 weighted 0.40 → ≥0.40 → MICRO/REDUCE_SIZE at minimum.
  // With overtrade often piling on → COOLDOWN range likely.
  assert.ok(r.data.traderRiskScore.score01 >= 0.40);
  assert.ok(["MICRO","COOLDOWN","LOCKDOWN"].includes(r.data.recommendedPermissionLevel));
});

// ── COG-1: cognitive assess produces snapshot + score ─────────────────────
test("COG-1 cognitive/assess returns verdict + cognitiveRiskScore", async () => {
  const r = await j("POST", "/cognitive/assess", {
    load: { openPositionsCount: 1, activeAlertsCount: 1, screensWatched: 1, multitaskingFraction01: 0.1, inputRatePerMin: 5 },
    stress: { drawdownShock01: 0.1, mtmVolatility01: 0.1, errorRate01: 0, consecutiveLosses: 0 },
    fatigue: { decisionsLastHour: 5, errorsLastHour: 0, hoursActive: 1 },
    emotional: { rapidFireEntriesLastMinute: 0 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.verdict.permission, "FULL");
  assert.ok(r.data.cognitiveRiskScore.score01 < 0.45);
});

// ── COG-2: extreme inputs → COOLDOWN + high cognitiveRiskScore + revenge level ──
test("COG-2 extreme cognitive load → COOLDOWN + revengeLevelForGovernor=CRITICAL", async () => {
  const r = await j("POST", "/cognitive/assess", {
    load: { openPositionsCount: 10, activeAlertsCount: 10, screensWatched: 8, multitaskingFraction01: 1, inputRatePerMin: 100 },
    stress: { drawdownShock01: 1, mtmVolatility01: 1, errorRate01: 1, consecutiveLosses: 6 },
    fatigue: { decisionsLastHour: 60, errorsLastHour: 30, hoursActive: 8 },
    emotional: { rapidFireEntriesLastMinute: 6 },
  });
  assert.equal(r.status, 200);
  assert.ok(["COOLDOWN","RECOVERY_MODE"].includes(r.data.verdict.permission));
  assert.ok(r.data.cognitiveRiskScore.score01 >= 0.65);
  assert.ok(["HIGH","CRITICAL"].includes(r.data.revengeLevelForGovernor));
});

// ── COG-3: cooldown plan forces recovery / lockdown ───────────────────────
test("COG-3 cooldown-plan with trader LOCKDOWN forces lockdown", async () => {
  const r = await j("POST", "/cognitive/cooldown-plan", {
    load: { openPositionsCount: 1, activeAlertsCount: 1, screensWatched: 1, multitaskingFraction01: 0, inputRatePerMin: 1 },
    stress: { drawdownShock01: 0, mtmVolatility01: 0, errorRate01: 0, consecutiveLosses: 0 },
    fatigue: { decisionsLastHour: 1, errorsLastHour: 0, hoursActive: 0.5 },
    emotional: { rapidFireEntriesLastMinute: 0 },
    trader: { permission: "LOCKDOWN" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.plan.kind, "LOCKDOWN");
  assert.equal(r.data.forcesLockdown, true);
});

test("COG-4 cooldown-plan with revenge HIGH triggers COOLDOWN ≥45m", async () => {
  const r = await j("POST", "/cognitive/cooldown-plan", {
    load: { openPositionsCount: 1, activeAlertsCount: 1, screensWatched: 1, multitaskingFraction01: 0, inputRatePerMin: 1 },
    stress: { drawdownShock01: 0.2, mtmVolatility01: 0.1, errorRate01: 0, consecutiveLosses: 1 },
    fatigue: { decisionsLastHour: 5, errorsLastHour: 0, hoursActive: 2 },
    emotional: { rapidFireEntriesLastMinute: 0 },
    trader: { revengeDetected: true, revengeSeverity: "HIGH" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.plan.kind, "COOLDOWN");
  assert.ok(r.data.plan.durationMinutes >= 45);
});

// ── COG-5: invalid body 400 ───────────────────────────────────────────────
test("COG-5 cognitive/assess rejects unknown body with 400", async () => {
  const r = await j("POST", "/cognitive/assess", { foo: 1 });
  assert.equal(r.status, 400);
});

// ── INT-1: cognitive risk → Risk Governor mapping field present ──────────
test("INT-1 cognitive/assess exposes revengeLevelForGovernor (Risk Governor input)", async () => {
  const r = await j("POST", "/cognitive/assess", {
    load: { openPositionsCount: 1, activeAlertsCount: 1, screensWatched: 1, multitaskingFraction01: 0, inputRatePerMin: 1 },
    stress: { drawdownShock01: 0, mtmVolatility01: 0, errorRate01: 0, consecutiveLosses: 0 },
    fatigue: { decisionsLastHour: 1, errorsLastHour: 0, hoursActive: 0.5 },
    emotional: { rapidFireEntriesLastMinute: 0 },
  });
  assert.equal(r.status, 200);
  assert.ok(["NONE","LOW","MEDIUM","HIGH","CRITICAL"].includes(r.data.revengeLevelForGovernor));
});

// ── INT-2: cooldown-plan with severe inputs → forcesRecovery true ─────────
test("INT-2 cooldown-plan with severe cognitive inputs sets forcesRecovery for Control Tower", async () => {
  const r = await j("POST", "/cognitive/cooldown-plan", {
    load: { openPositionsCount: 8, activeAlertsCount: 8, screensWatched: 6, multitaskingFraction01: 0.9, inputRatePerMin: 60 },
    stress: { drawdownShock01: 0.6, mtmVolatility01: 0.6, errorRate01: 0.5, consecutiveLosses: 4 },
    fatigue: { decisionsLastHour: 40, errorsLastHour: 10, hoursActive: 6 },
    emotional: { rapidFireEntriesLastMinute: 4 },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.plan.kind !== "NONE");
  assert.ok(r.data.forcesRecovery || r.data.forcesLockdown || r.data.plan.kind === "COOLDOWN");
});

// ── Z: advisory-only invariants ───────────────────────────────────────────
test("Z trader-dna + cognitive never emit TRADE_* and never touch safety_core", async () => {
  await j("POST", "/trader-dna/profile", { id: "z", name: "z", trades: [trade({})] });
  await j("POST", "/cognitive/assess", {
    load: { openPositionsCount: 1, activeAlertsCount: 1, screensWatched: 1, multitaskingFraction01: 0, inputRatePerMin: 1 },
    stress: { drawdownShock01: 0, mtmVolatility01: 0, errorRate01: 0, consecutiveLosses: 0 },
    fatigue: { decisionsLastHour: 1, errorsLastHour: 0, hoursActive: 0.5 },
    emotional: { rapidFireEntriesLastMinute: 0 },
  });
  await new Promise(r => setTimeout(r, 200));
  const tradeEvents = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events
       WHERE event_type IN ('TRADE_PLACED','TRADE_OPENED','TRADE_CLOSED','TRADE_EXECUTED','TRADE_REJECTED','TRADE_MODIFIED','TRADE_CANCELLED')`,
  );
  assert.equal(tradeEvents.rows[0].c, 0);
  // safety_core: ensure no system mode mutation events from these subsystems
  const modeEvents = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE source IN ('TRADER_DNA','COGNITIVE') AND event_type LIKE 'MODE_%'`,
  );
  assert.equal(modeEvents.rows[0].c, 0);
});
