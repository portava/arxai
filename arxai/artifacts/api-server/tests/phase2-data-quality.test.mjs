// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — Vault Data Quality + Privacy Guard tests (DQ-*).
// Covers: redaction, compression, poison detection, quality flags, training
// eligibility, end-to-end pipeline through SHADOW capture, and the safety
// invariants (vault still in SHADOW_MODE, vault still cannot influence trades).
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

async function capture(draft) {
  return j("POST", "/audit/_debug/capture", draft);
}

before(async () => { await pool.query(`SELECT 1`); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await j("POST", "/audit/_debug/force-fail", { n: 0 });
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
  await pool.query(`DELETE FROM state_transitions`);
  await pool.query(
    `UPDATE safety_core SET operational_mode='OBSERVE_ONLY', global_state='NORMAL', kill_switch_engaged=false, kill_switch_engaged_at=NULL, kill_switch_reason=NULL`,
  );
  await pool.query(`UPDATE mt5_state SET last_heartbeat_at=NOW()`);
});

async function lastAuditEvent() {
  const r = await j("GET", "/audit/events?limit=2000");
  return r.data.events[r.data.events.length - 1];
}

// ─────────────────────────────────────────────────────────────────────────
// 1. SENSITIVE DATA FILTER
// ─────────────────────────────────────────────────────────────────────────

test("DQ-1 redacts top-level secrets (password, token, apiKey, broker_secret)", async () => {
  await capture({
    eventType: "DEBUG_TEST", source: "TEST", severity: "INFO",
    systemMode: "OBSERVE_ONLY", globalState: "NORMAL",
    payload: {
      symbol: "Volatility 75 Index",
      password: "super-secret-1",
      apiKey: "live_xxx",
      access_token: "abcdef",
      broker_secret: "mt5-broker-key",
      lot: 0.5,
    },
  });
  const e = await lastAuditEvent();
  assert.equal(e.payload.password, "[REDACTED]");
  assert.equal(e.payload.apiKey, "[REDACTED]");
  assert.equal(e.payload.access_token, "[REDACTED]");
  assert.equal(e.payload.broker_secret, "[REDACTED]");
  // Non-sensitive fields preserved
  assert.equal(e.payload.symbol, "Volatility 75 Index");
  assert.equal(e.payload.lot, 0.5);
  // Quality metadata records what was redacted
  assert.equal(e.payload._quality.redactionCount, 4);
  for (const k of ["password", "apiKey", "access_token", "broker_secret"]) {
    assert.ok(e.payload._quality.redactedKeys.includes(k), `missing ${k} in redactedKeys`);
  }
});

test("DQ-2 redaction walks nested objects and arrays", async () => {
  await capture({
    eventType: "DEBUG_TEST", source: "TEST", severity: "INFO",
    systemMode: null, globalState: null,
    payload: {
      account: { broker_password: "p", nested: { mt5_token: "t" } },
      sessions: [{ session_id: "abc" }, { cookie: "c", note: "ok" }],
    },
  });
  const e = await lastAuditEvent();
  assert.equal(e.payload.account.broker_password, "[REDACTED]");
  assert.equal(e.payload.account.nested.mt5_token, "[REDACTED]");
  assert.equal(e.payload.sessions[0].session_id, "[REDACTED]");
  assert.equal(e.payload.sessions[1].cookie, "[REDACTED]");
  assert.equal(e.payload.sessions[1].note, "ok");
  assert.ok(e.payload._quality.redactionCount >= 4);
});

test("DQ-3 redacts secret-shaped string values (JWT, sk-, Bearer)", async () => {
  await capture({
    eventType: "DEBUG_TEST", source: "TEST", severity: "INFO",
    systemMode: null, globalState: null,
    payload: {
      authNote: "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UifQ.signature123abc",
      vendor: "sk-1234567890abcdefghij",
      header: "Bearer abcdef0123456789ghijklmnop",
      friendly: "Volatility 75 Index",
    },
  });
  const e = await lastAuditEvent();
  assert.equal(e.payload.authNote, "[REDACTED]");
  assert.equal(e.payload.vendor, "[REDACTED]");
  assert.equal(e.payload.header, "[REDACTED]");
  assert.equal(e.payload.friendly, "Volatility 75 Index");
});

// ─────────────────────────────────────────────────────────────────────────
// 2. EVENT COMPRESSION
// ─────────────────────────────────────────────────────────────────────────

test("DQ-4 large candles array is compressed to head+tail+originalLength", async () => {
  const candles = Array.from({ length: 200 }, (_, i) => ({
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i,
  }));
  await capture({
    eventType: "BACKTEST_SNAPSHOT", source: "BACKTEST", severity: "INFO",
    systemMode: null, globalState: null,
    payload: { symbol: "Volatility 75 Index", candles },
  });
  const e = await lastAuditEvent();
  assert.equal(e.payload.candles._compressed, true);
  assert.equal(e.payload.candles.originalLength, 200);
  assert.equal(e.payload.candles.head.length, 5);
  assert.equal(e.payload.candles.tail.length, 5);
  assert.equal(e.payload._quality.compressed, true);
  assert.ok(e.payload._quality.compressedFields.includes("candles"));
});

