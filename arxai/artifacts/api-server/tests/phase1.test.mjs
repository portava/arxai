// Phase 1 — Full Safety Verification suite, organized by the 6 systems the
// product spec calls out: Control Tower, Risk Governor, Kill Switch,
// Resilience Engine, Black Box Vault, Recovery Mode.
//
// Runs against the live API server (proxied via localhost:80). Uses pg to
// inject MT5 heartbeat rows so we can exercise the "healthy MT5" code paths
// the bridge would normally produce. No production code is mocked.
//
// Usage: pnpm --filter @workspace/api-server run test
//        (api-server workflow must be running)

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import pkg from "pg";

const { Client } = pkg;
const BASE = process.env.API_BASE_URL ?? "http://localhost:80/api";

// ── HTTP helpers ─────────────────────────────────────────────────────────
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
const status = () => j("GET", "/system/status");
const setMode = (mode) => j("POST", "/system/mode", { mode, changedBy: "phase1-suite" });
const engageKs = (reason) => j("POST", "/system/kill-switch/engage", { reason, triggeredBy: "phase1-suite" });
const resetKs = (ack = "I_UNDERSTAND_RISK") => j("POST", "/system/kill-switch/reset", { acknowledgement: ack, resetBy: "phase1-suite" });
const vault = (limit = 80) => j("GET", `/system/vault?limit=${limit}`);
const transitions = (limit = 80) => j("GET", `/system/state-transitions?limit=${limit}`);
const trade = (overrides = {}) => j("POST", "/execute-trade", {
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

// ── Direct DB helpers (only used to simulate MT5 heartbeat freshness) ────
let pg;
before(async () => {
  pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const s = await status();
  assert.equal(s.status, 200, "API server must be reachable");
});
after(async () => { try { await pg.end(); } catch {} });

async function setHeartbeatAge(seconds) {
  // Upsert mt5_state.last_heartbeat to (now - seconds). Aligns with
  // safetyCore: <15s = OK, <60s = DEGRADED, >=60s = DOWN.
  const ts = new Date(Date.now() - seconds * 1000);
  const exists = await pg.query("SELECT id FROM mt5_state LIMIT 1");
  if (exists.rows.length === 0) {
    await pg.query("INSERT INTO mt5_state (last_heartbeat_at) VALUES ($1)", [ts]);
  } else {
    await pg.query("UPDATE mt5_state SET last_heartbeat_at = $1", [ts]);
  }
}
async function clearHeartbeat() {
  const exists = await pg.query("SELECT id FROM mt5_state LIMIT 1");
  if (exists.rows.length === 0) return;
  await pg.query("UPDATE mt5_state SET last_heartbeat_at = NULL");
}

// Force the safety_core singleton to a known clean baseline. We do this
// directly in the DB so RECOVERY_MODE / SAFE_SHUTDOWN sticky states left
// over from a previous test cannot poison the next one.
async function resetSafetyCore() {
  await pg.query(`
    UPDATE safety_core SET
      operational_mode = 'PAPER_TRADING',
      global_state = 'NORMAL',
      kill_switch_engaged = false,
      kill_switch_engaged_at = NULL,
      kill_switch_reason = NULL,
      updated_at = NOW()
  `);
}

beforeEach(async () => {
  // Force a clean baseline directly in the DB to defeat sticky states
  // (RECOVERY_MODE / SAFE_SHUTDOWN) from a previous test.
  await resetSafetyCore();
  await clearHeartbeat();
});

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM 1 — CONTROL TOWER
// ═══════════════════════════════════════════════════════════════════════

test("CT-1 Control Tower confirms current system mode via /system/status", async () => {
  await setMode("SUGGEST_ONLY");
  const s = await status();
  assert.equal(s.status, 200);
  assert.equal(s.data.operationalMode, "SUGGEST_ONLY");
  assert.equal(typeof s.data.globalState, "string");
  assert.ok(Array.isArray(s.data.allowedModes));
  assert.ok(s.data.effectiveProfile && typeof s.data.effectiveProfile.executionPermission === "string");
});

test("CT-2 OBSERVE_ONLY records signal but never books a trade", async () => {
  await setHeartbeatAge(2);
  await setMode("OBSERVE_ONLY");
  const r = await trade();
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.equal(r.data.tradeId, 0, "no trade row should be created in OBSERVE_ONLY");
  assert.equal(r.data.mode, "OBSERVE_ONLY");
});

test("CT-3 SUGGEST_ONLY records signal but never books a trade", async () => {
  await setHeartbeatAge(2);
  await setMode("SUGGEST_ONLY");
  const r = await trade();
  assert.equal(r.status, 200);
  assert.equal(r.data.tradeId, 0);
  assert.equal(r.data.mode, "SUGGEST_ONLY");
});

test("CT-4 PAPER_TRADING books a trade when state is healthy", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const r = await trade();
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.success, true);
  assert.ok(r.data.tradeId > 0, "PAPER trade should produce a trade row");
  assert.equal(r.data.mode, "PAPER_TRADING");
});

