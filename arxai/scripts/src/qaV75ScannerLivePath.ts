// qaV75ScannerLivePath.ts — LIVE execution test of the V75 scanner/instant path.
//
// Drives the REAL scanner/instant path the UI uses (POST /api/trades/instant/execute,
// source:"scanner"), resolving the scanner-selected V75 instrument to the EXACT
// enumerated brokerSymbol via /api/me/mt5/resolve-symbol — never a display label,
// never an EURUSD/V75 hardcode. Reports the real EA/MT5/broker outcome, whatever
// it is. No faking, no hiding rejection.
//
// MODES:
//   (default)        diagnostics only — prints the full "before the live attempt"
//                    report (resolution, gates, EA state, lot, payload). NO trade.
//   LIVE_FIRE=1      additionally submits the real smallest-lot live BUY through
//                    the scanner/instant path and polls the command lifecycle.
//
// SAFETY: smallest broker-valid lot; physics-valid SL derived from a real quote;
// the server's 16-gate evaluator + kill switch decide. We only ever say "executed"
// on a genuine brokerTicket / LIVE_FILLED.

import { performance } from "node:perf_hooks";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";
const EMAIL = process.env.QA_OWNER_EMAIL;
const PASSWORD = process.env.QA_OWNER_PASSWORD;
const LIVE_FIRE = process.env.LIVE_FIRE === "1";
const UI_SYMBOL = process.env.V75_UI_SYMBOL ?? "V75"; // what the scanner "selected"
if (!EMAIL || !PASSWORD) { console.error("FATAL: QA_OWNER_EMAIL / QA_OWNER_PASSWORD required."); process.exit(2); }

let cookie = "";
async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) { const m = setCookie.match(/(?:^|,\s*)([^=,;\s]+=[^;]+)/); if (m) cookie = m[1]!; }
  let json: unknown = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, json, ms: performance.now() - t0 };
}
const fmt = (ms: number) => `${ms.toFixed(0)}ms`;
const j = (v: unknown) => JSON.stringify(v);

type SymbolView = { symbol: string; brokerSymbol: string | null; displaySymbol: string | null; category: string | null; minLot: number | null; freshness?: string };

