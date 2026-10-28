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

// Owner decision 14 (2026-10-25): POST /execute-trade is retired (410
// EXECUTE_TRADE_RETIRED, nothing recorded; see execute-trade-retired.test.mjs).
// The cases that drove the Safety Core through it now assert the same safety
// requirement against the governed paths that replaced it (support/governed.mjs;
// docs/TIER1_TRADE_ENGINE_MODES.md round 5): PAPER through POST /paper/orders,
// SIMULATED / DEMO / LIVE through the Trade Action Center, decisions audited in
// the Risk Governor's user_risk_events. Where a governed path does not enforce
// the original requirement the case still asserts it and fails; it is not
// relaxed to match the code.
//
// Usage (isolated: disposable database, no background workers, no external
// connections): pnpm --filter @workspace/api-server run test:isolated-server-lane

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import pkg from "pg";
import {
  BASE, freshTrader, paperOrder, paperOrdersOf, riskEvents, tradeAction, countRows,
} from "./support/governed.mjs";

const { Client } = pkg;

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

// Original requirement (CT-2/CT-3): while the Safety Core is in OBSERVE_ONLY
// or SUGGEST_ONLY the platform only records signals and never books a trade.
// Governed PAPER path: POST /paper/orders. It does not read the operational
// mode (routes/paperTrading.ts header, lib/tradeEngine/paperVenue.ts
// openPaperOrder, lib/safety/tradingHalt.ts reads only the kill switches), so
// these cases fail until a governed path honours the mode.
async function assertModeNeverBooks(mode) {
  await setHeartbeatAge(2);
  assert.equal((await setMode(mode)).status, 200);
  assert.equal((await status()).data.operationalMode, mode, "precondition: Safety Core mode set");
  const t = await freshTrader(pg, `phase1-${mode}`);
  const r = await paperOrder(t);
  assert.deepEqual(await paperOrdersOf(pg, t.id), [], `${mode}: no paper order may be booked (got HTTP ${r.status})`);
  assert.notEqual(r.status, 200, `${mode}: POST /paper/orders must refuse`);
}

test("CT-2 OBSERVE_ONLY never books a trade on the governed PAPER path", async () => {
  await assertModeNeverBooks("OBSERVE_ONLY");
});

test("CT-3 SUGGEST_ONLY never books a trade on the governed PAPER path", async () => {
  await assertModeNeverBooks("SUGGEST_ONLY");
});

