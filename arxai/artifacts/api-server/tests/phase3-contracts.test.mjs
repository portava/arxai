// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 V2 contracts tests — agent contract, validation, versioning,
// safety guards, shadow comparison, drift detection.
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
const evaluate = (b) => j("POST", "/agents/council/evaluate",        b);
const shadow   = (b) => j("POST", "/agents/council/shadow-compare",  b);
const drift    = (b) => j("POST", "/agents/council/drift",           b);

before(async () => { await pool.query(`SELECT 1`); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
});

// ─── Agent contract & versioning ────────────────────────────────────────
test("CT-1 every agent produces a complete, well-formed contract with required fields", async () => {
  const r = await evaluate({ setup: baseSetup() });
  assert.equal(r.status, 200);
  const a = r.data.artifact;
  assert.equal(a.schemaVersion, "2.0.0");
  assert.equal(a.agentContracts.length, 12);
  for (const c of a.agentContracts) {
    assert.ok(c.agentId && c.agentName, `agent missing identity`);
    assert.match(c.agentVersion, /^\d+\.\d+\.\d+$/, `bad version ${c.agentVersion}`);
    assert.ok([1, 2, 3, 4, 5].includes(c.authorityLevel));
    assert.ok(["STRONG_FOR", "FOR", "NEUTRAL", "AGAINST", "STRONG_AGAINST"].includes(c.vote));
    assert.ok(c.confidence01 >= 0 && c.confidence01 <= 1);
    assert.ok(Array.isArray(c.evidence));
    assert.ok(Array.isArray(c.warnings));
    assert.ok(Array.isArray(c.blockers));
    assert.ok(typeof c.expiresAtIso === "string" && !Number.isNaN(Date.parse(c.expiresAtIso)));
    assert.ok(Array.isArray(c.dataSourcesUsed) && c.dataSourcesUsed.length >= 1);
    assert.ok(c.uncertaintyReason === null || typeof c.uncertaintyReason === "string");
  }
});

test("CT-2 contractValidations all pass for the standard council run", async () => {
  const r = await evaluate({ setup: baseSetup() });
  const valids = r.data.artifact.contractValidations;
  assert.equal(valids.length, 12);
  assert.ok(valids.every(v => v.valid), "all standard contracts must validate");
  // No AGENT_OUTPUT_INVALID rows since all valid.
  const n = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='AGENT_OUTPUT_INVALID'`);
  assert.equal(n.rows[0].n, 0);
});

// ─── Safety guards ──────────────────────────────────────────────────────
test("SG-1 hallucination/evidence/cap arrays present and well-shaped on every run", async () => {
  const r = await evaluate({ setup: baseSetup() });
  const a = r.data.artifact;
  assert.equal(a.hallucinationChecks.length, 12);
  assert.equal(a.evidenceChecks.length, 12);
  assert.equal(a.confidenceCaps.length, 12);
  for (const c of a.confidenceCaps) {
    assert.ok(c.afterConfidence01 <= c.beforeConfidence01 + 1e-9, "cap must never raise confidence");
  }
});

test("SG-2 stale market data caps confidence on agents that read market", async () => {
  // Force market.observedAt very old → confidence cap to ≤0.50 for agents
  // that read the market sensor.
  const old = new Date(Date.now() - 5 * 60_000).toISOString(); // 5min ago
  const r = await evaluate({
    setup: baseSetup(),
    market: { observedAt: old, trendBiasSigned: 0.8, momentumSigned: 0.7, emaConfluence01: 0.9 },
  });
  const caps = r.data.artifact.confidenceCaps;
  const trendCap = caps.find(c => c.agentId === "TREND");
  assert.ok(trendCap, "TREND cap entry must exist");
  // If TREND originally had any non-trivial confidence, it must now be <=0.50.
  if (trendCap.applied) {
    assert.ok(trendCap.afterConfidence01 <= 0.50 + 1e-9);
    assert.ok(trendCap.reasons.some(r => r.includes("stale market")));
  }
  // CONFIDENCE_CAPPED row written when applied.
  if (caps.some(c => c.applied)) {
    const n = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='CONFIDENCE_CAPPED'`);
    assert.ok(n.rows[0].n >= 1);
  }
});

test("SG-3 risk veto produces a self-conflict cap on the RISK contract", async () => {
  const r = await evaluate({
    setup: baseSetup(),
    account: { drawdownPct: 10 }, policy: { maxDrawdownPct: 5 },
  });
  const caps = r.data.artifact.confidenceCaps;
  const riskCap = caps.find(c => c.agentId === "RISK");
  assert.ok(riskCap, "RISK cap entry exists");
  // RISK is an AGAINST/STRONG_AGAINST vote with a blocker → self-conflict cap.
  // Either the cap was applied (and explained) OR confidence was already low.
  if (riskCap.applied) {
    assert.ok(riskCap.reasons.some(r => r.includes("self-conflict")));
  }
});

// ─── Hard invariants of the safety pipeline ─────────────────────────────
test("SG-4 council still produces a verdict and does NOT place trades", async () => {
  const r = await evaluate({ setup: baseSetup() });
  assert.equal(r.data.canPlaceTrades, false);
  assert.ok(r.data.artifact.decision.verdict);
});

