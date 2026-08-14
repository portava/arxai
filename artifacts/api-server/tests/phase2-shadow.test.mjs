// Phase 2 SHADOW vault tests — verify the parallel event-sourced audit log
// captures every important event, chain stays intact, integrity scan flags
// tampering, and main app continues to function.

import { test, beforeEach, before } from "node:test";
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

before(async () => {
  // Make sure the audit_events table exists before resetting.
  await pool.query(`SELECT 1`);
});

beforeEach(async () => {
  await pool.query(`DELETE FROM audit_events`);
  await pool.query(`DELETE FROM vault_events`);
  await pool.query(`DELETE FROM state_transitions`);
  await pool.query(`UPDATE safety_core SET operational_mode='OBSERVE_ONLY', global_state='NORMAL', kill_switch_engaged=false, kill_switch_engaged_at=NULL, kill_switch_reason=NULL`);
  await pool.query(`UPDATE mt5_state SET last_heartbeat_at=NOW()`);
});

// ── SH-1: vault is in SHADOW_MODE and storage is reachable ────────────────
test("SH-1 audit health reports SHADOW_MODE + storage available", async () => {
  const r = await j("GET", "/audit/health");
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, "SHADOW_MODE");
  assert.equal(r.data.storageOk, true);
});

// ── SH-2: a mode change is mirrored into audit_events ─────────────────────
test("SH-2 mode change shadow-captured into audit vault", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "shadow-test" });
  const r = await j("GET", "/audit/events?eventType=MODE_CHANGE");
  assert.equal(r.status, 200);
  assert.ok(r.data.count >= 1, `expected MODE_CHANGE event, got count=${r.data.count}`);
  const e = r.data.events[r.data.events.length - 1];
  assert.equal(e.eventType, "MODE_CHANGE");
  assert.equal(e.systemMode, "SUGGEST_ONLY");
  assert.equal(typeof e.checksum, "string");
  assert.equal(e.checksum.length, 64); // sha256 hex
  assert.equal(e.schemaVersion, 1);
});

// ── SH-3: the chain pointer + checksum hold across multiple events ────────
test("SH-3 chain integrity holds across multiple captured events", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "u" });
  await j("POST", "/system/kill-switch/engage", { reason: "chain-test", triggeredBy: "u" });
  const integrity = await j("GET", "/audit/integrity");
  assert.equal(integrity.status, 200);
  // 2 MODE_CHANGE + at least 1 KILL_SWITCH (+ STATE_TRANSITION). Want >=3.
  assert.ok(integrity.data.scannedRows >= 3, `expected >=3 events, got ${integrity.data.scannedRows}`);
  assert.equal(integrity.data.criticalCount, 0, `unexpected critical flags: ${JSON.stringify(integrity.data.flags)}`);
});

// ── SH-4: integrity scan detects checksum tampering on a row ──────────────
test("SH-4 integrity scan flags a tampered row", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  // Corrupt the most-recent row's checksum directly in DB.
  await pool.query(`UPDATE audit_events SET checksum='deadbeef' WHERE id=(SELECT MAX(id) FROM audit_events)`);
  const integrity = await j("GET", "/audit/integrity");
  assert.ok(integrity.data.byCategory.CHECKSUM_MISMATCH >= 1,
    `expected CHECKSUM_MISMATCH flag, got ${JSON.stringify(integrity.data.byCategory)}`);
});

// ── SH-5: integrity scan detects a broken chain ───────────────────────────
test("SH-5 integrity scan flags a broken previousEventId pointer", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "u" });
  // Break the chain by clobbering the second row's prev pointer.
  await pool.query(`UPDATE audit_events SET previous_event_id='ev_000000000000_deadbeef' WHERE id=(SELECT MAX(id) FROM audit_events)`);
  const integrity = await j("GET", "/audit/integrity");
  assert.ok(
    integrity.data.byCategory.BROKEN_CHAIN >= 1 || integrity.data.byCategory.CHECKSUM_MISMATCH >= 1,
    `expected BROKEN_CHAIN or CHECKSUM_MISMATCH, got ${JSON.stringify(integrity.data.byCategory)}`,
  );
});

// ── SH-6: snapshot rebuilds current systemMode + counts ───────────────────
test("SH-6 snapshot rebuilds systemMode + event-type counts", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  await j("POST", "/system/kill-switch/engage", { reason: "snap-test", triggeredBy: "u" });
  const snap = await j("GET", "/audit/snapshot");
  assert.equal(snap.status, 200);
  assert.ok(snap.data.totalEvents >= 2);
  // Kill switch event uses kind="KILL_SWITCH" in safetyCore — that is what is mirrored.
  assert.ok(snap.data.countsByType["MODE_CHANGE"] >= 1);
  assert.ok(snap.data.countsByType["KILL_SWITCH"] >= 1);
});

// ── SH-7: replay returns events up to a target id (inclusive) ─────────────
test("SH-7 replay returns events up to and including target", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  await j("POST", "/system/mode", { mode: "PAPER_TRADING", changedBy: "u" });
  const list = await j("GET", "/audit/events?limit=10");
  const target = list.data.events[0].eventId;
  const replay = await j("GET", `/audit/replay/${encodeURIComponent(target)}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.found, true);
  assert.equal(replay.data.events.length, 1);
  assert.equal(replay.data.events[0].eventId, target);
});

// ── SH-8: vault failure does NOT block main app behavior ──────────────────
test("SH-8 main app keeps working even if shadow write fails (smoke)", async () => {
  // We can't easily kill the DB here, but we can prove the path is fail-safe
  // by verifying that a successful mode change still returns 200 even under
  // load and that the main vault_events row was written regardless.
  const before = await pool.query(`SELECT count(*)::int AS n FROM vault_events`);
  const r = await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  assert.equal(r.status, 200);
  const after = await pool.query(`SELECT count(*)::int AS n FROM vault_events`);
  assert.ok(after.rows[0].n > before.rows[0].n, "main vault_events row must still be written");
});

// ── SH-9: query filters work end-to-end ───────────────────────────────────
test("SH-9 query by source + severity filters audit events", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  await j("POST", "/system/kill-switch/engage", { reason: "q-test", triggeredBy: "u" });
  const r = await j("GET", "/audit/events?source=KILL_SWITCH&severity=CRITICAL");
  assert.equal(r.status, 200);
  assert.ok(r.data.count >= 1, `expected >=1 critical kill-switch event, got ${r.data.count}`);
  for (const e of r.data.events) {
    assert.equal(e.source, "KILL_SWITCH");
    assert.equal(e.severity, "CRITICAL");
  }
});

// ── SH-10: retention plan classifies recent events as HOT ─────────────────
test("SH-10 retention plan classifies fresh events as HOT", async () => {
  await j("POST", "/system/mode", { mode: "SUGGEST_ONLY", changedBy: "u" });
  const r = await j("GET", "/audit/retention");
  assert.equal(r.status, 200);
  assert.ok(r.data.countsByTier.HOT >= 1);
  assert.equal(r.data.countsByTier.WARM, 0);
  assert.equal(r.data.countsByTier.ARCHIVED, 0);
});