function extractPrice(q: unknown): number | null {
  if (!q || typeof q !== "object") return null;
  const o = q as Record<string, unknown>;
  for (const k of ["price", "last", "close", "mid", "bid", "ask"]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  // nested { quote: {...} }
  for (const k of ["quote", "data"]) if (o[k] && typeof o[k] === "object") { const p = extractPrice(o[k]); if (p) return p; }
  return null;
}

async function main() {
  console.log(`\n========== ARX V75 SCANNER → LIVE PATH TEST ==========`);
  console.log(`base=${BASE}  mode=${LIVE_FIRE ? "LIVE_FIRE (will submit a real order)" : "DIAGNOSTICS ONLY (no trade)"}  uiSymbol="${UI_SYMBOL}"\n`);

  // 1) auth
  const login = await req("POST", "/api/auth/login", { email: EMAIL!.toLowerCase(), password: PASSWORD });
  console.log(`login              → HTTP ${login.status} ${fmt(login.ms)}`);
  if (login.status !== 200) { console.error("login failed", j(login.json)); process.exit(2); }
  const me = await req("GET", "/api/me");
  const meUser = (me.json as { user?: { id: number; email: string; role: string } } | null)?.user;
  console.log(`me                 → user=${meUser?.email} role=${meUser?.role} id=${meUser?.id}`);
  const userId = meUser?.id;
  if (!userId) { console.error("FATAL: no user id"); process.exit(2); }

  // 2) account-mode
  const mode = await req("GET", "/api/me/account-mode");
  const md = mode.json as Record<string, unknown> | null;
  console.log(`account-mode       → mode=${md?.mode} canTrade=${md?.canTrade} isLiveShared=${(md as Record<string, unknown>)?.["isLiveShared"] ?? "?"}`);

  // 3) symbol inventory — find the V75 family (proves real EA inventory, not hardcode)
  const inv = await req("GET", "/api/me/mt5/symbols?includeStale=1");
  const invBody = inv.json as { ok?: boolean; count?: number; overallFreshness?: string; symbols?: SymbolView[] } | null;
  const allSyms = invBody?.symbols ?? [];
  console.log(`symbols            → count=${invBody?.count ?? 0} overallFreshness=${invBody?.overallFreshness ?? "?"}`);
  const v75family = allSyms.filter((s) => /volatility\s*75/i.test(`${s.brokerSymbol ?? ""} ${s.displaySymbol ?? ""} ${s.symbol}`));
  console.log(`V75 family (${v75family.length}):`);
  for (const s of v75family) console.log(`   broker="${s.brokerSymbol}" display="${s.displaySymbol}" key=${s.symbol} minLot=${s.minLot} fresh=${s.freshness}`);

  // 4) resolve the scanner shorthand "V75" — prove ambiguity guard / exact resolution
  const r1 = await req("POST", "/api/me/mt5/resolve-symbol", { symbol: UI_SYMBOL });
  console.log(`\nresolve("${UI_SYMBOL}")     → HTTP ${r1.status}  ${j(r1.json)}`);

  // 5) pick the concrete scanner-selected instrument: prefer standard "Volatility 75 Index"
  //    (NOT the 1s variant), exactly as a real scanner selection would carry it.
  const standard = v75family.find((s) => /volatility\s*75\s*index/i.test(s.brokerSymbol ?? s.displaySymbol ?? "") && !/\(1s\)/i.test(s.brokerSymbol ?? s.displaySymbol ?? ""))
                ?? v75family[0];
  if (!standard || !standard.brokerSymbol) {
    console.log(`\nNO V75 INSTRUMENT ENUMERATED for this user — cannot select a real broker symbol.`);
    console.log(`This means the EA has not reported a V75 symbol spec. Honest stop (no fabrication).`);
    if (!LIVE_FIRE) await dumpRecentCommands(userId);
    process.exit(0);
  }
  const selectedBroker = standard.brokerSymbol;
  const r2 = await req("POST", "/api/me/mt5/resolve-symbol", { symbol: selectedBroker });
  const r2res = (r2.json as { ok?: boolean; resolution?: { brokerSymbol?: string } } | null);
  const resolvedBroker = r2res?.resolution?.brokerSymbol ?? null;
  console.log(`resolve("${selectedBroker}") → HTTP ${r2.status} ok=${r2res?.ok} brokerSymbol="${resolvedBroker}"`);

  // 6) full live-gate diagnostic (EA version, heartbeat, account type, algo, arm flags…)
  const diag = await req("GET", "/api/admin/live-gates/diagnostic");
  const dg = diag.json as { ok?: boolean; platformBridgeMode?: string; platformHeadline?: string; gates?: Array<{ id: string; label: string; status: string; detail: string; rawCode?: string }> } | null;
  console.log(`\n── LIVE GATE DIAGNOSTIC (platform=${dg?.platformBridgeMode ?? "?"}) ──`);
  console.log(`   ${dg?.platformHeadline ?? ""}`);
  for (const g of dg?.gates ?? []) {
    const mark = g.status === "pass" ? "PASS" : g.status === "fail" ? "FAIL" : "info";
    console.log(`   [${mark}] ${g.label}: ${g.detail} (${g.rawCode ?? ""})`);
  }

  // 7) min lot + physics-valid SL from a real quote
  const minLot = (standard.minLot && standard.minLot > 0) ? standard.minLot : 0.01;
  let price: number | null = null;
  const quote = await req("GET", `/api/data/quote?symbol=${encodeURIComponent(selectedBroker)}`);
  price = extractPrice(quote.json);
  if (price == null) { // fallback to candles last close
    const c = await req("GET", `/api/data/candles?symbol=${encodeURIComponent(selectedBroker)}&timeframe=5m&limit=3`);
    const arr = (c.json as { candles?: Array<{ close?: number }> } | null)?.candles ?? (Array.isArray(c.json) ? c.json as Array<{ close?: number }> : []);
    const last = arr[arr.length - 1];
    if (last && typeof last.close === "number") price = last.close;
  }
  const stopLoss = price != null ? Number((price * 0.6).toFixed(2)) : null; // BUY SL 40% below entry → physics-valid
  console.log(`\nquote price        → ${price ?? "UNAVAILABLE"}  (SL for BUY → ${stopLoss ?? "null (no quote)"})`);

  const payload = {
    source: "scanner" as const,
    action: "BUY" as const,
    accountMode: "live" as const,
    symbol: selectedBroker, // EXACT broker symbol, never displaySymbol/EURUSD/V75
    volume: minLot,
    stopLoss,
    takeProfit: null,
    oneClick: true,
  };

  // ── BEFORE report ────────────────────────────────────────────────────────
  console.log(`\n════ BEFORE THE LIVE ATTEMPT ════`);
  console.log(`  selected UI symbol     : "${UI_SYMBOL}" → scanner instrument "${selectedBroker}"`);
  console.log(`  resolved brokerSymbol  : "${resolvedBroker}"`);
  console.log(`  side / lot             : BUY / ${minLot}`);
  const gOf = (id: string) => dg?.gates?.find((g) => g.id === id);
  console.log(`  account type (gate#6)  : ${gOf("ea_account_type")?.rawCode ?? "?"} [${gOf("ea_account_type")?.status ?? "?"}]`);
  console.log(`  EA version (gate#8)    : ${gOf("ea_version")?.rawCode ?? "?"} [${gOf("ea_version")?.status ?? "?"}]`);
  console.log(`  EA heartbeat (gate#7)  : ${gOf("ea_heartbeat")?.rawCode ?? "?"} [${gOf("ea_heartbeat")?.status ?? "?"}]`);
  console.log(`  ARM#2 master switch    : ${gOf("server_master_switch")?.rawCode ?? "?"} [${gOf("server_master_switch")?.status ?? "?"}]`);
  console.log(`  master bridge live     : ${gOf("master_bridge_live_enabled")?.rawCode ?? "?"} [${gOf("master_bridge_live_enabled")?.status ?? "?"}]`);
  console.log(`  algo trading (gate#12) : ${gOf("ea_algo_trading_allowed")?.rawCode ?? "?"} [${gOf("ea_algo_trading_allowed")?.status ?? "?"}]`);
  console.log(`  ReadOnlyMode (gate#10) : ${gOf("ea_read_only")?.rawCode ?? "?"} [${gOf("ea_read_only")?.status ?? "?"}]`);
  console.log(`  EnableLive (gate#9)    : ${gOf("ea_enable_live_execution")?.rawCode ?? "?"} [${gOf("ea_enable_live_execution")?.status ?? "?"}]`);
  console.log(`  terminalConn (gate#11) : ${gOf("ea_terminal_connected")?.rawCode ?? "?"} [${gOf("ea_terminal_connected")?.status ?? "?"}]`);
  console.log(`  ARX Single Confirm     : ${gOf("arx_single_confirm_live")?.rawCode ?? "?"} [${gOf("arx_single_confirm_live")?.status ?? "?"}]`);
  console.log(`  command payload        : ${j(payload)}`);

  await dumpRecentCommands(userId, "BEFORE");

  if (!LIVE_FIRE) {
    console.log(`\n[DIAGNOSTICS ONLY] Not submitting. Re-run with LIVE_FIRE=1 to place the real smallest-lot live BUY.\n`);
    process.exit(0);
  }

  // ── LIVE FIRE ────────────────────────────────────────────────────────────
  console.log(`\n════ SUBMITTING REAL LIVE ORDER (scanner/instant path) ════`);
  const exec = await req("POST", "/api/trades/instant/execute", payload);
  const ej = exec.json as { ok?: boolean; action?: string; commandId?: string; error?: string; primaryReason?: string | null; detail?: unknown; category?: string; blockUserReason?: string; blockAdminReason?: string } | null;
  console.log(`execute            → HTTP ${exec.status} ${fmt(exec.ms)}`);
  console.log(`  ok=${ej?.ok} commandId=${ej?.commandId ?? "—"} error=${ej?.error ?? "—"} primaryReason=${ej?.primaryReason ?? "—"}`);
  console.log(`  category=${ej?.category ?? "—"} blockAdminReason=${ej?.blockAdminReason ?? "—"}`);
  console.log(`  detail=${j(ej?.detail)}`);

  const commandId = ej?.commandId ?? null;
  if (!commandId) {
    console.log(`\nResponse carried no commandId. Gate reason: ${ej?.error ?? ej?.primaryReason ?? "UNKNOWN"}.`);
    console.log(`Whether a command row exists is decided by the DB dump below, NOT by the missing commandId`);
    console.log(`(some rejections persist a row at draft/confirm/dispatch; a pre-draft gate persists none).`);
    console.log(`This is an ARX server-side gate reason — only an EA/broker reason if a row shows pickedByEaAt/mt5Retcode.`);
    await dumpRecentCommands(userId, "AFTER");
    process.exit(0);
  }

  // poll lifecycle ~30s
  console.log(`\n── POLLING command-status/${commandId} (EA pickup → fill/reject) ──`);
  let last: Record<string, unknown> | null = null;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await req("GET", `/api/me/live/command-status/${commandId}`);
    last = st.json as Record<string, unknown>;
    console.log(`  t+${(i + 1) * 2}s  status=${last?.["status"]} pickedByEa=${last?.["pickedByEaAt"] ?? "—"} ticket=${last?.["brokerTicket"] ?? "—"} retcode=${last?.["mt5Retcode"] ?? "—"} reason=${last?.["rejectionReason"] ?? "—"}`);
    const s = String(last?.["status"] ?? "");
    if (last?.["brokerTicket"] || /FILLED|CLOSED|REJECT|FAIL|EXPIRED|CANCEL/i.test(s)) break;
  }

  // final DB truth
  const rowAfter = await fetchCommandRow(commandId);
  console.log(`\n════ AFTER THE LIVE ATTEMPT ════`);
  console.log(`  command row: ${j(rowAfter)}`);
  await dumpRecentCommands(userId, "AFTER");
  await dumpOpenPositions(userId);

  const filled = rowAfter && rowAfter["broker_ticket"];
  if (filled) {
    console.log(`\n✅ REAL LIVE FILL: ticket=${rowAfter!["broker_ticket"]} fill=${rowAfter!["fill_price"]} lot=${rowAfter!["executed_volume"]} symbol=${rowAfter!["symbol"]} retcode=${rowAfter!["mt5_retcode"]}`);
  } else {
    console.log(`\n⛔ NO FILL. status=${last?.["status"]} reason=${last?.["rejectionReason"] ?? rowAfter?.["rejection_reason"] ?? "—"} retcode=${last?.["mt5Retcode"] ?? rowAfter?.["mt5_retcode"] ?? "—"} brokerMsg=${rowAfter?.["broker_message"] ?? "—"}`);
  }
  process.exit(0);
}