test("CT-5 LIVE_TRADING refused unless conditions safe (MT5 must be OK + healthy state)", async () => {
  await clearHeartbeat();
  const bad = await setMode("LIVE_TRADING");
  assert.equal(bad.status, 409, "LIVE must be rejected when MT5 is DOWN");
  assert.ok(bad.data.blockers.some((b) => /LIVE_TRADING|MT5/i.test(b)));
});

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM 2 — RISK GOVERNOR
// ═══════════════════════════════════════════════════════════════════════

test("RG-1 low-confidence trade blocked by Risk Governor confidence floor", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const r = await trade({ confidence: 10 });
  assert.equal(r.status, 409);
  assert.equal(r.data.decision, "HARD_BLOCK");
  assert.ok(r.data.blockers.some((b) => /confidence/i.test(b)));
});

test("RG-2 cannot bypass: high confidence still blocked when state is non-trading", async () => {
  // No heartbeat → DEGRADED_MODE → non-trading state.
  await clearHeartbeat();
  await setMode("PAPER_TRADING");
  const r = await trade({ confidence: 99 });
  assert.equal(r.status, 409, "even confidence=99 must be blocked when state forbids");
  assert.equal(r.data.decision, "HARD_BLOCK");
  assert.ok(r.data.blockers.some((b) => /global state/i.test(b)));
});