test("CT-4 PAPER_TRADING books a paper order through the governed path when state is healthy", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const t = await freshTrader(pg, "phase1-CT-4");
  const r = await paperOrder(t);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.data)}`);
  assert.equal(r.data.simulated, true, "a paper order is labelled simulated");
  assert.ok(r.data.order.id > 0, "PAPER order should produce a paper_orders row");
  assert.equal(r.data.order.status, "OPEN");
  const rows = await paperOrdersOf(pg, t.id);
  assert.deepEqual(rows.map((o) => o.id), [r.data.order.id], "exactly the one booked order, owned by the trader");
  const listed = await t.call("GET", `/paper/orders?accountId=${t.accountId}`);
  assert.ok(listed.data.orders.some((o) => o.id === r.data.order.id), "the order is readable on the governed history");
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

// Original requirement (RG-1): an order below the Risk Governor's confidence
// floor is hard-blocked. In the governed engine the floor is a venue rule
// (preTrade.ts, VenueRules.minAiConfidence) applied to AI-originated orders.
// Only the simulator OMS sets it (70, lib/oms.ts SIMULATOR_VENUE_RULES), and
// POST /orders/create is its entry (operator only, so via the owner proxy).
// This case covers that entry only: it is not one of the replacement paths
// the 410 body names. Those are RG-1b (open gap).
test("RG-1 low-confidence AI order blocked by the Risk Governor confidence floor", async () => {
  const q = await j("GET", "/market/quote/EURUSD");
  assert.equal(q.status, 200);
  const px = q.data.ask;
  const order = (confidenceScore) => j("POST", "/orders/create", {
    environment: "PAPER", source: "AI_AUTO", symbol: "EURUSD", direction: "BUY", lotSize: 0.01,
    stopLoss: px * 0.99, takeProfit: px * 1.03, confidenceScore,
  });
  const low = await order(10);
  assert.equal(low.status, 201, JSON.stringify(low.data));
  assert.equal(low.data.status, "RISK_REJECTED");
  assert.equal(low.data.governance.allowed, false);
  assert.ok(low.data.governance.blockedBy.includes("trading_discipline"));
  assert.match(low.data.rejectionReason, /RISK_GOVERNOR_BLOCK/);
  const ev = (await j("GET", "/me/risk/events")).data.events.find((e) => e.id === low.data.governance.auditEventId);
  assert.ok(ev, "the refusal has its Risk Governor audit row");
  assert.equal(ev.decision, "block");
  const discipline = ev.details.rules.find((r) => r.rule === "trading_discipline");
  assert.equal(discipline.outcome, "BLOCK");
  assert.equal(discipline.measured.aiConfidence, 10);
  assert.match(JSON.stringify(discipline), /model confidence 10 is below the simulator_oms minimum of 70/);

  const high = await order(95);
  const evHigh = (await j("GET", "/me/risk/events")).data.events.find((e) => e.id === high.data.governance.auditEventId);
  assert.ok(evHigh, "the high-confidence decision is audited too");
  assert.equal(evHigh.details.rules.find((r) => r.rule === "trading_discipline").measured.aiConfidence, 95);
  assert.doesNotMatch(JSON.stringify(evHigh.details.rules), /model confidence/, "confidence 95 clears the floor");
});

// RG-1 on the replacement paths the 410 body names (open gap 4 in
// docs/TIER1_TRADE_ENGINE_MODES.md). A Ruby- or automation-originated
// SIMULATED open is judged by the guard chain's Risk Governor with origin
// ruby / automation (lib/tradeAction/confirm.ts, guards.ts 8b) and then
// routed to the PAPER venue (lib/tradeAction/route.ts routeSimulatedOpen),
// both without venue rules, so the preTrade.ts minAiConfidence branch never
// runs; the draft cannot even carry a model confidence (routes/
// meTradeActions.ts draftSchema strips it; preTrade.ts reads a missing one as
// 0). POST /paper/orders has no origin or confidence at all. The trader gets
// a fresh symbol snapshot (the quote source the guard's Risk Governor reads
// first, lib/riskGovernor/enforce.ts loadQuote) so the decision is not a
// stale-quote refusal. The PAPER venue still needs a real provider quote,
// which this offline lane has none of, so nothing books either way; the
// requirement asserted is the Risk Governor's decision. This case fails until
// a floor applies on these paths.
test("RG-1b Ruby / automation SIMULATED entry stays blocked pending an approved confidence policy", async () => {
  await setHeartbeatAge(2);
  for (const source of ["decision_engine", "ai_suggested"]) {
    const t = await freshTrader(pg, `phase1-RG-1b-${source}`);
    await pg.query(
      "INSERT INTO arx_symbol_specs (user_id, symbol, bid, ask, last_tick_time) VALUES ($1, 'EURUSD', 1.0999, 1.1001, NOW())",
      [t.id],
    );
    const { id, confirm } = await tradeAction(t, "SIMULATED", { source, extra: { confidence: 10, confidenceScore: 10 } });
    const ev = (await riskEvents(t)).find((e) => e.details?.caller === "trade_action_guards" && e.details?.actionId === id);
    assert.ok(ev, `${source}: the guard's Risk Governor decision is audited`);
    assert.equal(ev.decision, "block",
      `${source}: an AI-originated open with model confidence 10 must be blocked; got ${ev.decision}, blockedBy ${JSON.stringify(ev.details.blockedBy)}`);
    assert.match(ev.reason, /AI_ENTRY_POLICY_PENDING/, "blocked without inventing a confidence floor");
    assert.equal(confirm.status, 400, JSON.stringify(confirm.data));
    assert.equal(confirm.data.action.guardResult.failedCheckId, "risk_governor");
    assert.deepEqual(await paperOrdersOf(pg, t.id), [], "nothing booked");
  }
});

