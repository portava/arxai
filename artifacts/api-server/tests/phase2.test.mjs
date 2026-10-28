// Phase 2 — Data + Memory Core verification suite.
//
// Goal: every required category produces a vault event with the right
// shape, every query dimension works, and the integrity engine actually
// flags bad rows. Runs against the live API server (proxied via :80) plus
// direct Postgres for setup/teardown.
//
// Usage: pnpm --filter @workspace/api-server run test
//        (api-server workflow must be running)

// Owner decision 14 (2026-10-25): POST /execute-trade is retired (410
// EXECUTE_TRADE_RETIRED, nothing recorded; see execute-trade-retired.test.mjs).
// The cases that produced vault rows through it now produce the same event
// through the governed paths that replaced it (support/governed.mjs;
// docs/TIER1_TRADE_ENGINE_MODES.md round 5) and still assert the vault row
// and query this suite requires. The legacy vault trade loggers have no
// runtime caller since the retirement (lib/vaultLogger.ts logBlockedTrade /
// logApprovedTrade / logPaperTrade / logSimulatedTrade; round 5 "What
// remains" 1), so the cases a governed path does not cover fail; they are
// not relaxed to match the code.
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

// LOG-2: a blocked trade produces a vault row carrying its symbol and
// blockers. Governed block: POST /paper/orders refused by the Risk Governor
// (kill switch). The governor audits it in user_risk_events (phase1 V-2);
// nothing writes it to the vault (lib/tradeEngine/paperVenue.ts
// openPaperOrder returns governorRefusal without a vault row).
test("LOG-2 blocked governed trade produces a vault row with its symbol and blockers", async () => {
  const t = await freshTrader(pg, "phase2-LOG-2");
  await engageKs("LOG-2 test");
  const since = new Date().toISOString();
  const r = await paperOrder(t, { symbol: "Volatility 75 Index" });
  assert.equal(r.status, 422, "precondition: the governed path refused the order");
  const recent = await recentEvents(since);
  const blocked = recent.find((e) => e.symbol === "Volatility 75 Index" && e.blockers.length > 0);
  assert.ok(blocked, `a vault row for the blocked order is required; vault kinds since the attempt: ${JSON.stringify(recent.map((e) => e.kind))}`);
  assert.equal(blocked.truthDomain, "DECISION");
});