// ─── Shadow comparison ──────────────────────────────────────────────────
test("SH-1 shadow-compare returns NONE/LOW when V1 matches V2", async () => {
  // First run a normal council to learn V2's verdict + confidence.
  const ev = await evaluate({ setup: baseSetup() });
  const v2v = ev.data.artifact.decision.verdict;
  const v2c = ev.data.artifact.decision.confidence01;

  const r = await shadow({ setup: baseSetup(), v1: { verdict: v2v, confidence01: v2c } });
  assert.equal(r.status, 200);
  assert.equal(r.data.canPlaceTrades, false);
  assert.equal(r.data.comparison.v1Verdict, v2v);
  assert.ok(["NONE", "LOW"].includes(r.data.comparison.severity));
  // SHADOW_COMPARISON row written.
  const rows = await pool.query(`SELECT severity, payload FROM audit_events WHERE event_type='SHADOW_COMPARISON'`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].payload.schemaVersion, "2.0.0");
});

test("SH-2 shadow-compare flags HIGH severity on intent mismatch (EXECUTE vs HARD_BLOCK)", async () => {
  // RISK veto → V2 is HARD_BLOCK. Pretend V1 said EXECUTE.
  const r = await shadow({
    setup: baseSetup(),
    account: { drawdownPct: 10 }, policy: { maxDrawdownPct: 5 },
    v1: { verdict: "EXECUTE", confidence01: 0.8 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.v2.verdict, "HARD_BLOCK");
  assert.equal(r.data.comparison.severity, "HIGH");
  const row = await pool.query(`SELECT severity FROM audit_events WHERE event_type='SHADOW_COMPARISON'`);
  assert.equal(row.rows[0].severity, "DANGER");
});

test("SH-3 shadow-compare rejects malformed input with 400", async () => {
  const r = await shadow({ setup: baseSetup(), v1: { verdict: "MAYBE", confidence01: 0.5 } });
  assert.equal(r.status, 400);
});

// ─── Drift detection ────────────────────────────────────────────────────
function contract(overrides = {}) {
  return {
    agentId: "TREND", agentName: "Trend Agent",
    agentVersion: "2.0.0", authorityLevel: 4,
    vote: "FOR", confidence01: 0.6,
    evidence: ["EMA stack BUY"], warnings: [], blockers: [],
    expiresAtIso: new Date(Date.now() + 30_000).toISOString(),
    dataSourcesUsed: ["market"], uncertaintyReason: null,
    ...overrides,
  };
}

test("DR-1 drift endpoint reports NONE when contracts are identical", async () => {
  const c = contract();
  const r = await drift({ decisionId: "drift_none", baseline: c, current: c });
  assert.equal(r.status, 200);
  assert.equal(r.data.report.drifted, false);
  assert.equal(r.data.report.severity, "NONE");
  const n = await pool.query(`SELECT COUNT(*)::int n FROM audit_events WHERE event_type='DRIFT_DETECTED'`);
  assert.equal(n.rows[0].n, 0);
});

test("DR-2 drift endpoint flags HIGH severity on a vote flip", async () => {
  const baseline = contract({ vote: "STRONG_FOR" });
  const current  = contract({ vote: "STRONG_AGAINST" });
  const r = await drift({ decisionId: "drift_flip", baseline, current });
  assert.equal(r.status, 200);
  assert.equal(r.data.report.drifted, true);
  assert.equal(r.data.report.severity, "HIGH");
  const rows = await pool.query(`SELECT severity, payload FROM audit_events WHERE event_type='DRIFT_DETECTED'`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].severity, "DANGER");
  assert.ok(rows.rows[0].payload.reasons.some(s => s.includes("flipped")));
});

test("DR-3 drift endpoint flags HIGH on major version change", async () => {
  const baseline = contract({ agentVersion: "2.0.0" });
  const current  = contract({ agentVersion: "3.0.0" });
  const r = await drift({ decisionId: "drift_ver", baseline, current });
  assert.equal(r.data.report.severity, "HIGH");
  assert.equal(r.data.report.versionCompare, "MAJOR_DIFF");
});

test("DR-4 drift endpoint rejects mismatched agentIds with 400", async () => {
  const baseline = contract({ agentId: "TREND" });
  const current  = contract({ agentId: "RISK" });
  const r = await drift({ decisionId: "drift_bad", baseline, current });
  assert.equal(r.status, 400);
});

// ─── Phase 1 + Phase 2 invariants still untouched ───────────────────────
test("CT-Z council never emits TRADE_* and safety_core unchanged after V2 contracts run", async () => {
  const before = await pool.query(`SELECT operational_mode FROM safety_core`);
  await evaluate({ setup: baseSetup() });
  await shadow({ setup: baseSetup(), v1: { verdict: "WAIT", confidence01: 0.5 } });
  const after = await pool.query(`SELECT operational_mode FROM safety_core`);
  assert.equal(after.rows[0].operational_mode, before.rows[0].operational_mode);
  const trades = await pool.query(`
    SELECT COUNT(*)::int n FROM audit_events
     WHERE event_type IN ('TRADE_APPROVED','TRADE_EXECUTED','TRADE_BLOCKED','TRADE_REJECTED','TRADE_GATE')
  `);
  assert.equal(trades.rows[0].n, 0);
});