// Original requirement (RG-2): a non-trading global state blocks new trades;
// even confidence 99 cannot bypass it. Governed PAPER path: POST /paper/orders
// does not read the Safety Core global state (only the kill switches, via
// lib/safety/tradingHalt.ts), so this case fails until it does.
test("RG-2 cannot bypass: a non-trading Safety Core state blocks the governed PAPER path", async () => {
  await clearHeartbeat();
  await setMode("PAPER_TRADING");
  const s = await status();
  assert.ok(["DEGRADED_MODE", "SAFE_SHUTDOWN", "RECOVERY_MODE"].includes(s.data.globalState),
    `precondition: non-trading state, got ${s.data.globalState}`);
  const t = await freshTrader(pg, "phase1-RG-2");
  const r = await paperOrder(t);
  assert.deepEqual(await paperOrdersOf(pg, t.id), [], `no order may be booked in ${s.data.globalState} (got HTTP ${r.status})`);
  assert.notEqual(r.status, 200);
});

// Original requirement (RG-3): every trade attempt passes the trade gate and
// leaves a gate audit entry. Governed: every POST /paper/orders attempt that
// reaches the book runs enforcePreTradeRisk, which writes one user_risk_events
// row per decision, pass or block (lib/riskGovernor/enforce.ts, "No audit row,
// no trade"); a Trade Action confirm records its guard chain, whose
// risk_governor step writes its own row (lib/tradeAction/guards.ts 8b).
test("RG-3 every governed trade attempt passes the Risk Governor and leaves an audit row", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const t = await freshTrader(pg, "phase1-RG-3");
  const allowed = await paperOrder(t, { lotSize: 0.05 });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  await engageKs("RG-3 blocked attempt");
  const blocked = await paperOrder(t, { lotSize: 0.07 });
  assert.equal(blocked.status, 422);
  const events = (await riskEvents(t)).filter((e) => e.details?.caller === "POST /paper/orders");
  assert.equal(events.length, 2, "one audit row per attempt");
  assert.deepEqual(events.map((e) => e.decision).sort(), ["block", "pass"]);
  for (const e of events) assert.equal(e.details.source, "pre_trade_risk_governor");
  assert.equal(events.find((e) => e.decision === "block").id, blocked.data.auditEventId);

  await resetSafetyCore();
  const action = await tradeAction(t, "SIMULATED");
  const audit = await t.call("GET", `/me/trade-actions/${action.id}/audit`);
  assert.ok(audit.data.action.guardResult.checks.some((c) => c.id === "risk_governor"), "the confirm ran the Risk Governor step");
  assert.ok((await riskEvents(t)).some((e) => e.details?.caller === "trade_action_guards" && e.details?.actionId === action.id),
    "the trade action's Risk Governor decision is audited");
});

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM 3 — KILL SWITCH
// ═══════════════════════════════════════════════════════════════════════

// Original requirement (KS-1): engaging the kill switch immediately disables
// all execution. Governed: the safety-core kill switch halts PAPER new risk
// in the Risk Governor (lib/safety/tradingHalt.ts, trading_halt) and is the
// first refusing check of every Trade Action confirm, all modes
// (lib/tradeAction/guards.ts step 3).
test("KS-1 engage immediately disables execution on every governed path", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const t = await freshTrader(pg, "phase1-KS-1");
  await engageKs("KS-1 unit test");
  const before = await countRows(pg, ["paper_orders", "arx_live_commands", "mt5_commands", "mt5_demo_commands"]);
  const r = await paperOrder(t);
  assert.equal(r.status, 422);
  assert.equal(r.data.code, "RISK_GOVERNOR_BLOCK");
  assert.ok(r.data.blockedBy.includes("trading_halt"));
  assert.match(r.data.error, /kill switch/i);
  for (const mode of ["SIMULATED", "DEMO", "LIVE"]) {
    const a = await tradeAction(t, mode);
    assert.equal(a.confirm.status, 400, `${mode}: ${JSON.stringify(a.confirm.data)}`);
    assert.equal(a.confirm.data.error, "guard_rejected");
    assert.equal(a.confirm.data.action.status, "rejected");
    assert.equal(a.confirm.data.action.guardResult.failedCheckId, "kill_switch", `${mode} is refused by the kill switch check`);
    assert.match(a.confirm.data.action.rejectionReason, /Emergency stop is engaged/);
  }
  assert.deepEqual(await countRows(pg, ["paper_orders", "arx_live_commands", "mt5_commands", "mt5_demo_commands"]), before,
    "nothing booked and no broker command queued");
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
  // GET /system/status drives the state machine (routes/system.ts).
  await status();
  const s = await status();
  assert.equal(s.data.mt5LinkHealth, "OK");
});