test("RG-3 every trade flows through tradeGate (TRADE_GATE vault entry exists)", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const sinceIso = new Date().toISOString();
  await trade();
  const v = await vault(50);
  const recent = v.data.events
    .filter((e) => new Date(e.createdAt).toISOString() >= sinceIso);
  assert.ok(
    recent.some((e) => e.kind === "TRADE_GATE"),
    "every trade attempt must produce a TRADE_GATE vault entry",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM 3 — KILL SWITCH
// ═══════════════════════════════════════════════════════════════════════

test("KS-1 engage immediately disables all execution", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  await engageKs("KS-1 unit test");
  const r = await trade();
  assert.equal(r.status, 409);
  assert.ok(r.data.blockers.some((b) => /kill switch/i.test(b)));
});

test("KS-2 engage logs reason in vault", async () => {
  await engageKs("liquidity gap detected");
  const v = await vault(20);
  const ks = v.data.events.find((e) => e.kind === "KILL_SWITCH");
  assert.ok(ks, "KILL_SWITCH vault entry must exist");
  assert.ok(
    JSON.stringify(ks).includes("liquidity gap detected"),
    "reason text must be persisted in the vault entry",
  );
});

test("KS-3 engage forces SAFE_SHUTDOWN (LOCKDOWN-equivalent) and collapses allowed modes", async () => {
  await engageKs("KS-3 lockdown test");
  const s = await status();
  assert.equal(s.data.killSwitchEngaged, true);
  assert.equal(s.data.globalState, "SAFE_SHUTDOWN");
  assert.equal(s.data.operationalMode, "OBSERVE_ONLY");
  assert.deepEqual([...s.data.allowedModes], ["OBSERVE_ONLY"]);
});

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM 4 — RESILIENCE ENGINE
// ═══════════════════════════════════════════════════════════════════════

test("RE-1 MT5 heartbeat fresh → mt5LinkHealth=OK", async () => {
  await setHeartbeatAge(2);
  // Touch the gate so driveGlobalState runs.
  await trade();
  const s = await status();
  assert.equal(s.data.mt5LinkHealth, "OK");
});

test("RE-2 MT5 heartbeat stale (16s) → DEGRADED link + DEGRADED_MODE", async () => {
  await setHeartbeatAge(16);
  await trade();
  const s = await status();
  assert.equal(s.data.mt5LinkHealth, "DEGRADED");
  assert.equal(s.data.globalState, "DEGRADED_MODE");
});

test("RE-3 MT5 heartbeat dead (61s) → DOWN link + SAFE_SHUTDOWN (LOCKDOWN)", async () => {
  await setHeartbeatAge(61);
  await trade();
  const s = await status();
  assert.equal(s.data.mt5LinkHealth, "DOWN");
  assert.equal(s.data.globalState, "SAFE_SHUTDOWN");
});

test("RE-4 resilience event written as STATE_TRANSITION when link degrades", async () => {
  await setHeartbeatAge(2);
  await trade(); // forces NORMAL
  await setHeartbeatAge(61);
  await trade(); // forces SAFE_SHUTDOWN
  const t = await transitions(50);
  assert.ok(
    t.data.transitions.some((x) => x.toState === "SAFE_SHUTDOWN"),
    "resilience-driven SAFE_SHUTDOWN transition must be recorded",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM 5 — BLACK BOX VAULT
// ═══════════════════════════════════════════════════════════════════════

test("V-1 every mode change is logged", async () => {
  const sinceIso = new Date().toISOString();
  await setMode("OBSERVE_ONLY");
  await setMode("SUGGEST_ONLY");
  const v = await vault(30);
  const recent = v.data.events.filter((e) => new Date(e.createdAt).toISOString() >= sinceIso);
  const modeChanges = recent.filter((e) => e.kind === "MODE_CHANGE");
  assert.ok(modeChanges.length >= 2, `expected ≥2 MODE_CHANGE events, got ${modeChanges.length}`);
});

test("V-2 every blocked action is logged (TRADE_GATE with HARD_BLOCK)", async () => {
  await engageKs("V-2 test");
  const sinceIso = new Date().toISOString();
  await trade();
  const v = await vault(30);
  const recent = v.data.events.filter((e) => new Date(e.createdAt).toISOString() >= sinceIso);
  const blockedTrade = recent.find((e) => e.kind === "TRADE_GATE");
  assert.ok(blockedTrade, "blocked trade must be logged as TRADE_GATE");
  assert.ok(
    blockedTrade.blockers && blockedTrade.blockers.length > 0,
    "blocked trade vault entry must include blockers",
  );
});

test("V-3 every risk decision is logged (TRADE_GATE entries include RG reasons)", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const sinceIso = new Date().toISOString();
  await trade({ confidence: 5 });
  const v = await vault(30);
  const recent = v.data.events.filter((e) => new Date(e.createdAt).toISOString() >= sinceIso);
  const riskEntry = recent.find((e) => e.kind === "TRADE_GATE");
  assert.ok(riskEntry, "risk decision must produce a TRADE_GATE entry");
  assert.equal(riskEntry.source, "RISK_GOVERNOR");
});

test("V-4 every resilience event is logged (STATE_TRANSITION rows + vault entry)", async () => {
  await setHeartbeatAge(2);
  await trade();
  await setHeartbeatAge(61);
  await trade();
  const v = await vault(30);
  const stateEvents = v.data.events.filter((e) => e.kind === "STATE_TRANSITION");
  assert.ok(stateEvents.length > 0, "resilience-driven state changes must produce vault entries");
  assert.ok(stateEvents.some((e) => e.source === "RESILIENCE"));
});

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM 6 — RECOVERY MODE
// ═══════════════════════════════════════════════════════════════════════

test("RC-1 reset reduces permissions (executionPermission != FULL)", async () => {
  await engageKs("RC-1 test");
  const r = await resetKs("I_UNDERSTAND_RISK");
  assert.equal(r.status, 200);
  const s = await status();
  const exec = s.data.effectiveProfile.executionPermission;
  assert.ok(
    ["NONE", "CLOSE_ONLY", "REDUCED"].includes(exec),
    `recovery should restrict execution, got ${exec}`,
  );
});

test("RC-2 LIVE execution blocked in recovery state", async () => {
  await engageKs("RC-2 test");
  await resetKs("I_UNDERSTAND_RISK");
  const s = await status();
  assert.ok(!s.data.allowedModes.includes("LIVE_TRADING"));
  const r = await setMode("LIVE_TRADING");
  assert.equal(r.status, 409);
});

test("RC-3 reset requires explicit acknowledgement (no silent recovery)", async () => {
  await engageKs("RC-3 test");
  for (const ack of ["", "yes", "ok", "I-understand-risk"]) {
    const r = await resetKs(ack);
    // Zod schema may reject empty string with 400 before handler returns 409;
    // either rejection path is correct — what matters is the kill switch stays on.
    assert.ok([400, 409].includes(r.status), `ack='${ack}' must be rejected (got ${r.status})`);
  }
  const s = await status();
  assert.equal(s.data.killSwitchEngaged, true, "kill switch must remain engaged");
});

// ═══════════════════════════════════════════════════════════════════════
// REGRESSION — pre-existing app surface unchanged
// ═══════════════════════════════════════════════════════════════════════

test("REG-1 existing endpoints (/healthz, /bot/status) still respond", async () => {
  const h = await j("GET", "/healthz");
  assert.equal(h.status, 200);
  const b = await j("GET", "/bot/status");
  assert.equal(b.status, 200);
});
