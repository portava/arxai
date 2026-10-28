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
 */
export async function tradeAction(t, mode, { symbol = "EURUSD", lotSize = 0.05, px = 1.1, phrase } = {}) {
  const created = await t.call("POST", "/me/trade-actions", {
    actionType: "OPEN", requestedMode: mode, symbol, side: "BUY", lotSize, stopLoss: px * 0.97, takeProfit: px * 1.06,
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
 * Every table a booked order, a queued broker command or an execution would
 * write. A count that does not move proves none of them was written.
 */
export const EXECUTION_TABLES = [
  "trades", "paper_orders", "paper_trade_events", "paper_executions", "paper_execution_logs",
  "arx_live_commands", "arx_live_positions", "mt5_commands", "mt5_demo_commands", "live_positions",
  "execution_events", "execution_confirmations", "live_trade_approvals", "live_trading_audit",
  "one_click_audit", "trade_command_audit_log", "trade_action_requests", "user_risk_events",
  "self_trade_agent_executions", "self_trade_decisions", "self_trade_ledger_entries", "position_events",
  "vault_events",
];

export async function countRows(pg, tables = EXECUTION_TABLES) {
  const out = {};
  for (const table of tables) out[table] = Number((await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  return out;
}

export async function paperOrdersOf(pg, userId) {
  return (await pg.query("SELECT id, symbol, status FROM paper_orders WHERE user_id = $1 ORDER BY id", [userId])).rows;
}