// LOG-3: an approved LIVE trade is recorded with a link to its execution.
// Trading stays disabled in this lane, so a LIVE approval cannot happen here;
// LOG-3b keeps the recording requirement. This case drives the governed LIVE
// path (Trade Action Center) as far as it goes for a trader who has done
// everything a trader can: a live-typed MT5 connection row (no bridge token,
// no EA, so nothing could ever be delivered to it) and the live disclosure
// accepted. Routing and the account type then pass, and the Risk Governor
// step refuses the action as a trading halt because broker execution is
// disabled by the operator (lib/safety/tradingHalt.ts brokerControlBlocks:
// broker_health_state.execution_enabled, false by default and never set in
// this lane; it blocks new risk on DEMO / LIVE only). That is the safety
// gate, and it fires before any venue queue. Behind it the server master
// switch is off too (ARX_LIVE_BROKER_EXECUTION_ENABLED=false, asserted below)
// and the trader is not armed for live. The refusal must be recorded against
// the action and in the Risk Governor audit, and nothing may reach a broker
// queue, reservation or live intent. The platform venue switch is open here
// only because the seeded global_trading_settings default is LIVE with
// live_enabled; the lane never changes it.
const LIVE_SIDE_EFFECTS = [
  "arx_live_commands", "arx_live_positions", "arx_dispatch_exposure_reservations", "live_intents",
  "mt5_commands", "mt5_demo_commands", "live_trade_approvals", "trades", "paper_orders", "execution_events",
];
test("LOG-3 governed LIVE action with a resolved connection is refused by the broker-execution halt, recorded, and queues nothing", async () => {
  await setHeartbeatAge(2);
  const diag = await j("GET", "/admin/live-gates/diagnostic");
  assert.equal(diag.status, 200, JSON.stringify(diag.data));
  const master = (diag.data.gates ?? []).find((g) => g.id === "server_master_switch");
  assert.equal(master?.rawCode, "BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED", `the server master switch is off in this lane: ${JSON.stringify(master)}`);

  const t = await freshTrader(pg, "phase2-LOG-3");
  await pg.query(
    `INSERT INTO mt5_connection (user_id, connection_name, status, account_type, account_number, broker_name, account_balance, account_equity, free_margin, last_heartbeat)
     VALUES ($1, 'legacy lane: no bridge token, no EA', 'connected', 'live', 'LANE0003', 'none', 10000, 10000, 10000, NOW())`,
    [t.id],
  );
  await pg.query("INSERT INTO user_readiness_state (user_id, live_disclosure_accepted_at) VALUES ($1, NOW())", [t.id]);
  const before = await countRows(pg, LIVE_SIDE_EFFECTS);

  const unphrased = await tradeAction(t, "LIVE", { phrase: "" });
  assert.equal(unphrased.confirm.status, 400);
  assert.equal(unphrased.confirm.data.error, "live_confirmation_phrase_required");
  assert.equal(unphrased.confirm.data.action.status, "awaiting_confirmation", "without the phrase nothing is claimed");

  const live = await t.call("POST", `/me/trade-actions/${unphrased.id}/confirm`, { liveConfirmPhrase: "CONFIRM LIVE" });
  assert.equal(live.status, 400, JSON.stringify(live.data));
  assert.equal(live.data.error, "guard_rejected");
  const action = live.data.action;
  assert.equal(action.status, "rejected");
  assert.equal(action.requestedMode, "LIVE", "a LIVE request is never converted to another mode");
  for (const id of ["routing", "account_type"]) {
    assert.ok(action.guardResult.checks.find((c) => c.id === id)?.passed, `${id} passed: the refusal is not a missing connection`);
  }
  assert.equal(action.guardResult.failedCheckId, "risk_governor");
  assert.match(action.rejectionReason, /Broker execution is disabled by the operator/);
  assert.equal(action.executionVenue, null, "never handed to a venue queue");
  assert.equal(action.venueCommandId, null);

  const ev = (await riskEvents(t)).find((e) => e.details?.caller === "trade_action_guards" && e.details?.actionId === unphrased.id);
  assert.ok(ev, "the refusal has its Risk Governor audit row");
  assert.equal(ev.decision, "block");
  assert.ok(ev.details.blockedBy.includes("trading_halt"), JSON.stringify(ev.details.blockedBy));
  assert.match(JSON.stringify(ev.details), /Broker execution is disabled by the operator/, "the halt names the broker-execution control");

  const audit = await t.call("GET", `/me/trade-actions/${unphrased.id}/audit`);
  assert.equal(audit.status, 200);
  assert.equal(audit.data.action.id, unphrased.id, "the audit is bound to the action");
  const text = JSON.stringify(audit.data);
  assert.ok(text.includes("action_confirmed") && text.includes("action_guard_rejected"), "confirm and refusal are on the action's timeline");
  assert.deepEqual(await countRows(pg, LIVE_SIDE_EFFECTS), before,
    "no live command, position, exposure reservation, live intent, broker command, approval, trade, order or execution row");
});

// LOG-3b keeps the original requirement: an approved LIVE trade is recorded
// in the vault (APPROVED_TRADE, truthDomain EXECUTION, linkedTradeId). It
// cannot be exercised without arming a trader and enabling live broker
// execution, which this lane must never do. It is also not met in the code:
// no file on the governed LIVE path writes the vault (lib/live/*,
// lib/tradeEngine/pipeline.ts, routes/meLive.ts, routes/mt5Live*.ts), and
// lib/vaultLogger.ts logApprovedTrade has no caller (open gap 2 in
// docs/TIER1_TRADE_ENGINE_MODES.md).
test("LOG-3b approved LIVE trade produces an APPROVED_TRADE vault row linked to its execution",
  { skip: "not exercisable: needs an armed trader and live broker execution enabled; open gap 2 (no LIVE-path vault writer)" },
  () => {});

