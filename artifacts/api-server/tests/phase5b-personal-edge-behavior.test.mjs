// ═══════════════════════════════════════════════════════════════════════════
// Phase 5b — Personal Edge + Behavior Risk Intelligence System tests.
//
// Verifies:
//   • Baseline maturity gate (sample ≥ 30 + days ≥ 10)
//   • PersonalEdge / PersonalDanger fingerprint signatures
//   • PostLoss + Override forensics + Drawdown + DisciplineScore
//   • BehaviorEvidence composer + neutral language + immaturity cap
//   • TraderState classifier with baseline-immature softening
//   • CognitiveRiskEvidence + adjustable CooldownPolicy + PermissionThrottle
//   • CognitiveRecoveryScore trend + canRestorePermissions
//   • Vault events written; no TRADE_* / MODE_* events; canPlaceTrades:false
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

// Build a mature trade history: 40 trades spread across 14 distinct days.
function matureTrades() {
  const out = [];
  for (let d = 0; d < 14; d++) {
    const day = String(d + 1).padStart(2, "0");
    const n = d < 12 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const open = `2026-04-${day}T${String(10 + i).padStart(2, "0")}:00:00Z`;
      const close = `2026-04-${day}T${String(10 + i).padStart(2, "0")}:45:00Z`;
      const isWin = (d + i) % 3 !== 0;
      out.push(trade({
        id: `m${d}-${i}`,
        status: isWin ? "CLOSED_WIN" : "CLOSED_LOSS",
        pnl: isWin ? 80 : -40, rMultiple: isWin ? 2 : -1,
        openedAt: open, closedAt: close, lotSize: 0.5,
      }));
    }
  }
  return out;  // 40 trades, 14 days
}

const cogSnapStable = {
  load: { openPositionsCount: 1, activeAlertsCount: 1, screensWatched: 1, multitaskingFraction01: 0.1, inputRatePerMin: 5 },
  stress: { drawdownShock01: 0, mtmVolatility01: 0, errorRate01: 0, consecutiveLosses: 0 },
  fatigue: { decisionsLastHour: 5, errorsLastHour: 0, hoursActive: 1 },
  emotional: { rapidFireEntriesLastMinute: 0 },
};
const cogSnapSevere = {
  load: { openPositionsCount: 8, activeAlertsCount: 8, screensWatched: 6, multitaskingFraction01: 0.9, inputRatePerMin: 70 },
  stress: { drawdownShock01: 0.7, mtmVolatility01: 0.8, errorRate01: 0.6, consecutiveLosses: 5 },
  fatigue: { decisionsLastHour: 70, errorsLastHour: 12, hoursActive: 8 },
  emotional: { rapidFireEntriesLastMinute: 7 },
};

// ──────────────────────────────────────────────────────────────────────────
// PB-1: baseline maturity gate
// ──────────────────────────────────────────────────────────────────────────
test("PB-1 baseline is immature on small history; mature on ≥30 trades / ≥10 days", async () => {
  const small = await j("POST", "/trader-dna/baseline", { id: "u1", trades: [trade({})] });
  assert.equal(small.status, 200);
  assert.equal(small.data.canPlaceTrades, false);
  assert.equal(small.data.baseline.isMature, false);
  assert.ok(small.data.baseline.maturityReasons.length >= 1);

  const big = await j("POST", "/trader-dna/baseline", { id: "u2", trades: matureTrades() });
  assert.equal(big.status, 200);
  assert.equal(big.data.baseline.isMature, true);
  assert.ok(big.data.baseline.sample >= 30);
  assert.ok(big.data.baseline.activeDays >= 10);
  assert.ok(big.data.baseline.lotSize.median > 0);
});

