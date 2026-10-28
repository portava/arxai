// Helpers for driving the governed trade paths that replaced the retired
// POST /execute-trade (owner decision 14; docs/TIER1_TRADE_ENGINE_MODES.md
// round 5) from the server-backed legacy lane:
//   PAPER       → POST /api/paper/orders (Trade Engine submitTrade, mode
//                 PAPER, pre-trade Risk Governor, paper simulator book)
//   SIMULATED / DEMO / LIVE → POST /api/me/trade-actions, then
//                 POST /api/me/trade-actions/:id/confirm (guard chain, Risk
//                 Governor, venue queue)
//   audit       → GET /api/me/risk/events (one user_risk_events row per
//                 Risk Governor decision) and /api/me/trade-actions/:id/audit
//
// Each test gets its own trader (a USER row plus a session, written straight
// to the lane's database like the heartbeat rows), so the Risk Governor's
// per-trader duplicate and position rules never see another test's orders.
// Trader calls go to ISOLATED_API_DIRECT_URL (the API without the owner
// proxy, set by scripts/isolated-lane/run.mjs) so they carry only the
// trader's own session; operator calls (mode, kill switch) go through the
// owner proxy (API_BASE_URL).
import { createHash, randomBytes } from "node:crypto";

export const BASE = process.env.API_BASE_URL ?? "http://localhost:80/api";
export const DIRECT = process.env.ISOLATED_API_DIRECT_URL ?? null;
const TRADER_BASE = DIRECT ?? BASE;

export async function call(base, method, path, body, cookie) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* tolerate */ }
  return { status: res.status, data };
}

let seq = 0;
/** A fresh USER with a session and an active paper account (balance 1,000,000). */
export async function freshTrader(pg, label) {
  const email = `qa+${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}-${++seq}@legacy-lane.test`;
  const { rows: [user] } = await pg.query(
    "INSERT INTO users (email, name, role, is_system_user) VALUES ($1, $2, 'USER', true) RETURNING id",
    [email, label],
  );
  const raw = randomBytes(32).toString("base64url");
  await pg.query(
    "INSERT INTO auth_user_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [user.id, createHash("sha256").update(raw).digest("hex"), new Date(Date.now() + 3_600_000)],
  );
  const t = { id: user.id, cookie: `arx_user_session=${raw}` };
  t.call = (method, path, body) => call(TRADER_BASE, method, path, body, t.cookie);
  const acct = await t.call("POST", "/paper/accounts", { accountName: label.slice(0, 64), startingBalance: 1_000_000 });
  if (acct.status !== 200) throw new Error(`paper account for ${label}: ${acct.status} ${JSON.stringify(acct.data)}`);
  t.accountId = acct.data.account.id;
  return t;
}