// LOG-4: a paper trade produces a vault row linked to the trade
// (linkedTradeId). Governed: POST /paper/orders writes PAPER_ORDER_PLACED with
// the order id in its payload; the vault's linked_trade_id column is not set
// (lib/tradeEngine/paperVenue.ts vaultBehavior).
test("LOG-4 governed paper order produces a vault row linked to the order (linkedTradeId)", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const t = await freshTrader(pg, "phase2-LOG-4");
  const since = new Date().toISOString();
  const r = await paperOrder(t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const recent = await recentEvents(since);
  const paper = recent.find((e) => e.kind === "PAPER_ORDER_PLACED" && e.payload?.orderId === r.data.order.id);
  assert.ok(paper, "a vault row for the paper order is required");
  assert.equal(paper.payload.simulated, true);
  assert.equal(paper.linkedTradeId, String(r.data.order.id), "the vault row must be linked to the order through linkedTradeId");
});

// LOG-5: a signal-only outcome (SUGGEST_ONLY) is recorded in the vault and
// nothing is booked. No governed path reads the Safety Core mode (see phase1
// CT-2/CT-3) and none writes a signal-only vault row.
test("LOG-5 signal-only (SUGGEST_ONLY) governed attempt books nothing and is recorded in the vault", async () => {
  await setHeartbeatAge(2);
  await setMode("SUGGEST_ONLY");
  const t = await freshTrader(pg, "phase2-LOG-5");
  const since = new Date().toISOString();
  const r = await paperOrder(t);
  const recent = await recentEvents(since);
  assert.deepEqual(await paperOrdersOf(pg, t.id), [], `SUGGEST_ONLY must not book (got HTTP ${r.status})`);
  assert.ok(recent.find((e) => e.kind === "SIMULATED_TRADE"), "a signal-only vault row is required");
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

// QUERY-2/3: the vault is queryable by symbol and by source for trade
// decisions. The governed decision is made and audited (user_risk_events),
// but no vault row carries its symbol or the RISK_GOVERNOR source.
test("QUERY-2 by symbol finds the governed blocked trade", async () => {
  const t = await freshTrader(pg, "phase2-QUERY-2");
  await engageKs("QUERY-2 setup");
  const since = new Date().toISOString();
  const r = await paperOrder(t, { symbol: "Volatility 75 Index" });
  assert.equal(r.status, 422, "precondition: the governed path refused the order");
  const v = await vaultQ(`symbol=${encodeURIComponent("Volatility 75 Index")}&sinceIso=${encodeURIComponent(since)}&limit=20`);
  assert.equal(v.status, 200);
  assert.ok(v.data.count >= 1, "the blocked trade must be queryable by symbol");
  for (const e of v.data.events) assert.equal(e.symbol, "Volatility 75 Index");
});

test("QUERY-3 by source (RISK_GOVERNOR) finds the governed risk decision", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const t = await freshTrader(pg, "phase2-QUERY-3");
  const since = new Date().toISOString();
  const r = await paperOrder(t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const v = await vaultQ(`source=RISK_GOVERNOR&sinceIso=${encodeURIComponent(since)}&limit=20`);
  assert.equal(v.status, 200);
  assert.ok(v.data.count >= 1, "the Risk Governor's decision must be queryable by source");
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
  await paperOrder(await freshTrader(pg, "phase2-QUERY-6"));
  const v = await vaultQ("operationalMode=PAPER_TRADING&truthDomain=EXECUTION&limit=20");
  assert.equal(v.status, 200);
  for (const e of v.data.events) {
    assert.equal(e.operationalMode, "PAPER_TRADING");
    assert.equal(e.truthDomain, "EXECUTION");
  }
});

// QUERY-7: the vault is queryable by linkedTradeId for a booked trade.
// Governed: the paper order's vault row carries the id only in its payload
// (see LOG-4), so the linkedTradeId filter cannot find it.
test("QUERY-7 by linkedTradeId returns events bound to the governed paper order", async () => {
  await setHeartbeatAge(2);
  await setMode("PAPER_TRADING");
  const t = await freshTrader(pg, "phase2-QUERY-7");
  const r = await paperOrder(t);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const id = r.data.order.id;
  const v = await vaultQ(`linkedTradeId=${id}&limit=20`);
  assert.equal(v.status, 200);
  assert.ok(v.data.count >= 1, `vault events bound to paper order ${id} are required`);
  for (const e of v.data.events) assert.equal(e.linkedTradeId, String(id));
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
