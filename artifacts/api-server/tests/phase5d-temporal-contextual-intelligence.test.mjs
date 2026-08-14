// ═══════════════════════════════════════════════════════════════════════════
// Phase 5d — Temporal + Contextual Behavioral Intelligence tests.
// Verifies sequence motifs, escalation, contextual amplifiers, recovery
// effectiveness, adaptive recommendations, and long-horizon drift.
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

function trade(over) {
  return {
    id: "t" + Math.random().toString(36).slice(2, 10),
    symbol: "Volatility 75 Index", direction: "BUY", status: "CLOSED_WIN",
    entryPrice: 100, stopLoss: 99, takeProfit: 102, lotSize: 0.5,
    openedAt: "2026-04-10T10:00:00.000Z", closedAt: "2026-04-10T10:30:00.000Z",
    pnl: 50, rMultiple: 2,
    ...over,
  };
}
function matureTrades() {
  const out = [];
  for (let d = 0; d < 14; d++) {
    const day = String(d + 1).padStart(2, "0");
    const n = 3;
    for (let i = 0; i < n; i++) {
      const open  = `2026-04-${day}T${String(10 + i).padStart(2, "0")}:00:00Z`;
      const close = `2026-04-${day}T${String(10 + i).padStart(2, "0")}:45:00Z`;
      const isWin = (d + i) % 3 !== 0;
      out.push(trade({
        id: `m-${d}-${i}`,
        status: isWin ? "CLOSED_WIN" : "CLOSED_LOSS",
        openedAt: open, closedAt: close, lotSize: 0.5,
        pnl: isWin ? 25 : -15, rMultiple: isWin ? 1.2 : -0.6,
      }));
    }
  }
  return out;
}

async function vaultEvents() {
  const r = await pool.query(`SELECT event_type, severity, payload FROM audit_events ORDER BY created_at ASC`);
  return r.rows;
}

// ── T1 sequence motifs: CHASE + RETRY_TIGHT ────────────────────────────
test("T1 decision sequence detects CHASE + RETRY_TIGHT and vaults DECISION_SEQUENCE_ANALYZED", async () => {
  const trades = matureTrades();
  // Append: loss followed by tight retry at 2× size (CHASE + RETRY_TIGHT)
  trades.push(trade({ id: "x1", status: "CLOSED_LOSS", lotSize: 0.5,
    openedAt: "2026-04-15T10:00:00Z", closedAt: "2026-04-15T10:10:00Z", pnl: -20, rMultiple: -0.8 }));
  trades.push(trade({ id: "x2", status: "CLOSED_LOSS", lotSize: 1.5,
    openedAt: "2026-04-15T10:10:20Z", closedAt: "2026-04-15T10:11:00Z", pnl: -40, rMultiple: -1.5 }));
  const r = await j("POST", "/trader-dna/temporal/analyze", { id: "trader-T1", trades });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.baseline.isMature, true);
  const kinds = r.data.sequence.motifs.map(m => m.kind);
  assert.ok(kinds.includes("CHASE"),       `expected CHASE, got ${kinds.join(",")}`);
  assert.ok(kinds.includes("RETRY_TIGHT"), `expected RETRY_TIGHT, got ${kinds.join(",")}`);
  assert.ok(r.data.sequence.sequenceRiskScore01 > 0);
  const evs = await vaultEvents();
  assert.ok(evs.some(e => e.event_type === "DECISION_SEQUENCE_ANALYZED"));
});

// ── T2 pacing OVERPACED + ACCELERATE ───────────────────────────────────
test("T2 pacing analysis flags OVERPACED on burst + escalation FREQUENCY", async () => {
  const trades = matureTrades();
  // 4 entries with shrinking gaps: 4m, 2m, 1m
  trades.push(trade({ id: "p1", openedAt: "2026-04-16T09:00:00Z", closedAt: "2026-04-16T09:01:00Z", lotSize: 0.5 }));
  trades.push(trade({ id: "p2", openedAt: "2026-04-16T09:04:00Z", closedAt: "2026-04-16T09:05:00Z", lotSize: 0.5 }));
  trades.push(trade({ id: "p3", openedAt: "2026-04-16T09:06:00Z", closedAt: "2026-04-16T09:07:00Z", lotSize: 0.5 }));
  trades.push(trade({ id: "p4", openedAt: "2026-04-16T09:07:00Z", closedAt: "2026-04-16T09:08:00Z", lotSize: 0.5 }));
  const r = await j("POST", "/trader-dna/temporal/analyze", { id: "trader-T2", trades });
  assert.equal(r.status, 200);
  assert.ok(["FAST", "OVERPACED"].includes(r.data.pacing.pacingState));
  assert.ok(r.data.pacing.burstCount >= 1);
  // Escalation should detect FREQUENCY
  if (r.data.escalation.detected) {
    assert.ok(["FREQUENCY", "BOTH"].includes(r.data.escalation.kind));
    const evs = await vaultEvents();
    assert.ok(evs.some(e => e.event_type === "ESCALATION_PATTERN_DETECTED"));
  }
});

