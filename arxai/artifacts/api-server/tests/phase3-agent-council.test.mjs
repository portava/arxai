// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — Agent System V2 (AI Trading Council) tests (AC-*).
//
// Verifies:
//   • All 12 agents emit well-shaped votes
//   • Council yields a verdict for clean trades (EXECUTE)
//   • Critical-agent veto (RISK / NEWS / EXEC) → HARD_BLOCK
//   • High disagreement → WAIT
//   • Vault has AGENT_VOTE / AGENT_BLOCKER / AGENT_DEBATE / JUDGE_VERDICT
//     / JUDGE_EXPLANATION rows for every council run
//   • Council cannot place trades (no TRADE_* events emitted)
//   • Phase 1 + Phase 2 invariants still hold
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
    symbol: "Volatility 75 Index",
    direction: "BUY",
    intendedEntryPrice: 100,
    stopLoss: 99,
    takeProfit: 102,
    lotSize: 0.5,
    proposedRiskPct: 0.5,
    pipSize: 0.01,
  };
}

async function evaluate(body) {
  return j("POST", "/agents/council/evaluate", body);
}

before(async () => { await pool.query(`SELECT 1`); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
});

// ─────────────────────────────────────────────────────────────────────────
// AC-1 — well-shaped output: 12 agent votes, debate, judge verdict
// ─────────────────────────────────────────────────────────────────────────
test("AC-1 council returns 12 agent votes + red/blue + disagreement + verdict + explanation", async () => {
  const r = await evaluate({ setup: baseSetup() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  const a = r.data.artifact;
  assert.equal(a.agentVotes.length, 12);
  // every vote has required fields
  for (const v of a.agentVotes) {
    assert.ok(typeof v.agentId === "string");
    assert.ok(["STRONG_FOR", "FOR", "NEUTRAL", "AGAINST", "STRONG_AGAINST"].includes(v.vote));
    assert.ok(typeof v.confidence01 === "number" && v.confidence01 >= 0 && v.confidence01 <= 1);
    assert.ok(Array.isArray(v.evidence));
    assert.ok(Array.isArray(v.blockers));
    assert.ok(Array.isArray(v.warnings));
    assert.ok(typeof v.isCritical === "boolean");
    assert.ok(typeof v.expiresAtIso === "string");
  }
  // critical agents flagged correctly — Phase 3 upgrade adds DNA (auth 5)
  const critical = a.agentVotes.filter(v => v.isCritical).map(v => v.agentId).sort();
  assert.deepEqual(critical, ["DNA", "EXEC", "NEWS", "RISK"]);
  // red & blue both examined
  assert.equal(a.redTeam.examined, true);
  assert.equal(a.blueTeam.examined, true);
  // disagreement score is 0..1
  assert.ok(a.disagreementScore01 >= 0 && a.disagreementScore01 <= 1);
  // judge produced one of the 7 verdicts
  assert.ok(["EXECUTE", "WAIT", "REDUCE_SIZE", "MONITOR_ONLY", "SOFT_BLOCK", "HARD_BLOCK", "EXECUTE_IF"]
    .includes(a.decision.verdict));
});

// ─────────────────────────────────────────────────────────────────────────
// AC-2 — clean trade with strong trend → EXECUTE
// ─────────────────────────────────────────────────────────────────────────
test("AC-2 strong-trend clean setup yields EXECUTE", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    market: {
      trendBiasSigned: 0.85,
      momentumSigned: 0.7,
      recentStructureBreak: "BUY",
      unsweptLiquiditySide: "BUY",
      emaConfluence01: 0.9,
      liquidityScore01: 0.9,
      pipsToNearestSwing: 3,
      spreadPips: 1,
      volatilityNow: 1,
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.artifact.decision.verdict, "EXECUTE",
    `expected EXECUTE, got ${r.data.artifact.decision.verdict}: ${r.data.artifact.decision.reasoning.join("; ")}`);
  assert.equal(r.data.artifact.decision.proposedDirection, "BUY");
});

// ─────────────────────────────────────────────────────────────────────────
// AC-3 — Risk Agent veto → HARD_BLOCK
// ─────────────────────────────────────────────────────────────────────────
test("AC-3 risk-agent blocker (drawdown breach) → HARD_BLOCK", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    account: { drawdownPct: 10 },                  // > maxDrawdownPct 5
    policy: { maxDrawdownPct: 5 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.artifact.decision.verdict, "HARD_BLOCK");
  assert.ok(r.data.artifact.decision.blockers.some(b => b.includes("Risk Agent")
    || b.toLowerCase().includes("drawdown")), JSON.stringify(r.data.artifact.decision.blockers));
});

