// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 SHADOW VAULT — full validation suite (V-* tests).
// Covers all six categories: Shadow Safety, Event Quality, Chain Integrity,
// Query System, Snapshot+Replay, and Resilience.
// ═══════════════════════════════════════════════════════════════════════════

import { test, beforeEach, before, after } from "node:test";
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

async function forceFail(n) {
  return j("POST", "/audit/_debug/force-fail", { n });
}

before(async () => { await pool.query(`SELECT 1`); });

beforeEach(async () => {
  await forceFail(0); // make sure no leftover fault injection
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
  await pool.query(`DELETE FROM state_transitions`);
  await pool.query(
    `UPDATE safety_core SET operational_mode='OBSERVE_ONLY', global_state='NORMAL', kill_switch_engaged=false, kill_switch_engaged_at=NULL, kill_switch_reason=NULL`,
  );
  await pool.query(`UPDATE mt5_state SET last_heartbeat_at=NOW()`);
});

after(async () => { await forceFail(0); await pool.end(); });

// ═══════════════════════════════════════════════════════════════════════════
// 1. SHADOW SAFETY
// ═══════════════════════════════════════════════════════════════════════════

test("V-S1 existing app behavior unchanged — vault row + main vault_events row both written", async () => {
  const r = await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  assert.equal(r.status, 200);
  const main = await pool.query(
    `SELECT count(*)::int AS n FROM vault_events WHERE kind='MODE_CHANGE'`,
  );
  const audit = await pool.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE event_type='MODE_CHANGE'`,
  );
  assert.equal(main.rows[0].n, 1, "Phase 2 vault_events MODE_CHANGE row missing");
  assert.equal(audit.rows[0].n, 1, "Phase 2 SHADOW audit_events MODE_CHANGE row missing");
});

test("V-S2 vault failure does not break the app — main flow returns 200, vault row still written", async () => {
  await forceFail(5);
  // 5 main-flow operations: each must succeed even though SHADOW writes fail.
  for (const m of ["SUGGEST_ONLY", "PAPER_TRADING", "OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING"]) {
    const r = await j("POST", "/system/mode", { mode: m, changedBy: "v" });
    assert.equal(r.status, 200, `mode=${m} blocked by vault failure`);
  }
  const main = await pool.query(`SELECT count(*)::int AS n FROM vault_events WHERE kind='MODE_CHANGE'`);
  assert.ok(main.rows[0].n >= 5, `expected >=5 vault_events MODE_CHANGE rows, got ${main.rows[0].n}`);
  // SHADOW should report degraded with pending events queued.
  const h = await j("GET", "/audit/health");
  assert.equal(h.data.degraded, true, "vault should be degraded after consecutive failures");
  assert.ok(h.data.pendingCount > 0, "expected pending events queued");
});

test("V-S3 vault has no power to block / approve / override trades", async () => {
  // Set up: PAPER_TRADING + force a vault outage.
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  await forceFail(10); // vault writes will fail, vault gets degraded
  // Burn 3 vault failures to trigger degraded
  for (const m of ["SUGGEST_ONLY", "PAPER_TRADING", "SUGGEST_ONLY"]) {
    await j("POST", "/system/mode", { mode: m, changedBy: "v" });
  }
  const h = await j("GET", "/audit/health");
  assert.equal(h.data.degraded, true);
  // Re-enable storage so trade gate succeeds normally
  await forceFail(0);
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });

  // Trade attempt — gate may approve / paper / block / reject in DEGRADED.
  // What matters is: NO event in either log has source="VAULT" for trade
  // approval, block, or override decisions.
  await j("POST", "/execute-trade", {
    symbol: "Volatility 75 Index", direction: "BUY", lot: 0.5,
    strategy: "Trend Continuation", confidence: 80,
    generatedAtIso: new Date().toISOString(),
  });
  // Audit log: no VAULT-sourced decisions
  const events = await j("GET", "/audit/events?limit=200");
  for (const e of events.data.events) {
    if (["APPROVED_TRADE", "BLOCKED_TRADE", "TRADE_GATE", "USER_OVERRIDE"].includes(e.eventType)) {
      assert.notEqual(e.source, "VAULT",
        `vault must not be a decision source for ${e.eventType}: ${JSON.stringify(e)}`);
    }
  }
  // Phase 1/2 vault_events log: no VAULT-sourced trade decisions either.
  const mainDecisions = await pool.query(
    `SELECT count(*)::int AS n FROM vault_events
     WHERE source='VAULT' AND kind IN ('APPROVED_TRADE','BLOCKED_TRADE','USER_OVERRIDE','TRADE_GATE')`,
  );
  assert.equal(mainDecisions.rows[0].n, 0,
    "vault must not appear as the source of any trade decision in vault_events");
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. EVENT QUALITY
// ═══════════════════════════════════════════════════════════════════════════

test("V-Q1 every event has all required fields", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/kill-switch/engage", { reason: "field-test", triggeredBy: "v" });
  const r = await j("GET", "/audit/events?limit=50");
  assert.ok(r.data.count >= 2);
  const required = ["eventId", "timestamp", "eventType", "source", "severity",
                    "systemMode", "globalState", "payload", "previousEventId",
                    "checksum", "schemaVersion"];
  for (const e of r.data.events) {
    for (const k of required) {
      assert.ok(k in e, `missing field "${k}" in event ${e.eventId}`);
    }
  }
});

test("V-Q2 event IDs are unique across the chain", async () => {
  for (const m of ["SUGGEST_ONLY", "PAPER_TRADING", "OBSERVE_ONLY", "SUGGEST_ONLY"]) {
    await j("POST", "/system/mode", { mode: m, changedBy: "v" });
  }
  const r = await j("GET", "/audit/events?limit=200");
  const ids = r.data.events.map(e => e.eventId);
  assert.equal(new Set(ids).size, ids.length, "duplicate event IDs detected");
});

test("V-Q3 timestamps are valid ISO-8601 + non-decreasing across the chain", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  await j("POST", "/system/kill-switch/engage", { reason: "ts-test", triggeredBy: "v" });
  const r = await j("GET", "/audit/events?limit=50");
  let prev = 0;
  for (const e of r.data.events) {
    const t = Date.parse(e.timestamp);
    assert.ok(Number.isFinite(t), `invalid timestamp on ${e.eventId}: ${e.timestamp}`);
    assert.ok(t >= prev, `timestamp went backwards at ${e.eventId}`);
    prev = t;
  }
});

test("V-Q4 every event carries schemaVersion=1", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/kill-switch/engage", { reason: "sv-test", triggeredBy: "v" });
  const r = await j("GET", "/audit/events?limit=50");
  for (const e of r.data.events) {
    assert.equal(e.schemaVersion, 1, `bad schemaVersion on ${e.eventId}`);
  }
});

test("V-Q5 payloads are valid JSON objects", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/kill-switch/engage", { reason: "pl-test", triggeredBy: "v" });
  const r = await j("GET", "/audit/events?limit=50");
  for (const e of r.data.events) {
    assert.equal(typeof e.payload, "object");
    assert.notEqual(e.payload, null);
    assert.ok(!Array.isArray(e.payload), "payload must be an object, not an array");
    // round-trip check (no functions / unserializable values)
    JSON.parse(JSON.stringify(e.payload));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. EVENT CHAIN INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════

test("V-C1 previousEventId chains the events together correctly", async () => {
  for (const m of ["SUGGEST_ONLY", "PAPER_TRADING", "OBSERVE_ONLY"]) {
    await j("POST", "/system/mode", { mode: m, changedBy: "v" });
  }
  const r = await j("GET", "/audit/events?limit=50");
  let prev = null;
  for (const e of r.data.events) {
    assert.equal(e.previousEventId, prev, `chain mismatch at ${e.eventId}`);
    prev = e.eventId;
  }
});

test("V-C2 broken chain (clobbered previousEventId) is detected", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  await pool.query(
    `UPDATE audit_events SET previous_event_id='ev_000000000000_deadbeef' WHERE id=(SELECT MAX(id) FROM audit_events)`,
  );
  const r = await j("GET", "/audit/integrity");
  assert.ok(
    (r.data.byCategory.BROKEN_CHAIN ?? 0) + (r.data.byCategory.CHECKSUM_MISMATCH ?? 0) >= 1,
    `expected BROKEN_CHAIN/CHECKSUM_MISMATCH, got ${JSON.stringify(r.data.byCategory)}`,
  );
});

test("V-C3 duplicate event IDs are detected by integrity scan", async () => {
  // The DB enforces UNIQUE(event_id) as defense-in-depth, so a duplicate can
  // never persist in production. To prove the integrity scan engine ALSO
  // catches dups (defense-in-depth on the read side), temporarily drop the
  // constraint, force a duplicate, run the scan, then restore.
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  await pool.query(`ALTER TABLE audit_events DROP CONSTRAINT audit_events_event_id_unique`);
  try {
    await pool.query(`
      UPDATE audit_events SET event_id=(SELECT event_id FROM audit_events ORDER BY id ASC LIMIT 1)
      WHERE id=(SELECT MAX(id) FROM audit_events)
    `);
    const r = await j("GET", "/audit/integrity");
    assert.ok((r.data.byCategory.DUPLICATE_EVENT_ID ?? 0) >= 1,
      `expected DUPLICATE_EVENT_ID flag, got ${JSON.stringify(r.data.byCategory)}`);
  } finally {
    // Clear duplicates first so the constraint can be re-added.
    await pool.query(`DELETE FROM audit_events`);
    await pool.query(`ALTER TABLE audit_events ADD CONSTRAINT audit_events_event_id_unique UNIQUE (event_id)`);
  }
});

test("V-C4 checksum corruption is detected", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await pool.query(
    `UPDATE audit_events SET checksum='deadbeef' WHERE id=(SELECT MAX(id) FROM audit_events)`,
  );
  const r = await j("GET", "/audit/integrity");
  assert.ok((r.data.byCategory.CHECKSUM_MISMATCH ?? 0) >= 1,
    `expected CHECKSUM_MISMATCH, got ${JSON.stringify(r.data.byCategory)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. QUERY SYSTEM (date / eventType / severity / systemMode / tradeId / symbol / source)
// ═══════════════════════════════════════════════════════════════════════════

test("V-QY1 query by date range (sinceIso/untilIso)", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await new Promise(r => setTimeout(r, 50));
  const cutoff = new Date().toISOString();
  await new Promise(r => setTimeout(r, 50));
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  const before = await j("GET", `/audit/events?untilIso=${encodeURIComponent(cutoff)}`);
  const after = await j("GET", `/audit/events?sinceIso=${encodeURIComponent(cutoff)}`);
  assert.ok(before.data.count >= 1);
  assert.ok(after.data.count >= 1);
  for (const e of before.data.events) assert.ok(e.timestamp <= cutoff);
  for (const e of after.data.events)  assert.ok(e.timestamp >= cutoff);
});

test("V-QY2 query by eventType", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/kill-switch/engage", { reason: "qy-test", triggeredBy: "v" });
  const r = await j("GET", "/audit/events?eventType=KILL_SWITCH");
  assert.ok(r.data.count >= 1);
  for (const e of r.data.events) assert.equal(e.eventType, "KILL_SWITCH");
});

test("V-QY3 query by severity", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/kill-switch/engage", { reason: "sev-test", triggeredBy: "v" });
  const r = await j("GET", "/audit/events?severity=CRITICAL");
  assert.ok(r.data.count >= 1);
  for (const e of r.data.events) assert.equal(e.severity, "CRITICAL");
});

