// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 UPGRADE tests — authority, expiration, conflict, accountability.
// ═══════════════════════════════════════════════════════════════════════════

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { Pool } = pg;
const BASE = "http://localhost:80/api";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function j(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function baseSetup() {
  return {
    symbol: "Volatility 75 Index", direction: "BUY",
    intendedEntryPrice: 100, stopLoss: 99, takeProfit: 102,
    lotSize: 0.5, proposedRiskPct: 0.5, pipSize: 0.01,
  };
}
const evaluate  = (b) => j("POST", "/agents/council/evaluate",        b);
const grade     = (b) => j("POST", "/agents/council/grade",           b);
const staleness = (b) => j("POST", "/agents/council/check-staleness", b);

before(async () => { await pool.query(`SELECT 1`); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
});

// ─── Authority ──────────────────────────────────────────────────────────
test("AU-1 every agent has an authority level 1..5; RISK/EXEC/NEWS/DNA are 5", async () => {
  const r = await evaluate({ setup: baseSetup() });
  assert.equal(r.status, 200);
  const auths = r.data.artifact.authorityDecisions;
  assert.equal(auths.length, 12);
  const byId = Object.fromEntries(auths.map(a => [a.agentId, a.authorityLevel]));
  assert.equal(byId.RISK, 5);
  assert.equal(byId.EXEC, 5);
  assert.equal(byId.NEWS, 5);
  assert.equal(byId.DNA, 5);
  for (const a of auths) {
    assert.ok(a.authorityLevel >= 1 && a.authorityLevel <= 5, `${a.agentId}=${a.authorityLevel}`);
    assert.equal(a.canHardBlock, a.authorityLevel === 5);
  }
});

test("AU-2 RISK veto produces an effective authority decision and AUTHORITY_DECISION row", async () => {
  await evaluate({
    setup: baseSetup(),
    account: { drawdownPct: 10 }, policy: { maxDrawdownPct: 5 },
  });
  const rows = await pool.query(`
    SELECT payload FROM audit_events
     WHERE event_type='AUTHORITY_DECISION'
       AND payload->>'agentId'='RISK'
  `);
  assert.equal(rows.rows.length, 1);
  const p = rows.rows[0].payload;
  assert.equal(p.authorityLevel, 5);
  assert.equal(p.hadVeto, true);
  assert.equal(p.vetoEffective, true);
  assert.equal(p.downgradedTo, null);
});

test("AU-3 hard-block resolver overrides verdict when an authority-5 agent vetoes", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    account: { drawdownPct: 10 }, policy: { maxDrawdownPct: 5 },
  });
  const hb = r.data.artifact.hardBlockResolution;
  assert.equal(hb.triggered, true);
  assert.ok(hb.byAgentIds.includes("RISK"));
  assert.equal(hb.finalVerdict, "HARD_BLOCK");
  assert.equal(r.data.artifact.decision.verdict, "HARD_BLOCK");
  // and a HARD_BLOCK_RESOLUTION row was logged
  const ev = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='HARD_BLOCK_RESOLUTION'`);
  assert.equal(ev.rows[0].n, 1);
});

test("AU-4 clean trade has no triggered hard-block and no HARD_BLOCK_RESOLUTION row", async () => {
  await evaluate({
    setup: baseSetup(),
    market: { trendBiasSigned: 0.85, momentumSigned: 0.7, emaConfluence01: 0.9, liquidityScore01: 0.9 },
  });
  const ev = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='HARD_BLOCK_RESOLUTION'`);
  assert.equal(ev.rows[0].n, 0);
});

// ─── Expiration ─────────────────────────────────────────────────────────
test("EX-1 voteExpirationChecks present for all 12 agents; none expired right after run", async () => {
  const r = await evaluate({ setup: baseSetup() });
  const checks = r.data.artifact.voteExpirationChecks;
  assert.equal(checks.length, 12);
  assert.ok(checks.every(c => c.expired === false), "no vote should be stale immediately after run");
  assert.equal(r.data.artifact.staleGuard.blockExecution, false);
  assert.equal(r.data.artifact.staleGuard.hasStaleCritical, false);
  // No VOTE_EXPIRED rows on a fresh run.
  const n = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='VOTE_EXPIRED'`);
  assert.equal(n.rows[0].n, 0);
});

// ─── Conflict severity ──────────────────────────────────────────────────
test("CO-1 conflictSeverity is present with a valid level", async () => {
  const r = await evaluate({ setup: baseSetup() });
  const cs = r.data.artifact.conflictSeverity;
  assert.ok(["NONE", "LOW", "MEDIUM", "HIGH", "EXTREME"].includes(cs.level));
  assert.ok(typeof cs.disagreement01 === "number");
  // CONFLICT_RESOLUTION row written on every run
  const n = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='CONFLICT_RESOLUTION'`);
  assert.equal(n.rows[0].n, 1);
});

test("CO-2 mixed signals produce non-NONE conflict severity", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    market: {
      trendBiasSigned: 0.6, momentumSigned: -0.6,
      recentStructureBreak: "SELL", unsweptLiquiditySide: "BUY",
      emaConfluence01: 0.5, liquidityScore01: 0.7,
    },
  });
  assert.notEqual(r.data.artifact.conflictSeverity.level, "NONE");
});