test("DQ-5 small payloads are NOT compressed", async () => {
  await capture({
    eventType: "MODE_CHANGE", source: "CONTROL_TOWER", severity: "INFO",
    systemMode: "SUGGEST_ONLY", globalState: "NORMAL",
    payload: { newMode: "SUGGEST_ONLY", changedBy: "u" },
  });
  const e = await lastAuditEvent();
  assert.equal(e.payload._quality.compressed, false);
  assert.equal(e.payload._quality.compressedFields.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. POISON DATA DETECTOR
// ─────────────────────────────────────────────────────────────────────────

test("DQ-6 lot-size out-of-range raises poison signal + disqualifies training", async () => {
  await capture({
    eventType: "TRADE_GATE", source: "RISK_GOVERNOR", severity: "INFO",
    systemMode: "PAPER_TRADING", globalState: "NORMAL",
    payload: { symbol: "Volatility 75 Index", lot: 99999, confidence: 80 },
  });
  const e = await lastAuditEvent();
  assert.ok(e.payload._quality.poisonScore >= 0.4,
    `expected poisonScore>=0.4, got ${e.payload._quality.poisonScore}`);
  assert.ok(e.payload._quality.poisonSignals.some((s) => s.startsWith("lot-out-of-range")));
  assert.equal(e.payload._quality.trainingEligible, false);
  assert.ok(e.payload._quality.eligibilityReasons.some((r) => r.startsWith("poison:")));
});

test("DQ-7 all-zero candles + non-finite values raise multiple poison signals", async () => {
  await capture({
    eventType: "TRADE_GATE", source: "RISK_GOVERNOR", severity: "INFO",
    systemMode: null, globalState: null,
    payload: {
      candles: Array.from({ length: 6 }, () => ({ open: 0, high: 0, low: 0, close: 0 })),
      ratio: "Infinity",  // store as string so JSON survives
      bogusNum: 1e15,
    },
  });
  const e = await lastAuditEvent();
  const sigs = e.payload._quality.poisonSignals;
  assert.ok(sigs.includes("candles-all-zero"), `signals: ${JSON.stringify(sigs)}`);
  assert.ok(sigs.some((s) => s.startsWith("extreme-magnitude")));
  assert.equal(e.payload._quality.trainingEligible, false);
});

test("DQ-8 confidence outside 0..100 is flagged", async () => {
  await capture({
    eventType: "SIGNAL", source: "STRATEGY", severity: "INFO",
    systemMode: null, globalState: null,
    payload: { symbol: "Volatility 75 Index", confidence: 250 },
  });
  const e = await lastAuditEvent();
  const sigs = e.payload._quality.poisonSignals;
  assert.ok(sigs.some((s) => s.startsWith("probability-out-of-range")));
});

// ─────────────────────────────────────────────────────────────────────────
// 4. DATA QUALITY GUARD (flags)
// ─────────────────────────────────────────────────────────────────────────

test("DQ-9 future timestamp on draft is flagged + disqualifies training", async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
  await capture({
    eventType: "DEBUG_TEST", source: "TEST", severity: "INFO",
    systemMode: null, globalState: null,
    timestamp: future,
    payload: { ok: 1 },
  });
  const e = await lastAuditEvent();
  const flagKinds = e.payload._quality.flags.map((f) => f.kind);
  assert.ok(flagKinds.includes("FUTURE_TIMESTAMP"), `flags: ${JSON.stringify(flagKinds)}`);
  assert.equal(e.payload._quality.trainingEligible, false);
});

test("DQ-10 oversized payload is flagged WARN (not training-disqualifying)", async () => {
  const big = "x".repeat(80 * 1024); // 80 KB string > 64 KB cap
  await capture({
    eventType: "DEBUG_TEST", source: "TEST", severity: "INFO",
    systemMode: null, globalState: null,
    payload: { blob: big },
  });
  const e = await lastAuditEvent();
  const oversize = e.payload._quality.flags.find((f) => f.kind === "OVERSIZED_PAYLOAD");
  assert.ok(oversize, `expected OVERSIZED_PAYLOAD flag, got ${JSON.stringify(e.payload._quality.flags)}`);
  assert.equal(oversize.severity, "WARN");
  // WARN-only does NOT disqualify
  assert.equal(e.payload._quality.trainingEligible, true);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. TRAINING ELIGIBILITY MARKING (every event marked)
// ─────────────────────────────────────────────────────────────────────────

test("DQ-11 every captured event is marked trainingEligible (boolean)", async () => {
  // Mix of clean + dirty events
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "u" });
  await j("POST", "/system/kill-switch/engage", { reason: "dq-test", triggeredBy: "u" });
  await capture({
    eventType: "TRADE_GATE", source: "RISK_GOVERNOR", severity: "INFO",
    systemMode: null, globalState: null,
    payload: { lot: -5 }, // poison
  });
  const all = await j("GET", "/audit/events?limit=200");
  assert.ok(all.data.count >= 4);
  for (const e of all.data.events) {
    assert.equal(typeof e.payload._quality?.trainingEligible, "boolean",
      `event ${e.eventId} (${e.eventType}) missing trainingEligible bool`);
  }
});

test("DQ-12 query filter trainingEligible=true|false partitions the events", async () => {
  // 1 clean event
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  // 1 poison event
  await capture({
    eventType: "TRADE_GATE", source: "RISK_GOVERNOR", severity: "INFO",
    systemMode: null, globalState: null,
    payload: { lot: 999999 },
  });
  const ok = await j("GET", "/audit/events?trainingEligible=true");
  const bad = await j("GET", "/audit/events?trainingEligible=false");
  assert.ok(ok.data.count >= 1);
  assert.ok(bad.data.count >= 1);
  for (const e of ok.data.events)  assert.equal(e.payload._quality.trainingEligible, true);
  for (const e of bad.data.events) assert.equal(e.payload._quality.trainingEligible, false);
});

// ─────────────────────────────────────────────────────────────────────────
// 6. SAFETY INVARIANTS — guard layer must not change vault status or trade powers
// ─────────────────────────────────────────────────────────────────────────

test("DQ-13 vault stays in SHADOW_MODE after running guard pipeline", async () => {
  await capture({
    eventType: "DEBUG_TEST", source: "TEST", severity: "INFO",
    systemMode: null, globalState: null,
    payload: { lot: 9e15, password: "x" },
  });
  const h = await j("GET", "/audit/health");
  assert.equal(h.data.mode, "SHADOW_MODE");
});

test("DQ-14 guard layer never produces a VAULT-sourced trade decision row", async () => {
  // Capture a poisoned trade-gate-shaped event; it must NOT flow into
  // vault_events as a real trade decision (guard is record-only).
  await capture({
    eventType: "TRADE_GATE", source: "RISK_GOVERNOR", severity: "INFO",
    systemMode: "PAPER_TRADING", globalState: "NORMAL",
    payload: { symbol: "Volatility 75 Index", lot: 100000, decision: "APPROVED" },
  });
  // Phase 1/2 vault_events must NOT contain any VAULT-sourced trade decisions.
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM vault_events
     WHERE source='VAULT' AND kind IN ('APPROVED_TRADE','BLOCKED_TRADE','USER_OVERRIDE','TRADE_GATE')`,
  );
  assert.equal(r.rows[0].n, 0, "guard layer must not write into trade decision log");
});

test("DQ-15a fail-closed: when guard pipeline THROWS, raw payload is DROPPED (no secret leak)", async () => {
  const r = await capture({
    eventType: "DEBUG_TEST", source: "TEST", severity: "INFO",
    systemMode: null, globalState: null,
    payload: {
      __forceGuardThrow: true,
      password: "ULTRA-SECRET-DO-NOT-LEAK",
      apiKey: "live_DO_NOT_LEAK",
      symbol: "Volatility 75 Index",
    },
  });
  assert.equal(r.status, 200);
  // Direct DB read — the secret value must not appear ANYWHERE.
  const rows = await pool.query(`SELECT payload FROM audit_events`);
  assert.ok(rows.rows.length >= 1, "stub event must still be persisted");
  for (const row of rows.rows) {
    const json = JSON.stringify(row.payload);
    assert.ok(!json.includes("ULTRA-SECRET-DO-NOT-LEAK"), `leaked password value: ${json}`);
    assert.ok(!json.includes("live_DO_NOT_LEAK"), `leaked apiKey value: ${json}`);
    assert.ok(!json.includes("Volatility 75 Index"), `leaked non-redacted field: ${json}`);
  }
  // The persisted stub must be marked guard-error and training-ineligible.
  const e = await lastAuditEvent();
  assert.equal(e.payload._droppedDueToGuardError, true);
  assert.equal(e.payload._quality.trainingEligible, false);
  assert.ok(e.payload._quality.eligibilityReasons.includes("guard-pipeline-error"));
});

test("DQ-15 secrets never reach storage even when capture is concurrent", async () => {
  // Hammer with 10 concurrent captures, each carrying secrets.
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    capture({
      eventType: "DEBUG_TEST", source: "TEST", severity: "INFO",
      systemMode: null, globalState: null,
      payload: { i, password: `secret-${i}`, token: `tok-${i}` },
    }),
  ));
  // Direct DB scan: not a single audit_events row may contain a secret.
  const rows = await pool.query(`SELECT payload FROM audit_events`);
  assert.ok(rows.rows.length >= 10);
  for (const row of rows.rows) {
    const json = JSON.stringify(row.payload);
    assert.ok(!json.includes("secret-"), `leaked secret value: ${json}`);
    assert.ok(!json.includes("tok-"), `leaked token value: ${json}`);
  }
});