/** The paper simulator's current market price: a refused order reports it. */
export async function simulatorPrice(t, symbol) {
  const r = await t.call("POST", "/paper/orders", {
    paperAccountId: t.accountId, symbol, direction: "BUY", lotSize: 0.01, stopLoss: 1e12, takeProfit: 1e12,
  });
  if (r.status !== 400 || typeof r.data?.entryPrice !== "number") throw new Error(`price probe: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.entryPrice;
}

/** POST /api/paper/orders: a MARKET BUY with a 3% stop and a 6% target. */
export async function paperOrder(t, { symbol = "Volatility 75 Index", lotSize = 0.05 } = {}) {
  const px = await simulatorPrice(t, symbol);
  return t.call("POST", "/paper/orders", {
    paperAccountId: t.accountId, symbol, direction: "BUY", lotSize, stopLoss: px * 0.97, takeProfit: px * 1.06,
  });
}

/**
 * Create a Trade Action Center OPEN draft and confirm it in the given mode.
 * A LIVE confirm sends the typed phrase unless `phrase` is given ("" sends none).
 * `source` is the draft origin (ai_suggested = Ruby, decision_engine =
 * automation); `extra` adds body fields as sent.
 */
export async function tradeAction(t, mode, { symbol = "EURUSD", lotSize = 0.05, px = 1.1, phrase, source, extra = {} } = {}) {
  const created = await t.call("POST", "/me/trade-actions", {
    actionType: "OPEN", requestedMode: mode, symbol, side: "BUY", lotSize, stopLoss: px * 0.97, takeProfit: px * 1.06,
    ...(source ? { source } : {}), ...extra,
  });
  if (created.status !== 201) throw new Error(`trade action draft ${mode}: ${created.status} ${JSON.stringify(created.data)}`);
  const id = created.data.action.id;
  const typed = phrase ?? (mode === "LIVE" ? "CONFIRM LIVE" : "");
  const confirm = await t.call("POST", `/me/trade-actions/${id}/confirm`, { mode, ...(typed ? { liveConfirmPhrase: typed } : {}) });
  return { id, confirm };
}

/** The trader's Risk Governor audit rows, newest first. */
export async function riskEvents(t) {
  const r = await t.call("GET", "/me/risk/events");
  if (r.status !== 200) throw new Error(`risk events: ${r.status}`);
  return r.data.events;
}

/**
 * The tables a booked order, a queued broker command, an exposure reservation,
 * a live intent, a trade decision or an execution audit would write. Named so
 * a rename cannot silently drop one: countRows() refuses to run when one of
 * them is missing from the schema.
 */
export const EXECUTION_TABLES = [
  "trades", "paper_orders", "paper_trades", "paper_trade_events", "paper_executions", "paper_execution_logs",
  "arx_live_commands", "arx_live_positions", "arx_dispatch_exposure_reservations", "live_intents",
  "mt5_commands", "mt5_demo_commands", "live_positions", "position_events",
  "execution_events", "execution_confirmations", "live_trade_approvals", "live_trading_audit",
  "one_click_audit", "trade_command_audit_log", "trade_action_requests", "trade_decisions", "pre_trade_checks",
  "user_risk_events", "risk_governor_evaluations", "risk_governor_events",
  "self_trade_agent_executions", "self_trade_decisions", "self_trade_ledger_entries",
  "self_trade_agent_ledger", "self_trade_audit_log",
  "vault_events", "audit_events", "system_audit_logs",
];

/**
 * Tables a request may write without denoting any execution. Everything else
 * in the schema is counted, so a table added later is covered by default.
 * Empty today: in this lane an authenticated call to the retired endpoint
 * inserts no row at all, its auth and session handling included (RET-2 / 3).
 * Row counts only: an update in place is not detected.
 */
export const NON_EXECUTION_TABLES = new Set([]);

/** Every base table in the lane's schema except NON_EXECUTION_TABLES. */
export async function countedTables(pg) {
  const { rows } = await pg.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
  );
  const all = rows.map((r) => r.table_name);
  const missing = EXECUTION_TABLES.filter((t) => !all.includes(t));
  if (missing.length) throw new Error(`execution tables missing from the schema: ${missing.join(", ")}`);
  return all.filter((t) => !NON_EXECUTION_TABLES.has(t));
}

/** Row counts per table (one statement); every counted table by default. */
export async function countRows(pg, tables) {
  const list = tables ?? await countedTables(pg);
  const sql = list.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}"`).join(" UNION ALL ");
  const out = {};
  for (const r of (await pg.query(sql)).rows) out[r.t] = r.n;
  return out;
}

/** The tables whose count moved between two countRows snapshots: { table: [before, after] }. */
export function changedTables(before, after) {
  const out = {};
  for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[t] !== after[t]) out[t] = [before[t], after[t]];
  }
  return out;
}

export async function paperOrdersOf(pg, userId) {
  return (await pg.query("SELECT id, symbol, status FROM paper_orders WHERE user_id = $1 ORDER BY id", [userId])).rows;
}