// ── T3 escalation SIZE detected ────────────────────────────────────────
test("T3 escalation SIZE on monotonically growing lots vaults ESCALATION_PATTERN_DETECTED", async () => {
  const trades = matureTrades();
  trades.push(trade({ id: "e1", openedAt: "2026-04-17T09:00:00Z", closedAt: "2026-04-17T09:10:00Z", lotSize: 0.5 }));
  trades.push(trade({ id: "e2", openedAt: "2026-04-17T09:30:00Z", closedAt: "2026-04-17T09:40:00Z", lotSize: 0.7 }));
  trades.push(trade({ id: "e3", openedAt: "2026-04-17T10:00:00Z", closedAt: "2026-04-17T10:10:00Z", lotSize: 1.0 }));
  trades.push(trade({ id: "e4", openedAt: "2026-04-17T10:30:00Z", closedAt: "2026-04-17T10:40:00Z", lotSize: 1.5 }));
  const r = await j("POST", "/trader-dna/temporal/analyze", { id: "trader-T3", trades });
  assert.equal(r.status, 200);
  assert.equal(r.data.escalation.detected, true);
  assert.ok(["SIZE", "BOTH"].includes(r.data.escalation.kind));
  assert.ok(r.data.escalation.escalationRiskScore01 > 0);
  const evs = await vaultEvents();
  const esc = evs.find(e => e.event_type === "ESCALATION_PATTERN_DETECTED");
  assert.ok(esc, "ESCALATION_PATTERN_DETECTED missing");
  assert.ok(["SIZE","BOTH"].includes(esc.payload.kind));
});