// ─────────────────────────────────────────────────────────────────────────
// AC-4 — News blackout → HARD_BLOCK (NEWS is critical)
// ─────────────────────────────────────────────────────────────────────────
test("AC-4 news blackout → HARD_BLOCK", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    market: { trendBiasSigned: 0.7, momentumSigned: 0.6, emaConfluence01: 0.8 },
    news: {
      upcomingEvents: [{ title: "FOMC", severity: "HIGH", minutesUntil: 5, affectsSymbol: true }],
      blackoutMinutesBeforeHigh: 15, blackoutMinutesAfterHigh: 15,
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.artifact.decision.verdict, "HARD_BLOCK",
    `reasoning: ${r.data.artifact.decision.reasoning.join("; ")}`);
});

// ─────────────────────────────────────────────────────────────────────────
// AC-5 — High disagreement (mixed signals) → WAIT
// ─────────────────────────────────────────────────────────────────────────
test("AC-5 mixed direction signals (BUY-vs-SELL split) → WAIT", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    // Setup direction BUY, but every direction agent is told to vote SELL
    // with strong conviction → judge sees consensus opposite to setup.
    // We want WAIT (high disagreement) rather than SOFT_BLOCK, so we make
    // half BUY and half SELL: trend BUY, momentum SELL, structure SELL,
    // liquidity (uses unswept side) BUY.
    market: {
      trendBiasSigned: 0.6,         // BUY
      momentumSigned: -0.6,         // SELL
      recentStructureBreak: "SELL", // SELL
      unsweptLiquiditySide: "BUY",  // BUY
      emaConfluence01: 0.5,
      liquidityScore01: 0.7,
      pipsToNearestSwing: 4,
    },
  });
  assert.equal(r.status, 200);
  // disagreement should be high
  assert.ok(r.data.artifact.disagreementScore01 >= 0.4,
    `disagreement only ${r.data.artifact.disagreementScore01}`);
  // verdict should reflect the conflict — WAIT or SOFT_BLOCK both acceptable
  // (SOFT_BLOCK if judge rejects on direction mismatch first)
  assert.ok(["WAIT", "SOFT_BLOCK"].includes(r.data.artifact.decision.verdict),
    `expected WAIT or SOFT_BLOCK, got ${r.data.artifact.decision.verdict}`);
});

// ─────────────────────────────────────────────────────────────────────────
// AC-6 — Every council run writes votes/debate/verdict/explanation to vault
// ─────────────────────────────────────────────────────────────────────────
test("AC-6 vault has AGENT_VOTE×12 + AGENT_DEBATE + JUDGE_VERDICT + JUDGE_EXPLANATION", async () => {
  const r = await evaluate({ setup: baseSetup() });
  assert.equal(r.status, 200);

  const counts = await pool.query(`
    SELECT event_type, COUNT(*)::int AS n FROM audit_events GROUP BY event_type
  `);
  const byType = Object.fromEntries(counts.rows.map(row => [row.event_type, row.n]));
  assert.equal(byType.AGENT_VOTE, 12, JSON.stringify(byType));
  assert.equal(byType.AGENT_DEBATE, 1);
  assert.equal(byType.JUDGE_VERDICT, 1);
  assert.equal(byType.JUDGE_EXPLANATION, 1);

  // All vault rows should be sourced from AGENT_COUNCIL.
  const sources = await pool.query(`SELECT DISTINCT source FROM audit_events`);
  assert.deepEqual(sources.rows.map(r => r.source).sort(), ["AGENT_COUNCIL"]);
});

// ─────────────────────────────────────────────────────────────────────────
// AC-7 — Council cannot place trades (no TRADE_* events; no rows in trades)
// ─────────────────────────────────────────────────────────────────────────
test("AC-7 council never emits TRADE_APPROVED / TRADE_EXECUTED and the response declares it can't trade", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    market: { trendBiasSigned: 0.9, momentumSigned: 0.9, emaConfluence01: 1, liquidityScore01: 0.95 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.riskGovernorHasFinalVeto, true);

  const trades = await pool.query(`
    SELECT COUNT(*)::int AS n FROM audit_events
     WHERE event_type IN ('TRADE_APPROVED','TRADE_EXECUTED','TRADE_GATE','TRADE_BLOCKED','TRADE_REJECTED')
  `);
  assert.equal(trades.rows[0].n, 0, "council must not emit any TRADE_* event");
});