test("PB-1b baseline endpoint vaults BASELINE_BUILT or BASELINE_IMMATURE", async () => {
  await j("POST", "/trader-dna/baseline", { id: "u3", trades: matureTrades() });
  await new Promise(r => setTimeout(r, 150));
  const r = await pool.query(
    `SELECT event_type FROM audit_events WHERE event_type IN ('BASELINE_BUILT','BASELINE_IMMATURE')`,
  );
  assert.ok(r.rows.length >= 1);
});

// ──────────────────────────────────────────────────────────────────────────
// EF-1: edge fingerprint signatures
// ──────────────────────────────────────────────────────────────────────────
test("EF-1 edge-fingerprint returns PersonalEdge + PersonalDanger fingerprints with signatures", async () => {
  const ctx = [];
  for (let i = 0; i < 6; i++) ctx.push({
    ...trade({ id: "g"+i, pnl: 100, rMultiple: 2, status: "CLOSED_WIN", lotSize: 0.5 }),
    strategyId: "S_GOOD",
  });
  for (let i = 0; i < 6; i++) ctx.push({
    ...trade({ id: "b"+i, pnl: -100, rMultiple: -1, status: "CLOSED_LOSS",
      openedAt: "2026-04-12T15:00:00Z", closedAt: "2026-04-12T16:00:00Z", lotSize: 0.5 }),
    strategyId: "S_BAD",
  });
  const r = await j("POST", "/trader-dna/edge-fingerprint", {
    id: "u4", trades: ctx.map(({ strategyId: _s, ...t }) => t), contextTrades: ctx,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.ok(r.data.personalEdgeFingerprint.signature.startsWith("EDGE["));
  assert.ok(r.data.personalDangerFingerprint.signature.startsWith("DANGER["));
  assert.ok(Array.isArray(r.data.personalEdgeFingerprint.symbols));
  assert.ok(Array.isArray(r.data.bestConditions.narrative));
  await new Promise(r => setTimeout(r, 100));
  const v = await pool.query(`SELECT 1 FROM audit_events WHERE event_type = 'EDGE_FINGERPRINT_BUILT'`);
  assert.ok(v.rows.length >= 1);
});

// ──────────────────────────────────────────────────────────────────────────
// BE-1: behavior-evidence composes everything; immature baseline caps score
// ──────────────────────────────────────────────────────────────────────────
test("BE-1 behavior-evidence on small history caps score ≤ 0.50 (baseline immaturity)", async () => {
  const r = await j("POST", "/trader-dna/behavior-evidence", {
    id: "u5",
    trades: [
      trade({ id: "x1", status: "CLOSED_LOSS", pnl: -50, rMultiple: -1 }),
      trade({ id: "x2", status: "CLOSED_WIN",  pnl:  80, rMultiple:  2 }),
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.ok(r.data.behaviorEvidenceScore <= 0.50);
  assert.equal(r.data.baseline.isMature, false);
  // softened classification — never CRITICAL when baseline immature unless explicit CRITICAL evidence
  assert.notEqual(r.data.traderState.state, "CRITICAL");
  // BASELINE_IMMATURE evidence item must be present
  const kinds = r.data.behaviorEvidence.items.map(i => i.kind);
  assert.ok(kinds.includes("BASELINE_IMMATURE"));
});

test("BE-2 behavior-evidence on mature history with overrides+post-loss surfaces evidence + discipline + state", async () => {
  // Trades + a loss followed by oversized re-entries
  const trades = matureTrades();
  // append a loss + 3 oversized entries within 60m
  trades.push(trade({
    id: "L1", status: "CLOSED_LOSS", pnl: -60, rMultiple: -1.5, lotSize: 0.5,
    openedAt: "2026-04-15T10:00:00Z", closedAt: "2026-04-15T10:30:00Z",
  }));
  for (let i = 0; i < 3; i++) {
    trades.push(trade({
      id: "F"+i, status: "CLOSED_LOSS", pnl: -100, rMultiple: -1.2, lotSize: 1.2,
      openedAt: `2026-04-15T${String(10).padStart(2,"0")}:${String(35+i*5).padStart(2,"0")}:00Z`,
      closedAt:  `2026-04-15T${String(11).padStart(2,"0")}:${String(0 +i*5).padStart(2,"0")}:00Z`,
    }));
  }
  const overrides = [
    { id: "ov1", occurredAt: "2026-04-15T10:35:00Z", kind: "RISK_CAP_OVERRIDE", ruleViolated: true,
      resultTradeId: "F0", resultPnl: -100, resultLotSize: 1.2 },
    { id: "ov2", occurredAt: "2026-04-15T10:40:00Z", kind: "SIZE_OVERRIDE", ruleViolated: false,
      resultTradeId: "F1", resultPnl: -100, resultLotSize: 1.2 },
  ];
  const r = await j("POST", "/trader-dna/behavior-evidence", {
    id: "u6", trades, overrides, ruleViolationsLast24h: 2,
    currentTradesPerDay: 8, currentAvgLot: 1.0,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.baseline.isMature, true);
  // evidence must include override + post-loss / revenge style item
  const kinds = r.data.behaviorEvidence.items.map(i => i.kind);
  assert.ok(kinds.includes("OVERRIDE_RULE_VIOLATION"), `kinds=${kinds.join(",")}`);
  assert.ok(r.data.postLossRiskScore > 0);
  assert.ok(r.data.overrideQualityScore <= 0.5);
  assert.ok(["EXEMPLARY","STRONG","ADEQUATE","WEAK","CRITICAL"].includes(r.data.disciplineScore.level));
  assert.ok(["STABLE","CAUTION","ELEVATED_RISK","HIGH_RISK","CRITICAL"].includes(r.data.traderState.state));
  assert.notEqual(r.data.traderState.state, "STABLE");
  // Permission throttle never increases beyond FULL
  assert.ok(["FULL","REDUCED","CONFIRM_REQUIRED","MICRO","PAPER_ONLY","COOLDOWN"].includes(r.data.permissionThrottleLevel));
  // Control Tower consumes the new throttle enum
  assert.equal(r.data.recommendedPermissionLevel, r.data.permissionThrottleLevel);
  assert.ok(["FULL","REDUCED","MICRO","COOLDOWN","LOCKDOWN"].includes(r.data.riskGovernorPermission));
  // Neutral language: no shaming verbs
  for (const item of r.data.behaviorEvidence.items) {
    assert.equal(typeof item.neutralLanguage, "string");
    assert.ok(!/you (are|were) (emotional|reckless|stupid|panicking|tilted)/i.test(item.neutralLanguage));
  }
});

test("BE-3 vault events written for behavior-evidence flow", async () => {
  await j("POST", "/trader-dna/behavior-evidence", { id: "u7", trades: matureTrades() });
  await new Promise(r => setTimeout(r, 200));
  const v = await pool.query(
    `SELECT event_type FROM audit_events
       WHERE event_type IN ('BEHAVIOR_EVIDENCE_LOGGED','TRADER_STATE_CLASSIFIED','DISCIPLINE_SCORED','PERMISSION_THROTTLE_APPLIED')`,
  );
  const seen = new Set(v.rows.map(r => r.event_type));
  assert.ok(seen.has("BEHAVIOR_EVIDENCE_LOGGED"));
  assert.ok(seen.has("TRADER_STATE_CLASSIFIED"));
  assert.ok(seen.has("DISCIPLINE_SCORED"));
  assert.ok(seen.has("PERMISSION_THROTTLE_APPLIED"));
});

test("BE-4 every behavior evidence item is vaulted individually", async () => {
  const trades = matureTrades();
  const r = await j("POST", "/trader-dna/behavior-evidence", { id: "u8", trades });
  await new Promise(r => setTimeout(r, 250));
  const items = r.data.behaviorEvidence.items.length;
  const v = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events WHERE event_type='BEHAVIOR_EVIDENCE_ITEM'`,
  );
  assert.equal(v.rows[0].c, items);
});

// ──────────────────────────────────────────────────────────────────────────
// CR-1: cognitive risk evidence
// ──────────────────────────────────────────────────────────────────────────
test("CR-1 cognitive/risk-evidence on stable snapshot returns NONE/LOW; on severe returns ≥ HIGH", async () => {
  const stable = await j("POST", "/cognitive/risk-evidence", cogSnapStable);
  assert.equal(stable.status, 200);
  assert.equal(stable.data.canPlaceTrades, false);
  assert.ok(stable.data.behavioralRiskEvidenceScore <= 0.5);

  const severe = await j("POST", "/cognitive/risk-evidence", cogSnapSevere);
  assert.equal(severe.status, 200);
  assert.ok(severe.data.behavioralRiskEvidenceScore >= 0.5,
    `score=${severe.data.behavioralRiskEvidenceScore}`);
  assert.ok(["HIGH","CRITICAL"].includes(severe.data.evidence.worstSeverity),
    `worstSeverity=${severe.data.evidence.worstSeverity}`);
  await new Promise(r => setTimeout(r, 100));
  const v = await pool.query(`SELECT 1 FROM audit_events WHERE event_type='BEHAVIORAL_RISK_EVIDENCE_LOGGED'`);
  assert.ok(v.rows.length >= 1);
});

// ──────────────────────────────────────────────────────────────────────────
// PT-1: permission throttle is multi-axis worst-takes-all
// ──────────────────────────────────────────────────────────────────────────
test("PT-1 permission-throttle escalates with worst single axis", async () => {
  const lo = await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.1, behaviorEvidenceScore01: 0.1, disciplineScore01: 0.9,
    cognitiveRiskScore01: 0.1, baselineMature: true,
    cognitiveRiskSeries: [0.1], minutesSinceLastCooldown: 120, ruleAdherenceLast24h: 1,
  });
  assert.equal(lo.status, 200);
  assert.equal(lo.data.permissionThrottle.level, "FULL");
  assert.equal(lo.data.permissionThrottle.sizeMultiplier, 1.0);

  const hi = await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.1, behaviorEvidenceScore01: 0.1, disciplineScore01: 0.9,
    cognitiveRiskScore01: 0.92, baselineMature: true,
    cognitiveRiskSeries: [0.92], minutesSinceLastCooldown: 0, ruleAdherenceLast24h: 0.5,
  });
  assert.equal(hi.status, 200);
  assert.equal(hi.data.permissionThrottle.level, "COOLDOWN");
  assert.equal(hi.data.permissionThrottle.blockNewEntries, true);
  assert.equal(hi.data.cooldownRecommendation.kind, "LOCKDOWN");
  assert.equal(hi.data.cooldownRecommendation.forcesLockdown, true);
});

test("PT-2 immature baseline defaults at least to CONFIRM_REQUIRED", async () => {
  const r = await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.05, behaviorEvidenceScore01: 0.05, disciplineScore01: 0.95,
    cognitiveRiskScore01: 0.05, baselineMature: false,
  });
  assert.equal(r.status, 200);
  // Either CONFIRM_REQUIRED or stricter — never raw FULL on immature baseline
  assert.notEqual(r.data.permissionThrottle.level, "FULL");
});

test("PT-3 forcePaperOnly switch wins", async () => {
  const r = await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.05, behaviorEvidenceScore01: 0.05, disciplineScore01: 0.95,
    cognitiveRiskScore01: 0.05, baselineMature: true, forcePaperOnly: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.permissionThrottle.level, "PAPER_ONLY");
  assert.equal(r.data.permissionThrottle.paperOnly, true);
});

// ──────────────────────────────────────────────────────────────────────────
// CD-1: cooldown policy adjusts with discipline + repeat offenses
// ──────────────────────────────────────────────────────────────────────────
test("CD-1 cooldown policy lengthens when discipline weak + repeat offenses", async () => {
  const baseline = await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.5, behaviorEvidenceScore01: 0.5, disciplineScore01: 0.7,
    cognitiveRiskScore01: 0.5, baselineMature: true,
    repeatOffenseCount: 0,
  });
  const harsh = await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.5, behaviorEvidenceScore01: 0.5, disciplineScore01: 0.2,
    cognitiveRiskScore01: 0.5, baselineMature: true,
    repeatOffenseCount: 3,
  });
  assert.equal(baseline.status, 200);
  assert.equal(harsh.status, 200);
  assert.ok(harsh.data.cooldownRecommendation.durationMinutes >
            baseline.data.cooldownRecommendation.durationMinutes,
    `harsh=${harsh.data.cooldownRecommendation.durationMinutes} baseline=${baseline.data.cooldownRecommendation.durationMinutes}`);
});

// ──────────────────────────────────────────────────────────────────────────
// REC-1: recovery score with improving trend → canRestorePermissions
// ──────────────────────────────────────────────────────────────────────────
test("REC-1 recovery score improving trend with adherence + time → canRestorePermissions=true", async () => {
  const r = await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.2, behaviorEvidenceScore01: 0.2, disciplineScore01: 0.9,
    cognitiveRiskScore01: 0.2, baselineMature: true,
    cognitiveRiskSeries: [0.85, 0.75, 0.6, 0.4, 0.3, 0.2],
    ruleAdherenceLast24h: 1.0, baselineDeviation01: 0.1, minutesSinceLastCooldown: 90,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.cognitiveRecovery.trend, "IMPROVING");
  assert.equal(r.data.cognitiveRecovery.canRestorePermissions, true);
});

test("REC-2 recovery score with degrading trend → canRestorePermissions=false", async () => {
  const r = await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.5, behaviorEvidenceScore01: 0.5, disciplineScore01: 0.5,
    cognitiveRiskScore01: 0.5, baselineMature: true,
    cognitiveRiskSeries: [0.2, 0.3, 0.45, 0.6, 0.75, 0.85],
    ruleAdherenceLast24h: 0.7, baselineDeviation01: 0.5, minutesSinceLastCooldown: 30,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.cognitiveRecovery.trend, "DEGRADING");
  assert.equal(r.data.cognitiveRecovery.canRestorePermissions, false);
});

// ──────────────────────────────────────────────────────────────────────────
// Z: advisory invariants — no TRADE_*, no MODE_*, canPlaceTrades:false
// ──────────────────────────────────────────────────────────────────────────
test("Z phase5b endpoints never emit TRADE_* or MODE_* and always set canPlaceTrades:false", async () => {
  await j("POST", "/trader-dna/baseline", { id: "z1", trades: matureTrades() });
  await j("POST", "/trader-dna/edge-fingerprint", { id: "z2", trades: matureTrades() });
  await j("POST", "/trader-dna/behavior-evidence", { id: "z3", trades: matureTrades() });
  await j("POST", "/cognitive/risk-evidence", cogSnapStable);
  await j("POST", "/cognitive/permission-throttle", {
    traderRiskScore01: 0.5, behaviorEvidenceScore01: 0.5, disciplineScore01: 0.5,
    cognitiveRiskScore01: 0.5, baselineMature: true,
  });
  await new Promise(r => setTimeout(r, 250));
  const trades = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events
       WHERE event_type IN ('TRADE_PLACED','TRADE_OPENED','TRADE_CLOSED','TRADE_EXECUTED','TRADE_REJECTED','TRADE_MODIFIED','TRADE_CANCELLED')`,
  );
  assert.equal(trades.rows[0].c, 0);
  const modes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_events
       WHERE source IN ('TRADER_DNA','COGNITIVE') AND event_type LIKE 'MODE_%'`,
  );
  assert.equal(modes.rows[0].c, 0);
});
