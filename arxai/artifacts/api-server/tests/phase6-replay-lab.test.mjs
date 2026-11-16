// ═══════════════════════════════════════════════════════════════════════════
// Phase 6 — Replay Lab + What-If Intelligence tests.
//
// Verifies replay pipeline, blocked/missed/override replay, what-if
// counterfactuals, scoring, lesson generation, and vault writes.
// All advisory only; canPlaceTrades:false; never emits TRADE_*/MODE_*.
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

// ── Snapshot factory ─────────────────────────────────────────────────
// A BUY at 100, stop 99, tp 102. Candles drift up to hit TP at 102.
function candlesUp(n = 6, base = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base + i * 0.4;
    const h = o + 0.6;
    const l = o - 0.2;
    const c = o + 0.5;
    out.push({
      ts: `2026-04-10T10:${String(i).padStart(2, "0")}:00.000Z`,
      open: o, high: h, low: l, close: c, volume: 1000,
    });
  }
  return out;
}
function candlesDown(n = 6, base = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base - i * 0.5;
    const h = o + 0.2;
    const l = o - 0.6;
    const c = o - 0.4;
    out.push({
      ts: `2026-04-10T10:${String(i).padStart(2, "0")}:00.000Z`,
      open: o, high: h, low: l, close: c, volume: 1000,
    });
  }
  return out;
}