test("RE-2 MT5 heartbeat stale (16s) → DEGRADED link + DEGRADED_MODE", async () => {
  await setHeartbeatAge(16);
  await status();
  const s = await status();
  assert.equal(s.data.mt5LinkHealth, "DEGRADED");
  assert.equal(s.data.globalState, "DEGRADED_MODE");
});

test("RE-3 MT5 heartbeat dead (61s) → DOWN link + SAFE_SHUTDOWN (LOCKDOWN)", async () => {
  await setHeartbeatAge(61);
  await status();
  const s = await status();
  assert.equal(s.data.mt5LinkHealth, "DOWN");
  assert.equal(s.data.globalState, "SAFE_SHUTDOWN");
});

test("RE-4 resilience event written as STATE_TRANSITION when link degrades", async () => {
  await setHeartbeatAge(2);
  await status(); // drives NORMAL
  await setHeartbeatAge(61);
  await status(); // drives SAFE_SHUTDOWN
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

// Original requirement (V-2): every blocked action is logged with its
// blockers. Governed: a refused PAPER order writes a blocked_trade row with
// blockedBy (lib/riskGovernor/enforce.ts) and returns its id; a refused Trade
// Action keeps its guard ledger and an action_guard_rejected timeline entry
// (lib/tradeAction/confirm.ts). Whether these also reach the Black Box vault
// is asserted in phase2.test.mjs (LOG-2, QUERY-2).
test("V-2 every blocked governed action is logged with its blockers", async () => {
  const t = await freshTrader(pg, "phase1-V-2");
  await engageKs("V-2 test");
  const r = await paperOrder(t);
  assert.equal(r.status, 422);
  const ev = (await riskEvents(t)).find((e) => e.id === r.data.auditEventId);
  assert.ok(ev, "blocked order must be logged");
  assert.equal(ev.eventType, "blocked_trade");
  assert.equal(ev.decision, "block");
  assert.equal(ev.severity, "critical");
  assert.ok(Array.isArray(ev.details.blockedBy) && ev.details.blockedBy.length > 0, "the log entry names its blockers");
  assert.ok(ev.reason.length > 0);

  const a = await tradeAction(t, "DEMO");
  const audit = await t.call("GET", `/me/trade-actions/${a.id}/audit`);
  assert.equal(audit.status, 200);
  assert.equal(audit.data.action.guardResult.passed, false);
  assert.ok(audit.data.action.guardResult.checks.some((c) => c.passed === false), "the guard ledger names the failed check");
  assert.ok(JSON.stringify(audit.data).includes("action_guard_rejected"), "the refusal is on the action's audit timeline");
});

// Original requirement (V-3): every risk decision is logged as a Risk
// Governor decision with its reasons. Governed: each pre-trade evaluation,
// pass or block, writes a user_risk_events row with source
// pre_trade_risk_governor and every rule's outcome (lib/riskGovernor/enforce.ts).
test("V-3 every governed risk decision is logged by the Risk Governor with its rule outcomes", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const t = await freshTrader(pg, "phase1-V-3");
  const ok = await paperOrder(t, { lotSize: 0.05 });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  await engageKs("V-3 block");
  const no = await paperOrder(t, { lotSize: 0.06 });
  assert.equal(no.status, 422);
  const events = (await riskEvents(t)).filter((e) => e.details?.caller === "POST /paper/orders");
  assert.equal(events.length, 2);
  for (const e of events) {
    assert.equal(e.details.source, "pre_trade_risk_governor");
    assert.equal(e.details.intent.venue, "PAPER");
    assert.ok(Array.isArray(e.details.rules) && e.details.rules.length >= 13, "every rule outcome is recorded");
  }
  assert.equal(events.find((e) => e.decision === "pass").eventType, "risk_check");
  assert.ok(events.find((e) => e.decision === "block").details.blockedBy.includes("trading_halt"));
});

test("V-4 every resilience event is logged (STATE_TRANSITION rows + vault entry)", async () => {
  await setHeartbeatAge(2);
  await status();
  await setHeartbeatAge(61);
  await status();
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