// ─── Blocker hierarchy ──────────────────────────────────────────────────
test("BH-1 blockerHierarchy ranks RISK above non-critical blockers and emits BLOCKER_HIERARCHY", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    account: { drawdownPct: 10 }, policy: { maxDrawdownPct: 5 },
  });
  const bh = r.data.artifact.blockerHierarchy;
  assert.ok(bh.length >= 1);
  assert.equal(bh[0].agentId, "RISK");
  assert.equal(bh[0].rank, 1);
  assert.equal(bh[0].authorityLevel, 5);
  assert.equal(bh[0].severity, "DANGER");
  const n = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='BLOCKER_HIERARCHY'`);
  assert.equal(n.rows[0].n, 1);
});

// ─── Calibration / accountability ───────────────────────────────────────
test("CA-1 grade endpoint records F for confident-FOR on a LOSS and writes CALIBRATION_RECORD", async () => {
  // Run a council to get a decisionId.
  const ev = await evaluate({ setup: baseSetup() });
  const decisionId = ev.data.artifact.decisionId;

  const g = await grade({
    decisionId, outcome: "LOSS", pnlR: -1,
    agentVotes: [
      { agentId: "TREND", agentName: "Trend Agent",        vote: "STRONG_FOR", confidence01: 0.9 },
      { agentId: "MOMO",  agentName: "Momentum Agent",     vote: "FOR",        confidence01: 0.7 },
      { agentId: "RISK",  agentName: "Risk Agent",         vote: "AGAINST",    confidence01: 0.8 },
    ],
  });
  assert.equal(g.status, 200);
  assert.equal(g.data.canPlaceTrades, false);
  const recs = Object.fromEntries(g.data.records.map(r => [r.agentId, r]));
  assert.equal(recs.TREND.grade, "F");          // confident FOR + LOSS
  assert.ok(recs.TREND.scoreDelta <= -1);
  assert.equal(recs.RISK.grade, "A");            // confident AGAINST + LOSS
  assert.ok(recs.RISK.scoreDelta >= 1);

  const rows = await pool.query(`
    SELECT payload, severity FROM audit_events WHERE event_type='CALIBRATION_RECORD'
  `);
  assert.equal(rows.rows.length, 3);
  const trendRow = rows.rows.find(r => r.payload.agentId === "TREND");
  assert.equal(trendRow.severity, "DANGER");     // grade F → DANGER
  assert.equal(trendRow.payload.outcome, "LOSS");
});

test("CA-2 grade endpoint validates input (400 on bad vote/outcome)", async () => {
  const r1 = await grade({ decisionId: "x", outcome: "ANYTHING", agentVotes: [] });
  assert.equal(r1.status, 400);
  const r2 = await grade({
    decisionId: "x", outcome: "WIN",
    agentVotes: [{ agentId: "T", agentName: "T", vote: "MAYBE", confidence01: 0.5 }],
  });
  assert.equal(r2.status, 400);
});

// ─── Stale-guard re-check at consumption time ───────────────────────────
test("EX-2 check-staleness blocks execution when a critical vote expired in the past", async () => {
  const past = new Date(Date.now() - 10_000).toISOString();   // 10s ago
  const future = new Date(Date.now() + 60_000).toISOString(); // 60s ahead
  const r = await staleness({
    decisionId: "stale_test_1",
    votes: [
      { agentId: "RISK",  agentName: "Risk Agent",  isCritical: true,  expiresAtIso: past },
      { agentId: "TREND", agentName: "Trend Agent", isCritical: false, expiresAtIso: future },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.guard.blockExecution, true, JSON.stringify(r.data.guard));
  assert.equal(r.data.guard.hasStaleCritical, true);
  assert.deepEqual(r.data.guard.staleAgentIds, ["RISK"]);

  const expired = await pool.query(`SELECT severity, payload FROM audit_events WHERE event_type='VOTE_EXPIRED'`);
  assert.equal(expired.rows.length, 1);
  assert.equal(expired.rows[0].severity, "DANGER");
  assert.equal(expired.rows[0].payload.agentId, "RISK");

  const guard = await pool.query(`SELECT severity, payload FROM audit_events WHERE event_type='STALE_GUARD'`);
  assert.equal(guard.rows.length, 1);
  assert.equal(guard.rows[0].severity, "DANGER");
  assert.equal(guard.rows[0].payload.blockExecution, true);
});

test("EX-3 check-staleness with all fresh votes does not block and emits no VOTE_EXPIRED", async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const r = await staleness({
    decisionId: "fresh_test_1",
    votes: [
      { agentId: "RISK",  agentName: "Risk Agent",  isCritical: true,  expiresAtIso: future },
      { agentId: "TREND", agentName: "Trend Agent", isCritical: false, expiresAtIso: future },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.guard.blockExecution, false);
  const expired = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='VOTE_EXPIRED'`);
  assert.equal(expired.rows[0].n, 0);
  const guard = await pool.query(`SELECT severity FROM audit_events WHERE event_type='STALE_GUARD'`);
  assert.equal(guard.rows[0].severity, "INFO");
});

test("EX-4 check-staleness rejects malformed input with 400", async () => {
  const r = await staleness({ decisionId: "x", votes: [] });
  assert.equal(r.status, 400);
});

// ─── Phase 1 + Phase 2 invariants still untouched ───────────────────────
test("UPG-Z council never emits TRADE_* and safety_core unchanged after upgrade run", async () => {
  const before = await pool.query(`SELECT operational_mode FROM safety_core`);
  await evaluate({ setup: baseSetup() });
  await grade({
    decisionId: "x_test", outcome: "WIN", pnlR: 1,
    agentVotes: [{ agentId: "TREND", agentName: "Trend Agent", vote: "FOR", confidence01: 0.7 }],
  });
  const after = await pool.query(`SELECT operational_mode FROM safety_core`);
  assert.equal(after.rows[0].operational_mode, before.rows[0].operational_mode);
  const trades = await pool.query(`
    SELECT COUNT(*)::int n FROM audit_events
     WHERE event_type IN ('TRADE_APPROVED','TRADE_EXECUTED','TRADE_BLOCKED','TRADE_REJECTED','TRADE_GATE')
  `);
  assert.equal(trades.rows[0].n, 0);
});