function snap(over = {}) {
  return {
    snapshotId: "s-" + Math.random().toString(36).slice(2, 10),
    recordedAt: "2026-04-10T10:00:00.000Z",
    market: {
      ts: "2026-04-10T10:00:00.000Z",
      symbol: "Volatility 75 Index",
      regime: "TRENDING", volatilityBand: "NORMAL",
      realizedVolPct: 1.0, spreadPips: 1, newsFlag: false, liquidityScore01: 0.9,
    },
    candles: candlesUp(),
    agentVotes: [
      { agentId: "trend",   vote: "BUY",  confidence01: 0.8, rationale: "trend-up" },
      { agentId: "momentum",vote: "BUY",  confidence01: 0.7, rationale: "momo-up" },
      { agentId: "mean",    vote: "SELL", confidence01: 0.6, rationale: "stretched" },
    ],
    judgeVerdict: { decision: "APPROVE", confidence01: 0.75, blockReasons: [], agreementScore01: 0.66 },
    intent: {
      symbol: "Volatility 75 Index", direction: "BUY",
      entryPrice: 100, stopLoss: 99, takeProfit: 102,
      lotSize: 1, intendedAt: "2026-04-10T10:00:00.000Z",
    },
    execution: {
      slippagePips: 0.2, latencyMs: 100, partialFill: false, brokerReject: false,
      filledLotSize: 1, requestedLotSize: 1,
    },
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

async function vaultTypes() {
  const r = await pool.query(`SELECT event_type FROM audit_events`);
  return r.rows.map(x => x.event_type);
}

// ═══════════════════════════════════════════════════════════════════════════
// T1 — full replay pipeline simulates a winning trade end-to-end
// ═══════════════════════════════════════════════════════════════════════════
test("T1 /replay/scenario simulates a winning trade and vaults REPLAY_EXECUTED", async () => {
  const { status, data } = await j("POST", "/replay/scenario", { snapshot: snap() });
  assert.equal(status, 200);
  assert.equal(data.canPlaceTrades, false);
  assert.equal(data.mode, "REPLAY_LAB");
  assert.equal(data.result.simulatedOutcome.status, "TARGET_HIT");
  assert.ok(data.result.simulatedOutcome.rMultiple >= 1.5);
  assert.ok(data.result.scores.overall01 >= 0.50);
  assert.equal(data.judge.verdictCorrect, true);
  assert.equal(data.judge.approveBacked, true);
  const types = await vaultTypes();
  assert.ok(types.includes("REPLAY_EXECUTED"));
});

// ═══════════════════════════════════════════════════════════════════════════
// T2 — losing trade is detected (stop hit) and lessons surface
// ═══════════════════════════════════════════════════════════════════════════
test("T2 losing trade triggers STOPPED_OUT outcome and lessons", async () => {
  const s = snap({ candles: candlesDown(),
    agentVotes: [
      { agentId: "trend",   vote: "BUY",  confidence01: 0.85, rationale: "" },
      { agentId: "momentum",vote: "BUY",  confidence01: 0.80, rationale: "" },
      { agentId: "mean",    vote: "BUY",  confidence01: 0.78, rationale: "" },
    ],
  });
  const { status, data } = await j("POST", "/replay/scenario", { snapshot: s });
  assert.equal(status, 200);
  assert.equal(data.result.simulatedOutcome.status, "STOPPED_OUT");
  assert.ok(data.result.simulatedOutcome.rMultiple <= -0.9);
  // Overconfident agents on the losing side → AGENT_OVERCONFIDENT lesson
  const kinds = data.lessons.map(l => l.kind);
  assert.ok(kinds.includes("AGENT_OVERCONFIDENT"), "expected AGENT_OVERCONFIDENT lesson");
});

// ═══════════════════════════════════════════════════════════════════════════
// T3 — what-if REDUCED_SIZE compares counterfactual P&L
// ═══════════════════════════════════════════════════════════════════════════
test("T3 /replay/what-if REDUCED_SIZE returns half-PnL counterfactual and vaults", async () => {
  const { status, data } = await j("POST", "/replay/what-if", {
    snapshot: snap(),
    scenarios: [{ kind: "REDUCED_SIZE", sizeFactor: 0.5 }],
  });
  assert.equal(status, 200);
  assert.equal(data.canPlaceTrades, false);
  assert.equal(data.results.length, 1);
  const r = data.results[0];
  // Smaller size → smaller absolute PnL but same R multiple
  assert.ok(Math.abs(r.counterfactualOutcome.pnl) <= Math.abs(r.originalOutcome.pnl) + 0.01);
  assert.ok(Math.abs(r.counterfactualOutcome.rMultiple - r.originalOutcome.rMultiple) < 0.01);
  const types = await vaultTypes();
  assert.ok(types.includes("WHATIF_EVALUATED"));
});

// ═══════════════════════════════════════════════════════════════════════════
// T4 — what-if BLOCKED_INSTEAD avoids the loss on a losing trade
// ═══════════════════════════════════════════════════════════════════════════
test("T4 BLOCKED_INSTEAD on a losing trade is rDelta > 0 (better for trader)", async () => {
  const s = snap({ candles: candlesDown() });
  const { status, data } = await j("POST", "/replay/what-if", {
    snapshot: s, scenarios: [{ kind: "BLOCKED_INSTEAD" }],
  });
  assert.equal(status, 200);
  const r = data.results[0];
  // Original was a loss; blocked = no trade (R=0) → rDelta > 0
  assert.ok(r.originalOutcome.rMultiple < 0);
  assert.equal(r.counterfactualOutcome.status, "NONE");
  assert.ok(r.rDelta > 0);
  assert.equal(r.betterForTrader, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// T5 — what-if DIFFERENT_STOP wider stop avoids stop-out
// ═══════════════════════════════════════════════════════════════════════════
test("T5 DIFFERENT_STOP wider stop changes outcome on a marginal loser", async () => {
  // Down-candles take low to ~99.5–99.4 by candle 5; original stop 99 → not hit?
  // Use a tighter scenario: stop at 99.7 → original loses immediately; widen to 98.5
  const s = snap({ candles: candlesDown(),
    intent: { symbol:"Volatility 75 Index", direction:"BUY",
      entryPrice: 100, stopLoss: 99.7, takeProfit: 102, lotSize: 1,
      intendedAt: "2026-04-10T10:00:00.000Z" } });
  const baseline = await j("POST", "/replay/scenario", { snapshot: s });
  assert.equal(baseline.data.result.simulatedOutcome.status, "STOPPED_OUT");

  const { data } = await j("POST", "/replay/what-if", {
    snapshot: s, scenarios: [{ kind: "DIFFERENT_STOP", stopPrice: 95.0 }],
  });
  const r = data.results[0];
  // With wider stop (well below candle lows), the trade is no longer stopped out
  assert.notEqual(r.counterfactualOutcome.status, "STOPPED_OUT");
});

// ═══════════════════════════════════════════════════════════════════════════
// T6 — blocked replay shows the block missed a winning setup
// ═══════════════════════════════════════════════════════════════════════════
test("T6 /replay/blocked on a setup that would have won marks blockMissedWin", async () => {
  const s = snap({ decisionKind: "BLOCKED",
    judgeVerdict: { decision: "BLOCK", confidence01: 0.6,
      blockReasons: ["volatility too high"], agreementScore01: 0.5 } });
  const { status, data } = await j("POST", "/replay/blocked", { snapshot: s });
  assert.equal(status, 200);
  assert.equal(data.canPlaceTrades, false);
  assert.equal(data.blockMissedWin, true);
  assert.equal(data.blockWasCorrect, false);
  assert.equal(data.hypotheticalOutcome.status, "TARGET_HIT");
  const types = await vaultTypes();
  assert.ok(types.includes("BLOCKED_TRADE_REPLAYED"));
});

// ═══════════════════════════════════════════════════════════════════════════
// T7 — missed setup replay quantifies the missed R
// ═══════════════════════════════════════════════════════════════════════════
test("T7 /replay/missed quantifies missed R-multiple", async () => {
  const s = snap({ decisionKind: "MISSED" });
  const { status, data } = await j("POST", "/replay/missed", { snapshot: s });
  assert.equal(status, 200);
  assert.equal(data.setupWorked, true);
  assert.ok(data.missedRMultiple >= 1.5);
  const types = await vaultTypes();
  assert.ok(types.includes("MISSED_TRADE_REPLAYED"));
});

// ═══════════════════════════════════════════════════════════════════════════
// T8 — override replay flags a hurtful override
// ═══════════════════════════════════════════════════════════════════════════
test("T8 /replay/override flags OVERRIDE_HURT when user took a losing block", async () => {
  // System BLOCK, user took it, trade lost
  const s = snap({ candles: candlesDown(), decisionKind: "OVERRIDE",
    judgeVerdict: { decision: "BLOCK", confidence01: 0.7,
      blockReasons: ["volatility too high"], agreementScore01: 0.6 } });
  const { status, data } = await j("POST", "/replay/override", { snapshot: s });
  assert.equal(status, 200);
  assert.equal(data.systemDecision, "BLOCK");
  assert.equal(data.userTookTrade, true);
  assert.ok(data.takenOutcome.rMultiple < 0);
  assert.equal(data.systemPathOutcome.status, "NONE");
  assert.equal(data.overrideHurt, true);
  assert.equal(data.overrideHelped, false);
  const types = await vaultTypes();
  assert.ok(types.includes("OVERRIDE_REPLAYED"));
});

// ═══════════════════════════════════════════════════════════════════════════
// T9 — lessons endpoint vaults REPLAY_LESSON_GENERATED per lesson
// ═══════════════════════════════════════════════════════════════════════════
test("T9 /replay/lessons vaults REPLAY_LESSON_GENERATED for each lesson", async () => {
  const s = snap({ candles: candlesDown(),
    agentVotes: [
      { agentId: "trend",   vote: "BUY", confidence01: 0.9, rationale: "" },
      { agentId: "momentum",vote: "BUY", confidence01: 0.85, rationale: "" },
      { agentId: "mean",    vote: "BUY", confidence01: 0.80, rationale: "" },
    ],
    execution: { slippagePips: 8, latencyMs: 3000, partialFill: true,
                 brokerReject: false, filledLotSize: 0.5, requestedLotSize: 1 },
  });
  const { status, data } = await j("POST", "/replay/lessons", { snapshot: s });
  assert.equal(status, 200);
  assert.equal(data.canPlaceTrades, false);
  assert.ok(data.lessonCount >= 2, `expected ≥2 lessons, got ${data.lessonCount}`);
  assert.equal(data.affects.calibration, true);
  assert.equal(data.affects.validationPipeline, true);
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_events WHERE event_type='REPLAY_LESSON_GENERATED'`);
  assert.equal(r.rows[0].n, data.lessonCount);
});

// ═══════════════════════════════════════════════════════════════════════════
// T10 — global state inconsistency: trade under HALT is flagged
// ═══════════════════════════════════════════════════════════════════════════
test("T10 trade taken under HALT mode produces a global-state inconsistency note", async () => {
  const s = snap({ controlTowerMode: "HALT" });
  const { data } = await j("POST", "/replay/scenario", { snapshot: s });
  assert.equal(data.global.consistent, false);
  assert.ok(data.global.inconsistencies.some(x => /HALT/.test(x)));
});

// ═══════════════════════════════════════════════════════════════════════════
// T11 — invariants: every endpoint returns canPlaceTrades:false and never
//                   emits TRADE_*/MODE_*/SIGNAL_* events
// ═══════════════════════════════════════════════════════════════════════════
test("TZ invariants: canPlaceTrades:false and no TRADE_*/MODE_* leakage", async () => {
  const s = snap();
  const calls = [
    j("POST", "/replay/scenario", { snapshot: s }),
    j("POST", "/replay/what-if",  { snapshot: s, scenarios: [{ kind: "BLOCKED_INSTEAD" }] }),
    j("POST", "/replay/blocked",  { snapshot: { ...s, decisionKind: "BLOCKED" } }),
    j("POST", "/replay/missed",   { snapshot: { ...s, decisionKind: "MISSED" } }),
    j("POST", "/replay/override", { snapshot: { ...s, decisionKind: "OVERRIDE" } }),
    j("POST", "/replay/lessons",  { snapshot: s }),
  ];
  for (const p of calls) {
    const { status, data } = await p;
    assert.equal(status, 200);
    assert.equal(data.canPlaceTrades, false);
    assert.equal(data.mode, "REPLAY_LAB");
  }
  const r = await pool.query(
    `SELECT event_type FROM audit_events
       WHERE event_type LIKE 'TRADE\\_%' ESCAPE '\\'
          OR event_type LIKE 'MODE\\_%'  ESCAPE '\\'
          OR event_type LIKE 'SIGNAL\\_%' ESCAPE '\\'`);
  assert.equal(r.rows.length, 0, "Replay Lab must never emit TRADE_*/MODE_*/SIGNAL_* events");
});

// ═══════════════════════════════════════════════════════════════════════════
// T12 — bad input returns 400 with neutral error
// ═══════════════════════════════════════════════════════════════════════════
test("T12 invalid snapshot returns 400", async () => {
  const { status } = await j("POST", "/replay/scenario", { snapshot: { foo: "bar" } });
  assert.equal(status, 400);
});