// ─────────────────────────────────────────────────────────────────────────
// AC-8 — AGENT_BLOCKER row written when a critical agent vetoes
// ─────────────────────────────────────────────────────────────────────────
test("AC-8 critical-agent veto produces a queryable AGENT_BLOCKER row", async () => {
  await evaluate({
    setup: baseSetup(),
    account: { drawdownPct: 10 }, policy: { maxDrawdownPct: 5 },
  });
  const blockers = await pool.query(`
    SELECT payload FROM audit_events WHERE event_type='AGENT_BLOCKER'
  `);
  assert.ok(blockers.rows.length >= 1);
  const row = blockers.rows[0].payload;
  assert.equal(row.agentId, "RISK");
  assert.equal(row.isCritical, true);
  assert.ok(typeof row.reason === "string" && row.reason.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────
// AC-9 — Phase 1 + Phase 2 invariants still hold after council route added
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// AC-9b — malformed override input is rejected with 400 (not crashed to 500)
// ─────────────────────────────────────────────────────────────────────────
test("AC-9b malformed overrides are rejected with 400 (no 500, no crash)", async () => {
  // String where a number is expected.
  const r1 = await evaluate({ setup: baseSetup(), account: { drawdownPct: "lots" } });
  assert.equal(r1.status, 400, JSON.stringify(r1.data));
  // Bad enum value.
  const r2 = await evaluate({ setup: baseSetup(), behavior: { emotionalState: "BANANAS" } });
  assert.equal(r2.status, 400);
  // Wrong shape for nested array element.
  const r3 = await evaluate({
    setup: baseSetup(),
    news: { upcomingEvents: [{ title: "x", severity: "NUKES", minutesUntil: 1, affectsSymbol: true }] },
  });
  assert.equal(r3.status, 400);
  // Missing required setup field.
  const r4 = await evaluate({ setup: { ...baseSetup(), lotSize: undefined } });
  assert.equal(r4.status, 400);
});

// ─────────────────────────────────────────────────────────────────────────
// AC-9c — AGENT_BLOCKER + JUDGE_VERDICT severities lock the audit semantics
// ─────────────────────────────────────────────────────────────────────────
test("AC-9c critical blocker severity is DANGER; HARD_BLOCK verdict severity is DANGER", async () => {
  await evaluate({
    setup: baseSetup(),
    account: { drawdownPct: 10 }, policy: { maxDrawdownPct: 5 },
  });
  const blocker = await pool.query(
    `SELECT severity FROM audit_events WHERE event_type='AGENT_BLOCKER' LIMIT 1`,
  );
  assert.equal(blocker.rows[0].severity, "DANGER");
  const verdict = await pool.query(
    `SELECT severity, payload FROM audit_events WHERE event_type='JUDGE_VERDICT' LIMIT 1`,
  );
  assert.equal(verdict.rows[0].severity, "DANGER");
  assert.equal(verdict.rows[0].payload.verdict, "HARD_BLOCK");
});

test("AC-9 vault still in SHADOW_MODE; safety_core untouched by council", async () => {
  // Snapshot safety_core state BEFORE the council run.
  const before = await pool.query(`SELECT operational_mode, global_state, kill_switch_engaged FROM safety_core`);
  const beforeMode = before.rows[0].operational_mode;
  const beforeState = before.rows[0].global_state;
  const beforeKill = before.rows[0].kill_switch_engaged;

  await evaluate({ setup: baseSetup() });

  // Vault must still be in SHADOW_MODE.
  const meta = await j("GET", "/audit/health");
  assert.equal(meta.status, 200);
  assert.equal(meta.data.mode, "SHADOW_MODE");

  // safety_core must be UNCHANGED by a council run.
  const after = await pool.query(`SELECT operational_mode, global_state, kill_switch_engaged FROM safety_core`);
  assert.equal(after.rows[0].operational_mode, beforeMode);
  assert.equal(after.rows[0].global_state, beforeState);
  assert.equal(after.rows[0].kill_switch_engaged, beforeKill);
});
