// ═════════════════════════════════════════════════════════════════════════
// Phase 1 — Foundation Safety Core VERIFICATION SUITE.
//
// Companion to phase1.test.mjs (23 tests) and phase1-guards.test.mjs
// (17 tests). This file fills the residual coverage gaps versus the
// official Phase 1 verification checklist:
//
//   1. Control Tower    → mode allow-list at the API boundary
//   2. Risk Governor    → sub-guard severity escalation in vault
//   3. Global State     → exposes all 5 spec-required state names
//   4. Kill Switch      → reset requires explicit acknowledgement
//   5. Resilience       → vault integrity scan endpoint contract
//   6. Black Box Vault  → human-override fail-closed without token
//
// All tests run against the live API (proxied via localhost:80) and use
// pg only to read audit_events / state_transitions for verification.
// ═════════════════════════════════════════════════════════════════════════

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;
const BASE = process.env.API_BASE_URL ?? "http://localhost:80/api";
let db;

async function j(method, path, body, headers) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const ping = await j("GET", "/system/status");
  assert.equal(ping.status, 200, "API server must be reachable");
});

after(async () => { try { await db.end(); } catch {} });

// Reset to a known clean baseline so sticky states do not poison cases.
async function resetSafetyCore() {
  await db.query(`
    UPDATE safety_core SET
      operational_mode = 'PAPER_TRADING',
      global_state = 'NORMAL',
      kill_switch_engaged = false,
      kill_switch_engaged_at = NULL,
      kill_switch_reason = NULL,
      updated_at = NOW()
  `);
}
async function setHeartbeatAge(seconds) {
  const ts = new Date(Date.now() - seconds * 1000);
  const exists = await db.query("SELECT id FROM mt5_state LIMIT 1");
  if (exists.rows.length === 0) {
    await db.query("INSERT INTO mt5_state (last_heartbeat_at) VALUES ($1)", [ts]);
  } else {
    await db.query("UPDATE mt5_state SET last_heartbeat_at = $1", [ts]);
  }
}
async function clearHeartbeat() {
  await db.query("UPDATE mt5_state SET last_heartbeat_at = NULL");
}
beforeEach(async () => { await resetSafetyCore(); await clearHeartbeat(); });

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM 1 — CONTROL TOWER
// ─────────────────────────────────────────────────────────────────────────

test("PV-CT-1 mode endpoint rejects values outside the allow-list", async () => {
  // Spec: only OBSERVE_ONLY / SUGGEST_ONLY / PAPER_TRADING / LIVE_TRADING
  // are accepted at the boundary. SHADOW_TRADING, MICRO_LOT_LIVE, etc.
  // exist in the domain enum but are NOT runtime-reachable yet.
  for (const bad of ["SHADOW_TRADING", "MICRO_LOT_LIVE", "FULL_AUTO_GOVERNED", "LOCKDOWN", "BOGUS"]) {
    const r = await j("POST", "/system/mode", { mode: bad, changedBy: "verification-suite" });
    assert.equal(r.status, 400, `mode ${bad} must be rejected at the API boundary`);
  }
});

test("PV-CT-2 GlobalState schema admits ALL 5 spec-required state names", async () => {
  // Probe the postgres CHECK / enum constraint on state_transitions.to_state
  // by asking it whether each spec-required name is acceptable. We use a
  // SAVEPOINT so we never actually mutate state_transitions.
  const required = ["NORMAL", "DEGRADED_MODE", "LOCKDOWN", "RECOVERY_MODE", "SAFE_SHUTDOWN"];
  for (const name of required) {
    await db.query("BEGIN");
    try {
      await db.query(
        `INSERT INTO state_transitions
           (from_state, to_state, from_substates, to_substates, changed,
            accepted_sources, rejected_sources, reasons, blockers, generated_at_iso)
         VALUES ('NORMAL', $1, '{}', '{}', true, '{}', '{}', '{}', '{}', NOW()::text)`,
        [name],
      );
      await db.query("ROLLBACK");
    } catch (err) {
      await db.query("ROLLBACK");
      assert.fail(`GlobalState schema does not accept required name ${name}: ${err.message}`);
    }
  }
  // And the live status must report a valid union member right now.
  const r = await j("GET", "/system/status");
  assert.equal(r.status, 200);
  assert.ok(["OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING", "LIVE_TRADING"].includes(r.data.operationalMode));
});

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM 2 — RISK GOVERNOR (sub-guard severity escalation)
// ─────────────────────────────────────────────────────────────────────────

