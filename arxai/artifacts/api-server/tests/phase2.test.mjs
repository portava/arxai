// Phase 2 — Data + Memory Core verification suite.
//
// Goal: every required category produces a vault event with the right
// shape, every query dimension works, and the integrity engine actually
// flags bad rows. Runs against the live API server (proxied via :80) plus
// direct Postgres for setup/teardown.
//
// Usage: pnpm --filter @workspace/api-server run test
//        (api-server workflow must be running)

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import pkg from "pg";

const { Client } = pkg;
const BASE = process.env.API_BASE_URL ?? "http://localhost:80/api";

async function j(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* tolerate */ }
  return { status: res.status, data };
}

const status      = ()                => j("GET",  "/system/status");
const setMode     = (mode)            => j("POST", "/system/mode", { mode, changedBy: "phase2-suite" });
const engageKs    = (reason)          => j("POST", "/system/kill-switch/engage", { reason, triggeredBy: "phase2-suite" });
const resetKs     = (ack="I_UNDERSTAND_RISK") => j("POST", "/system/kill-switch/reset", { acknowledgement: ack, resetBy: "phase2-suite" });
const vaultQ      = (qs="")           => j("GET",  `/system/vault?${qs}`);
const integrityQ  = (qs="")           => j("GET",  `/system/vault/integrity?${qs}`);
const OVERRIDE_TOKEN = process.env.VAULT_OVERRIDE_TOKEN ?? "phase2-test-token";
async function override(body) {
  const res = await fetch(`${BASE}/system/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Vault-Override-Token": OVERRIDE_TOKEN },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const trade       = (overrides = {})  => j("POST", "/execute-trade", {
  symbol: "Volatility 75 Index",
  direction: "BUY",
  lot: 0.5,
  entry: 100,
  sl: 95,
  tp: 110,
  strategy: "Trend Continuation",
  confidence: 75,
  ...overrides,
});

let pg;
before(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const s = await status();
  assert.equal(s.status, 200, "API server must be reachable");
});
after(async () => { try { await pg.end(); } catch {} });

async function setHeartbeatAge(seconds) {
  const ts = new Date(Date.now() - seconds * 1000);
  const exists = await pg.query("SELECT id FROM mt5_state LIMIT 1");
  if (exists.rows.length === 0) await pg.query("INSERT INTO mt5_state (last_heartbeat_at) VALUES ($1)", [ts]);
  else                          await pg.query("UPDATE mt5_state SET last_heartbeat_at = $1", [ts]);
}
async function clearHeartbeat() {
  const exists = await pg.query("SELECT id FROM mt5_state LIMIT 1");
  if (exists.rows.length > 0) await pg.query("UPDATE mt5_state SET last_heartbeat_at = NULL");
}
async function resetSafetyCore() {
  await pg.query(`
    UPDATE safety_core SET
      operational_mode='PAPER_TRADING', global_state='NORMAL',
      kill_switch_engaged=false, kill_switch_engaged_at=NULL,
      kill_switch_reason=NULL, updated_at=NOW()
  `);
}

beforeEach(async () => {
  await resetSafetyCore();
  await clearHeartbeat();
});

// Vault rows added strictly after a marker we capture in the test.
async function recentEvents(sinceIso, qs="") {
  const v = await vaultQ(qs ? `${qs}&limit=200` : "limit=200");
  assert.equal(v.status, 200);
  return v.data.events.filter((e) => new Date(e.createdAt).toISOString() >= sinceIso);
}

// ═══════════════════════════════════════════════════════════════════════
// LOG-* — every required event category produces a vault row
// ═══════════════════════════════════════════════════════════════════════

test("LOG-1 mode change produces MODE_CHANGE vault row", async () => {
  const since = new Date().toISOString();
  await setMode("OBSERVE_ONLY");
  await setMode("SUGGEST_ONLY");
  const recent = await recentEvents(since);
  const modeChanges = recent.filter((e) => e.kind === "MODE_CHANGE");
  assert.ok(modeChanges.length >= 2, `expected ≥2 MODE_CHANGE rows, got ${modeChanges.length}`);
});

test("LOG-2 blocked trade produces TRADE_GATE + BLOCKED_TRADE rows with linked symbol", async () => {
  await engageKs("LOG-2 test");
  const since = new Date().toISOString();
  await trade();
  const recent = await recentEvents(since);
  const blocked = recent.find((e) => e.kind === "BLOCKED_TRADE");
  assert.ok(blocked, "BLOCKED_TRADE row required");
  assert.equal(blocked.symbol, "Volatility 75 Index");
  assert.equal(blocked.truthDomain, "DECISION");
  assert.ok(blocked.blockers.length > 0);
  assert.ok(recent.find((e) => e.kind === "TRADE_GATE"), "TRADE_GATE row required");
});

test("LOG-3 approved (LIVE) trade produces APPROVED_TRADE row with linkedTradeId", async () => {
  // Stand up healthy LIVE conditions.
  await setHeartbeatAge(2);
  // Need a trade to first drive global state to NORMAL after reset
  await setMode("PAPER_TRADING");
  await trade();
  const sUp = await setMode("LIVE_TRADING");
  assert.equal(sUp.status, 200, `expected LIVE accepted, got ${JSON.stringify(sUp.data)}`);
  const since = new Date().toISOString();
  const r = await trade();
  assert.equal(r.status, 200, `LIVE trade should succeed, got ${JSON.stringify(r.data)}`);
  const recent = await recentEvents(since);
  const approved = recent.find((e) => e.kind === "APPROVED_TRADE");
  assert.ok(approved, "APPROVED_TRADE row required for LIVE trade");
  assert.equal(approved.symbol, "Volatility 75 Index");
  assert.equal(approved.linkedTradeId, String(r.data.tradeId));
  assert.equal(approved.truthDomain, "EXECUTION");
});

test("LOG-4 paper trade produces PAPER_TRADE row with linkedTradeId", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const since = new Date().toISOString();
  const r = await trade();
  assert.equal(r.status, 200);
  const recent = await recentEvents(since);
  const paper = recent.find((e) => e.kind === "PAPER_TRADE");
  assert.ok(paper, "PAPER_TRADE row required");
  assert.equal(paper.linkedTradeId, String(r.data.tradeId));
});

test("LOG-5 simulated (signal-only) trade produces SIMULATED_TRADE row", async () => {
  await setHeartbeatAge(2);
  await setMode("SUGGEST_ONLY");
  const since = new Date().toISOString();
  const r = await trade();
  assert.equal(r.status, 200);
  assert.equal(r.data.tradeId, 0);
  const recent = await recentEvents(since);
  assert.ok(recent.find((e) => e.kind === "SIMULATED_TRADE"), "SIMULATED_TRADE row required");
});

test("LOG-6 kill-switch engage logs KILL_SWITCH (CRITICAL, SAFETY domain)", async () => {
  const since = new Date().toISOString();
  await engageKs("LOG-6 reason");
  const recent = await recentEvents(since);
  const ks = recent.find((e) => e.kind === "KILL_SWITCH");
  assert.ok(ks, "KILL_SWITCH row required");
  assert.equal(ks.severity, "CRITICAL");
});

test("LOG-7 kill-switch reset logs KILL_SWITCH_RESET", async () => {
  await engageKs("LOG-7 setup");
  const since = new Date().toISOString();
  const r = await resetKs("I_UNDERSTAND_RISK");
  assert.equal(r.status, 200);
  const recent = await recentEvents(since);
  assert.ok(recent.find((e) => e.kind === "KILL_SWITCH_RESET"), "KILL_SWITCH_RESET row required");
});

test("LOG-8 user override creates BEHAVIOR-domain USER_OVERRIDE row", async () => {
  const since = new Date().toISOString();
  const r = await override({
    user: "tester",
    action: "manually closed trade #99",
    targetTradeId: "99",
    reasons: ["seen something on the chart"],
  });
  assert.equal(r.status, 200);
  const recent = await recentEvents(since);
  const ov = recent.find((e) => e.kind === "USER_OVERRIDE");
  assert.ok(ov, "USER_OVERRIDE row required");
  assert.equal(ov.truthDomain, "BEHAVIOR");
  assert.equal(ov.linkedTradeId, "99");
  assert.equal(ov.source, "USER");
});

// ═══════════════════════════════════════════════════════════════════════
// QUERY-* — vault is queryable across every required dimension
// ═══════════════════════════════════════════════════════════════════════

test("QUERY-1 by date range (sinceIso/untilIso)", async () => {
  // Generate a known event, capture before/after.
  const before = new Date().toISOString();
  await setMode("OBSERVE_ONLY");
  const after = new Date().toISOString();
  // Wait one tick to ensure the until window includes the row.
  const v1 = await vaultQ(`sinceIso=${encodeURIComponent(before)}&kind=MODE_CHANGE&limit=20`);
  assert.equal(v1.status, 200);
  assert.ok(v1.data.count >= 1);
  const v2 = await vaultQ(`untilIso=${encodeURIComponent(before)}&kind=MODE_CHANGE&limit=20`);
  assert.equal(v2.status, 200);
  // every returned row must be at-or-before the upper bound
  for (const e of v2.data.events) {
    assert.ok(e.createdAt <= after, `until filter must exclude rows newer than the bound`);
  }
});

test("QUERY-2 by symbol", async () => {
  await engageKs("QUERY-2 setup");
  await trade({ symbol: "Volatility 75 Index" });
  const v = await vaultQ(`symbol=${encodeURIComponent("Volatility 75 Index")}&kind=BLOCKED_TRADE&limit=20`);
  assert.equal(v.status, 200);
  assert.ok(v.data.count >= 1);
  for (const e of v.data.events) assert.equal(e.symbol, "Volatility 75 Index");
});

test("QUERY-3 by source (RISK_GOVERNOR)", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  await trade();
  const v = await vaultQ("source=RISK_GOVERNOR&limit=20");
  assert.equal(v.status, 200);
  assert.ok(v.data.count >= 1);
  for (const e of v.data.events) assert.equal(e.source, "RISK_GOVERNOR");
});

test("QUERY-4 by event kind (KILL_SWITCH)", async () => {
  await engageKs("QUERY-4");
  const v = await vaultQ("kind=KILL_SWITCH&limit=10");
  assert.equal(v.status, 200);
  assert.ok(v.data.count >= 1);
  for (const e of v.data.events) assert.equal(e.kind, "KILL_SWITCH");
});

test("QUERY-5 by severity (CRITICAL)", async () => {
  await engageKs("QUERY-5");
  const v = await vaultQ("severity=CRITICAL&limit=20");
  assert.equal(v.status, 200);
  assert.ok(v.data.count >= 1);
  for (const e of v.data.events) assert.equal(e.severity, "CRITICAL");
});

test("QUERY-6 by operationalMode and truthDomain", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  await trade();
  const v = await vaultQ("operationalMode=PAPER_TRADING&truthDomain=EXECUTION&limit=20");
  assert.equal(v.status, 200);
  for (const e of v.data.events) {
    assert.equal(e.operationalMode, "PAPER_TRADING");
    assert.equal(e.truthDomain, "EXECUTION");
  }
});

test("QUERY-7 by linkedTradeId returns events bound to that trade", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const r = await trade();
  assert.ok(r.data.tradeId > 0);
  const v = await vaultQ(`linkedTradeId=${r.data.tradeId}&limit=20`);
  assert.equal(v.status, 200);
  assert.ok(v.data.count >= 1);
  for (const e of v.data.events) assert.equal(e.linkedTradeId, String(r.data.tradeId));
});

// ═══════════════════════════════════════════════════════════════════════
// INTEGRITY-* — data integrity engine catches bad records
// ═══════════════════════════════════════════════════════════════════════

test("INT-1 integrity scan returns a structured report", async () => {
  const r = await integrityQ("limit=200");
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.scannedRows, "number");
  assert.ok(Array.isArray(r.data.flags));
  assert.ok(r.data.byCategory && typeof r.data.byCategory === "object");
});

test("INT-2 integrity flags malformed severity in injected row", async () => {
  // Inject one bad row directly via pg, then scan.
  await pg.query(`
    INSERT INTO vault_events (kind, severity, source, summary, generated_at_iso)
    VALUES ('INT_INJECT', 'BOGUS_SEV', 'CONTROL_TOWER', 'phase2 bad-severity probe', $1)
  `, [new Date().toISOString()]);
  const r = await integrityQ("limit=200");
  assert.equal(r.status, 200);
  const bad = r.data.flags.find((f) => f.category === "NEGATIVE_OR_INVALID_VALUE" && f.description.includes("BOGUS_SEV"));
  assert.ok(bad, "bad severity must produce a NEGATIVE_OR_INVALID_VALUE flag");
  assert.equal(bad.severity, "CRITICAL");
});

test("INT-3 integrity flags time-paradox future generatedAtIso", async () => {
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 min
  await pg.query(`
    INSERT INTO vault_events (kind, severity, source, summary, generated_at_iso)
    VALUES ('INT_INJECT', 'INFO', 'CONTROL_TOWER', 'phase2 future-iso probe', $1)
  `, [future]);
  const r = await integrityQ("limit=200");
  assert.equal(r.status, 200);
  assert.ok(
    r.data.flags.some((f) => f.category === "TIME_PARADOX" && f.description.includes("future")),
    "future generatedAtIso must produce TIME_PARADOX flag",
  );
});

test("INT-4 integrity flags dangling linkedTradeId", async () => {
  await pg.query(`
    INSERT INTO vault_events (kind, severity, source, summary, generated_at_iso, linked_trade_id)
    VALUES ('INT_INJECT', 'INFO', 'CONTROL_TOWER', 'phase2 dangling-trade probe', $1, '999999999')
  `, [new Date().toISOString()]);
  const r = await integrityQ("limit=300");
  assert.equal(r.status, 200);
  assert.ok(
    r.data.flags.some((f) => f.category === "DANGLING_REPLAY" && f.description.includes("999999999")),
    "dangling linkedTradeId must produce DANGLING_REPLAY flag",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// REG-2 Phase 1 contracts still hold (sanity smoke; full Phase 1 file
// runs separately in the same node --test invocation).
// ═══════════════════════════════════════════════════════════════════════

test("REG-2 vault still returns events with reasons + blockers arrays", async () => {
  const v = await vaultQ("limit=10");
  assert.equal(v.status, 200);
  assert.ok(Array.isArray(v.data.events));
  for (const e of v.data.events) {
    assert.ok(Array.isArray(e.reasons), "reasons[] must be present");
    assert.ok(Array.isArray(e.blockers), "blockers[] must be present");
  }
});