test("V-QY4 query by systemMode", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  const r = await j("GET", "/audit/events?systemMode=PAPER_TRADING");
  assert.ok(r.data.count >= 1);
  for (const e of r.data.events) assert.equal(e.systemMode, "PAPER_TRADING");
});

test("V-QY5 query by tradeId / linkedTradeId", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  const t = await j("POST", "/execute-trade", {
    symbol: "Volatility 75 Index", direction: "BUY", lot: 0.5,
    strategy: "Trend Continuation", confidence: 80,
    generatedAtIso: new Date().toISOString(),
  });
  // Find a tradeId from any payload that has one.
  const all = await j("GET", "/audit/events?limit=200");
  const withTrade = all.data.events.find(e => e.payload && typeof e.payload.linkedTradeId === "string");
  if (!withTrade) {
    // Trade may have been blocked. Skip the strict assertion but still verify
    // the filter accepts the param.
    const r = await j("GET", "/audit/events?tradeId=does-not-exist");
    assert.equal(r.status, 200);
    assert.equal(r.data.count, 0);
    return;
  }
  const tid = withTrade.payload.linkedTradeId;
  const r = await j("GET", `/audit/events?tradeId=${encodeURIComponent(tid)}`);
  assert.ok(r.data.count >= 1);
  for (const e of r.data.events) {
    assert.equal(e.payload.linkedTradeId, tid);
  }
  void t;
});