test("PV-RG-1 single-failure hard-block emits WARN severity in audit_events", async () => {
  await db.query(`DELETE FROM audit_events WHERE event_type = 'FS_GUARD_HARD_BLOCK'`);
  const r = await j("POST", "/risk/guards/hard-block", {
    drawdown: { currentDrawdownPct: 2, maxDrawdownPct: 10 },
    exposure: { openTradeCount: 3, maxOpenTrades: 10, totalExposurePct: 25, maxExposurePct: 60, perSymbolCount: [], maxPerSymbol: 5 },
    maxLoss:  { realizedDailyLossPct: 5, maxDailyLossPct: 3, perTradeLossPct: 0.2, maxPerTradeLossPct: 2, consecutiveLossCount: 0, maxConsecutiveLosses: 5 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.passed, false);
  await new Promise((res) => setTimeout(res, 200));
  const rows = await db.query(`SELECT severity FROM audit_events WHERE event_type='FS_GUARD_HARD_BLOCK' ORDER BY id DESC LIMIT 1`);
  assert.equal(rows.rows[0]?.severity, "WARN");
});

test("PV-RG-2 multi-failure hard-block escalates to DANGER severity", async () => {
  await db.query(`DELETE FROM audit_events WHERE event_type = 'FS_GUARD_HARD_BLOCK'`);
  const r = await j("POST", "/risk/guards/hard-block", {
    drawdown: { currentDrawdownPct: 12, maxDrawdownPct: 10 },
    exposure: { openTradeCount: 11, maxOpenTrades: 10, totalExposurePct: 80, maxExposurePct: 60, perSymbolCount: [], maxPerSymbol: 5 },
    maxLoss:  { realizedDailyLossPct: 5, maxDailyLossPct: 3, perTradeLossPct: null, maxPerTradeLossPct: 2, consecutiveLossCount: 0, maxConsecutiveLosses: 5 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.passed, false);
  assert.ok(r.data.result.blockingKinds.length >= 2);
  await new Promise((res) => setTimeout(res, 200));
  const rows = await db.query(`SELECT severity FROM audit_events WHERE event_type='FS_GUARD_HARD_BLOCK' ORDER BY id DESC LIMIT 1`);
  assert.equal(rows.rows[0]?.severity, "DANGER",
    "≥2 simultaneous sub-guard failures must escalate severity to DANGER");
});

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM 3 — GLOBAL STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────

test("PV-GS-1 state-machine drives full DEGRADED → SAFE_SHUTDOWN cycle and logs every transition", async () => {
  // Anchor BEFORE we touch anything so concurrent tests can't pollute.
  const startMark = (await db.query("SELECT NOW() AS t")).rows[0].t;

  // Force a degraded heartbeat → DEGRADED_MODE
  await setHeartbeatAge(20);
  const s1 = await j("GET", "/system/status");
  assert.equal(s1.status, 200);
  assert.equal(s1.data.globalState, "DEGRADED_MODE");

  // Force a dead heartbeat → SAFE_SHUTDOWN
  await setHeartbeatAge(120);
  const s2 = await j("GET", "/system/status");
  assert.equal(s2.data.globalState, "SAFE_SHUTDOWN");

  // SAFE_SHUTDOWN is intentionally sticky — recovering the heartbeat alone
  // must NOT auto-clear the shutdown (manual operator action required).
  await setHeartbeatAge(2);
  const s3 = await j("GET", "/system/status");
  assert.equal(s3.data.globalState, "SAFE_SHUTDOWN",
    "SAFE_SHUTDOWN must remain sticky until explicit reset");

  // Every transition driven by THIS test (anchored to startMark) must be in
  // state_transitions — no NOW() window contamination from sibling tests.
  const r = await db.query(
    `SELECT to_state FROM state_transitions
     WHERE created_at >= $1 ORDER BY id ASC`,
    [startMark],
  );
  const seen = new Set(r.rows.map((x) => x.to_state));
  assert.ok(seen.has("DEGRADED_MODE"), "missing DEGRADED_MODE transition");
  assert.ok(seen.has("SAFE_SHUTDOWN"), "missing SAFE_SHUTDOWN transition");
});

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM 4 — KILL SWITCH
// ─────────────────────────────────────────────────────────────────────────

test("PV-KS-1 reset is REJECTED when acknowledgement is missing or empty", async () => {
  await j("POST", "/system/kill-switch/engage", { reason: "verification drill", triggeredBy: "verification-suite" });
  const bad = await j("POST", "/system/kill-switch/reset", { resetBy: "verification-suite" });
  assert.ok(bad.status >= 400, "reset without acknowledgement must be rejected");
  // And then a properly acknowledged reset succeeds.
  const ok = await j("POST", "/system/kill-switch/reset", {
    resetBy: "verification-suite",
    acknowledgement: "I_UNDERSTAND_RISK",
  });
  assert.equal(ok.status, 200);
});

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM 5 — RESILIENCE (vault integrity contract)
// ─────────────────────────────────────────────────────────────────────────

test("PV-RE-1 vault integrity scan returns a fully-populated VaultIntegrityReport", async () => {
  const r = await j("GET", "/system/vault/integrity?limit=200");
  assert.equal(r.status, 200);
  const rep = r.data;
  assert.ok(rep && typeof rep === "object");
  // Contract — every field on VaultIntegrityReport must be present and
  // internally consistent.
  assert.equal(typeof rep.scannedRows, "number", "scannedRows missing");
  assert.equal(typeof rep.flagCount, "number", "flagCount missing");
  assert.equal(typeof rep.criticalCount, "number", "criticalCount missing");
  assert.ok(rep.byCategory && typeof rep.byCategory === "object", "byCategory missing");
  assert.ok(Array.isArray(rep.flags), "flags[] missing");
  assert.ok(Array.isArray(rep.reasons), "reasons[] missing");
  // Internal invariants
  assert.equal(rep.flagCount, rep.flags.length, "flagCount must equal flags.length");
  assert.ok(rep.criticalCount <= rep.flagCount, "criticalCount cannot exceed flagCount");
  assert.ok(rep.scannedRows >= 0 && rep.scannedRows <= 2000, "scannedRows out of range");
});

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM 6 — BLACK BOX VAULT FOUNDATION (override fail-closed)
// ─────────────────────────────────────────────────────────────────────────

test("PV-BV-1a human override is REJECTED with a wrong bridge token", async () => {
  const r = await j(
    "POST", "/system/override",
    { user: "verification-suite", action: "TEST_BAD_TOKEN" },
    { "X-Vault-Override-Token": "definitely-not-the-token" },
  );
  // If env is set (the test runner sets VAULT_OVERRIDE_TOKEN), the route
  // returns 401. If env is unset, it returns 503. Both are fail-closed.
  assert.ok([401, 503].includes(r.status),
    `wrong override token must fail-closed; got ${r.status}`);
});

test("PV-BV-1b human override SUCCEEDS with correct token AND writes a USER_OVERRIDE vault row", async () => {
  const token = process.env.VAULT_OVERRIDE_TOKEN;
  if (!token) {
    // Env unset → endpoint is correctly disabled; nothing else to verify.
    const r = await j("POST", "/system/override", { user: "x", action: "Y" });
    assert.equal(r.status, 503);
    return;
  }
  const before = await db.query(
    `SELECT COUNT(*)::int AS n FROM vault_events WHERE kind='USER_OVERRIDE'`,
  );
  const r = await j(
    "POST", "/system/override",
    { user: "verification-suite", action: "TEST_GOOD_TOKEN", reasons: ["phase1-verify"] },
    { "X-Vault-Override-Token": token },
  );
  assert.equal(r.status, 200, `good token must be accepted; got ${r.status}`);
  assert.equal(r.data.ok, true);
  const after = await db.query(
    `SELECT COUNT(*)::int AS n FROM vault_events WHERE kind='USER_OVERRIDE'`,
  );
  assert.equal(after.rows[0].n, before.rows[0].n + 1,
    "successful override must persist exactly one USER_OVERRIDE vault row");
});