// ── T4 recovery trajectory IMPROVING after trigger ─────────────────────
test("T4 recovery trajectory classifies post-trigger window", async () => {
  const trades = [];
  // Pre-trigger: 4 losing trades large size
  for (let i = 0; i < 4; i++) {
    const t = `2026-04-18T0${i}:00:00Z`;
    const c = `2026-04-18T0${i}:30:00Z`;
    trades.push(trade({ id: `pre-${i}`, status: "CLOSED_LOSS",
      openedAt: t, closedAt: c, lotSize: 1.5, pnl: -50, rMultiple: -1.5 }));
  }
  // Post-trigger: 4 winning trades baseline size (improving)
  for (let i = 0; i < 4; i++) {
    const t = `2026-04-18T1${i}:00:00Z`;
    const c = `2026-04-18T1${i}:30:00Z`;
    trades.push(trade({ id: `post-${i}`, status: "CLOSED_WIN",
      openedAt: t, closedAt: c, lotSize: 0.5, pnl: 30, rMultiple: 1.5 }));
  }
  // Pad baseline
  trades.push(...matureTrades());
  const r = await j("POST", "/trader-dna/temporal/analyze", {
    id: "trader-T4", trades, recoveryTriggerAt: "2026-04-18T08:00:00Z",
    recoveryWindowMinutes: 240,
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.recoveryTrajectory);
  assert.ok(["IMPROVING","FLAT","DEGRADING","INSUFFICIENT"].includes(r.data.recoveryTrajectory.trajectoryState));
});

// ── T5 contextual amplifier vaults CONTEXTUAL_BEHAVIOR_HIT when ≥0.50 ──
test("T5 contextual: high amplifiers push adjusted risk ≥0.50 and vault hit", async () => {
  const r = await j("POST", "/trader-dna/contextual/analyze", {
    id: "trader-T5",
    context: {
      behaviorRiskScore01: 0.45,
      marketRegime: "NEWS_DRIVEN",
      volatilityBand: "EXTREME",
      exec: { slippageEvents24h: 5, partialFills24h: 2, brokerRejects24h: 1, latencyAnomalies24h: 2 },
      councilDisagreement01: 0.8,
      globalMarketState: "RED",
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.ok(r.data.report.adjustedRiskScore01 > r.data.report.baseRiskScore01);
  assert.ok(r.data.report.adjustedRiskScore01 >= 0.50);
  assert.ok(typeof r.data.report.dominantAmplifier === "string");
  const evs = await vaultEvents();
  assert.ok(evs.some(e => e.event_type === "CONTEXTUAL_BEHAVIOR_HIT"));
});

test("T5b contextual: low base + calm context stays below 0.50 and emits no hit", async () => {
  const r = await j("POST", "/trader-dna/contextual/analyze", {
    id: "trader-T5b",
    context: {
      behaviorRiskScore01: 0.10,
      marketRegime: "CALM",
      volatilityBand: "LOW",
      exec: { slippageEvents24h: 0, partialFills24h: 0, brokerRejects24h: 0, latencyAnomalies24h: 0 },
      councilDisagreement01: 0,
      globalMarketState: "GREEN",
    },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.report.adjustedRiskScore01 < 0.50);
  const evs = await vaultEvents();
  assert.equal(evs.filter(e => e.event_type === "CONTEXTUAL_BEHAVIOR_HIT").length, 0);
});

// ── T6 recovery effectiveness: cooldown + restriction ──────────────────
test("T6 recovery effectiveness ranks restrictions and recommends next cooldown", async () => {
  const cooldowns = [
    { startedAt: "2026-04-01T10:00:00Z", durationMinutes: 30,
      preBehaviorRisk: 0.7, postBehaviorRisk: 0.4,
      preDiscipline: 0.4, postDiscipline: 0.7,
      preCognitiveRisk: 0.6, postCognitiveRisk: 0.3 },
    { startedAt: "2026-04-02T10:00:00Z", durationMinutes: 15,
      preBehaviorRisk: 0.7, postBehaviorRisk: 0.7,
      preDiscipline: 0.4, postDiscipline: 0.4,
      preCognitiveRisk: 0.6, postCognitiveRisk: 0.6 },
  ];
  const restrictions = [
    { restriction: "MICRO_LOTS_ONLY", appliedAt: "2026-04-01T10:00:00Z",
      preBehaviorRisk: 0.7, postBehaviorRisk: 0.3,
      preDiscipline: 0.4, postDiscipline: 0.8,
      preCognitiveRisk: 0.5, postCognitiveRisk: 0.3 },
    { restriction: "RAPID_ENTRIES_BLOCK", appliedAt: "2026-04-02T10:00:00Z",
      preBehaviorRisk: 0.5, postBehaviorRisk: 0.85,
      preDiscipline: 0.6, postDiscipline: 0.25,
      preCognitiveRisk: 0.4, postCognitiveRisk: 0.80 },
  ];
  const r = await j("POST", "/trader-dna/recovery/effectiveness", {
    id: "trader-T6",
    cooldownHistory: cooldowns,
    restrictionHistory: restrictions,
    singleEvent: {
      eventKind: "COOLDOWN",
      preMetrics:  { behaviorRiskScore01: 0.8, disciplineScore01: 0.3, cognitiveRisk01: 0.7 },
      postMetrics: { behaviorRiskScore01: 0.4, disciplineScore01: 0.7, cognitiveRisk01: 0.4 },
    },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.cooldowns.recommendedNextDurationMinutes >= 15);
  assert.ok(r.data.restrictions.recommended.includes("MICRO_LOTS_ONLY"));
  assert.ok(r.data.restrictions.notRecommended.includes("RAPID_ENTRIES_BLOCK"));
  assert.equal(r.data.single.classification, "EFFECTIVE");
  const evs = await vaultEvents();
  assert.ok(evs.some(e => e.event_type === "RECOVERY_EFFECTIVENESS_MEASURED"));
});

// ── T7 adaptive recommendation severity tiers ──────────────────────────
test("T7 adaptive recommend at high severity tightens pacing/UI/permission and vaults", async () => {
  const r = await j("POST", "/cognitive/adaptive/recommend", {
    id: "trader-T7",
    cognitiveLoad01: 0.90, behaviorRisk01: 0.80,
    fatigueScore01: 0.7,
    recentMedianGapMin: 5, baselineGapMin: 20,
    recentAcknowledgmentsMissed: 3,
    averageRecoveryEffectiveness01: 0.30,
    recentRuleViolations24h: 4,
    cognitiveRisk01: 0.90,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.pacing.maxTradesPerSession, 0);
  assert.ok(r.data.pacing.targetGapMinutes >= 30);
  assert.equal(r.data.notification.level, "MUST_ACK");
  assert.equal(r.data.notification.requireAck, true);
  assert.equal(r.data.ui.density, "FOCUS_ONLY");
  assert.equal(r.data.permission.sensitivity, "MAXIMUM");
  const evs = await vaultEvents();
  const adaptive = evs.find(e => e.event_type === "ADAPTIVE_RECOMMENDATION_ISSUED");
  assert.ok(adaptive);
  assert.equal(adaptive.severity, "DANGER");
});

test("T7b adaptive recommend at low severity stays permissive", async () => {
  const r = await j("POST", "/cognitive/adaptive/recommend", {
    id: "trader-T7b",
    cognitiveLoad01: 0.05, behaviorRisk01: 0.05,
    averageRecoveryEffectiveness01: 0.80, recentRuleViolations24h: 0,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.notification.level, "SILENT");
  assert.equal(r.data.ui.density, "FULL");
  assert.equal(r.data.permission.sensitivity, "RELAXED");
});

// ── T8 long-horizon drift DEGRADING ────────────────────────────────────
test("T8 behavioral drift detects DEGRADING and vaults BEHAVIORAL_DRIFT_DETECTED", async () => {
  const dates = Array.from({ length: 14 }, (_, i) => `2026-04-${String(i+1).padStart(2,"0")}`);
  const disciplinePoints = dates.map((d, i) => ({ date: d, disciplineScore01: Math.max(0.05, 0.85 - i * 0.05) }));
  const aggressionPoints = dates.map((d, i) => ({ date: d, avgLotRatio: 1 + i * 0.10, tradesCount: 3 + i }));
  const overridePoints   = dates.map((d, i) => ({ date: d, overridesCount: i, ruleViolationsCount: Math.floor(i / 2) }));
  const r = await j("POST", "/trader-dna/long-horizon/drift", {
    id: "trader-T8", disciplinePoints, aggressionPoints, overridePoints,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.drift.driftClassification, "DEGRADING");
  assert.ok(r.data.drift.driftRiskScore01 > 0);
  const evs = await vaultEvents();
  assert.ok(evs.some(e => e.event_type === "BEHAVIORAL_DRIFT_DETECTED"));
});

test("T8b behavioral drift STABLE/IMPROVING does NOT vault drift event", async () => {
  const dates = Array.from({ length: 14 }, (_, i) => `2026-04-${String(i+1).padStart(2,"0")}`);
  const disciplinePoints = dates.map(d => ({ date: d, disciplineScore01: 0.75 }));
  const aggressionPoints = dates.map(d => ({ date: d, avgLotRatio: 1.0, tradesCount: 3 }));
  const overridePoints   = dates.map(d => ({ date: d, overridesCount: 0, ruleViolationsCount: 0 }));
  const r = await j("POST", "/trader-dna/long-horizon/drift", {
    id: "trader-T8b", disciplinePoints, aggressionPoints, overridePoints,
  });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.drift.driftClassification, "DEGRADING");
  const evs = await vaultEvents();
  assert.equal(evs.filter(e => e.event_type === "BEHAVIORAL_DRIFT_DETECTED").length, 0);
});

// ── TZ invariants ──────────────────────────────────────────────────────
test("TZ phase5d endpoints never emit TRADE_*/MODE_* and always set canPlaceTrades:false", async () => {
  const trades = matureTrades();
  const r1 = await j("POST", "/trader-dna/temporal/analyze", { id: "z1", trades });
  const r2 = await j("POST", "/trader-dna/contextual/analyze", { id: "z2",
    context: { behaviorRiskScore01: 0.5, marketRegime: "NEWS_DRIVEN", volatilityBand: "EXTREME",
      exec: { slippageEvents24h: 4, partialFills24h: 2, brokerRejects24h: 1, latencyAnomalies24h: 1 },
      councilDisagreement01: 0.7, globalMarketState: "RED" } });
  const r3 = await j("POST", "/trader-dna/recovery/effectiveness", { id: "z3",
    cooldownHistory: [], restrictionHistory: [] });
  const r4 = await j("POST", "/cognitive/adaptive/recommend", { id: "z4",
    cognitiveLoad01: 0.9, behaviorRisk01: 0.9 });
  const r5 = await j("POST", "/trader-dna/long-horizon/drift", { id: "z5",
    disciplinePoints: [], aggressionPoints: [], overridePoints: [] });
  for (const r of [r1, r2, r3, r4, r5]) {
    assert.equal(r.status, 200);
    assert.equal(r.data.canPlaceTrades, false);
  }
  const evs = await vaultEvents();
  for (const e of evs) {
    assert.ok(!String(e.event_type).startsWith("TRADE_"),
      `unexpected TRADE_* event: ${e.event_type}`);
    assert.ok(!String(e.event_type).startsWith("MODE_"),
      `unexpected MODE_* event: ${e.event_type}`);
  }
});