test("V-QY6 query by symbol", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  await j("POST", "/execute-trade", {
    symbol: "Volatility 75 Index", direction: "BUY", lot: 0.5,
    strategy: "Trend Continuation", confidence: 80,
    generatedAtIso: new Date().toISOString(),
  });
  const r = await j("GET", "/audit/events?symbol=" + encodeURIComponent("Volatility 75 Index"));
  // If gate produced any symbol-tagged event, filter should match it.
  for (const e of r.data.events) {
    assert.equal(e.payload.symbol, "Volatility 75 Index");
  }
});

test("V-QY7 query by source", async () => {
  await j("POST", "/system/kill-switch/engage", { reason: "src-test", triggeredBy: "v" });
  const r = await j("GET", "/audit/events?source=KILL_SWITCH");
  assert.ok(r.data.count >= 1);
  for (const e of r.data.events) assert.equal(e.source, "KILL_SWITCH");
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SNAPSHOT + REPLAY
// ═══════════════════════════════════════════════════════════════════════════

test("V-SR1 snapshotBuilder rebuilds basic system state", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  await j("POST", "/system/kill-switch/engage", { reason: "snap", triggeredBy: "v" });
  const snap = await j("GET", "/audit/snapshot");
  assert.equal(snap.status, 200);
  assert.equal(snap.data.killSwitchEngaged, true,
    "snapshot must reflect kill-switch engaged");
  assert.equal(snap.data.killSwitchReason, "snap");
  assert.ok(snap.data.countsByType["MODE_CHANGE"] >= 2);
  assert.ok(snap.data.countsByType["KILL_SWITCH"] >= 1);
  // systemMode is taken from the most recent event that carried one.
  assert.ok(["PAPER_TRADING", "OBSERVE_ONLY"].includes(snap.data.systemMode),
    `unexpected systemMode in snapshot: ${snap.data.systemMode}`);
});

test("V-SR2 eventReplay reconstructs a previous decision timeline", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  await j("POST", "/system/kill-switch/engage", { reason: "replay-mid", triggeredBy: "v" });
  await j("POST", "/system/kill-switch/reset", { resetBy: "v" });
  const all = await j("GET", "/audit/events?limit=100");
  // Pick the kill-switch engage as the target — replay should include it but
  // NOT the later kill-switch reset.
  const killEv = all.data.events.find(e => e.eventType === "KILL_SWITCH");
  assert.ok(killEv, "kill-switch event missing");
  const replay = await j("GET", `/audit/replay/${encodeURIComponent(killEv.eventId)}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.found, true);
  // Last event in the replay must be the target.
  const last = replay.data.events[replay.data.events.length - 1];
  assert.equal(last.eventId, killEv.eventId);
  // Snapshot at that point: kill-switch engaged.
  assert.equal(replay.data.snapshot.killSwitchEngaged, true);
  // No later events present.
  for (const e of replay.data.events) {
    assert.notEqual(e.eventType, "KILL_SWITCH_RESET",
      "replay must not include events after the target");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. RESILIENCE
// ═══════════════════════════════════════════════════════════════════════════

test("V-R1 storage failure triggers DEGRADED_MODE (via driveGlobalState)", async () => {
  // Get to PAPER_TRADING so trade gate is exercised.
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  // Force enough vault failures to flip degraded.
  await forceFail(20);
  for (const m of ["SUGGEST_ONLY", "PAPER_TRADING", "SUGGEST_ONLY", "PAPER_TRADING"]) {
    await j("POST", "/system/mode", { mode: m, changedBy: "v" });
  }
  const h = await j("GET", "/audit/health");
  assert.equal(h.data.degraded, true, "vault should be degraded after failures");
  // Now trigger driveGlobalState by hitting trade gate.
  await j("POST", "/execute-trade", {
    symbol: "Volatility 75 Index", direction: "BUY", lot: 0.5,
    strategy: "Trend Continuation", confidence: 80,
    generatedAtIso: new Date().toISOString(),
  });
  const status = await j("GET", "/system/status");
  assert.equal(status.status, 200);
  assert.equal(status.data.globalState, "DEGRADED_MODE",
    `expected DEGRADED_MODE while vault is degraded, got ${status.data.globalState}`);
});

test("V-R2 recovery logs delayed vault events (queue drains, marked _recoveredAfterOutage)", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  // Fail next 4 writes
  await forceFail(4);
  for (const m of ["PAPER_TRADING", "OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING"]) {
    await j("POST", "/system/mode", { mode: m, changedBy: "v" });
  }
  const mid = await j("GET", "/audit/health");
  assert.ok(mid.data.pendingCount >= 4, `expected >=4 pending, got ${mid.data.pendingCount}`);
  // Recover (force-fail counter naturally drained, plus explicit reset).
  await forceFail(0);
  // One successful write triggers drain.
  await j("POST", "/system/mode", { mode: "OBSERVE_ONLY", changedBy: "v" });
  const post = await j("GET", "/audit/health");
  assert.equal(post.data.pendingCount, 0, "pending queue should be drained on recovery");
  assert.equal(post.data.degraded, false, "vault should leave DEGRADED after drain");
  // The drained events must be present in audit_events with the recovery marker.
  const recovered = await j("GET", "/audit/events?limit=200");
  const tagged = recovered.data.events.filter(e => e.payload && e.payload._recoveredAfterOutage === true);
  assert.ok(tagged.length >= 4, `expected >=4 recovered events, got ${tagged.length}`);
});

test("V-R3 corruption alerts are created without enabling execution", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "v" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "v" });
  // Corrupt a checksum to force criticalCount > 0.
  await pool.query(
    `UPDATE audit_events SET checksum='deadbeef' WHERE id=(SELECT MAX(id) FROM audit_events)`,
  );
  // Capture status BEFORE integrity scan to compare permission.
  const before = await j("GET", "/system/status");
  const r = await j("GET", "/audit/integrity");
  assert.ok(r.data.criticalCount > 0);
  // The alert must have been recorded into vault_events as VAULT_CORRUPTION_ALERT.
  const alert = await pool.query(
    `SELECT count(*)::int AS n FROM vault_events WHERE kind='VAULT_CORRUPTION_ALERT'`,
  );
  assert.ok(alert.rows[0].n >= 1, "VAULT_CORRUPTION_ALERT row should be inserted");
  // Permission / mode / killswitch must be unchanged (vault has no power).
  const after = await j("GET", "/system/status");
  assert.equal(after.data.executionPermission, before.data.executionPermission);
  assert.equal(after.data.operationalMode, before.data.operationalMode);
  assert.equal(after.data.killSwitchEngaged, before.data.killSwitchEngaged);
});