async function fetchCommandRow(commandId: string) {
  const r = await db.execute(sql`
    SELECT id, command_id, status, source_page, symbol, side, requested_volume, executed_volume,
           stop_loss, take_profit, rejection_reason, broker_ticket, fill_price, mt5_retcode, broker_message,
           created_at, sent_to_mt5_at, picked_by_ea_at, filled_at, rejected_at, closed_at
    FROM arx_live_commands WHERE command_id = ${commandId}`);
  return r.rows[0] as Record<string, unknown> | undefined;
}
async function dumpRecentCommands(userId: number, label = "") {
  const r = await db.execute(sql`
    SELECT command_id, status, symbol, side, requested_volume, broker_ticket, mt5_retcode, rejection_reason, created_at
    FROM arx_live_commands WHERE user_id = ${userId} ORDER BY id DESC LIMIT 5`);
  console.log(`\n  arx_live_commands (last 5)${label ? ` [${label}]` : ""}:`);
  if (r.rows.length === 0) console.log(`    (none)`);
  for (const row of r.rows) console.log(`    ${j(row)}`);
}
async function dumpOpenPositions(userId: number) {
  const r = await db.execute(sql`
    SELECT broker_ticket, symbol, side, volume, entry_price, closed_at
    FROM arx_live_positions WHERE user_id = ${userId} AND closed_at IS NULL ORDER BY id DESC LIMIT 10`);
  console.log(`\n  arx_live_positions (open):`);
  if (r.rows.length === 0) console.log(`    (none)`);
  for (const row of r.rows) console.log(`    ${j(row)}`);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
