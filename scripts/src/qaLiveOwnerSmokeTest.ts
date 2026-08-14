// qaLiveOwnerSmokeTest.ts — Authorized owner live-test smoke.
//
// Drives the REAL live-shared execute path end-to-end and reports the
// REAL broker/EA outcome, whatever it is. No faking, no hiding rejection.
//
// SAFETY:
// - Uses the actual `POST /api/trades/live-shared/execute` endpoint
//   gated by typed phrase "EXECUTE LIVE SHARED".
// - Volume pinned to 0.01 (the minimum) on EURUSD BUY.
// - Tags row with sourcePage=TRADES_LIVE_SHARED_EXECUTE (the normal path).
// - Reports every state transition with timestamps from arx_live_commands.

import { performance } from "node:perf_hooks";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";
const EMAIL = process.env.QA_OWNER_EMAIL;
const PASSWORD = process.env.QA_OWNER_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("FATAL: QA_OWNER_EMAIL / QA_OWNER_PASSWORD required."); process.exit(2); }

let cookie = "";

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const setCookie = r.headers.get("set-cookie");
  if (setCookie) {
    const m = setCookie.match(/(?:^|,\s*)([^=,;\s]+=[^;]+)/);
    if (m) cookie = m[1]!;
  }
  let json: unknown = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, json, ms: performance.now() - t0 };
}

function fmt(ms: number) { return `${ms.toFixed(0)}ms`; }

async function fetchCommandRow(commandId: string) {
  const r = await db.execute(sql`
    SELECT id, command_id, status, source_page, symbol, side, requested_volume,
           stop_loss, take_profit, rejection_reason, broker_ticket, fill_price,
           executed_volume, mt5_retcode, broker_message,
           created_at, sent_to_mt5_at, picked_by_ea_at, filled_at, rejected_at, closed_at,
           idempotency_key
    FROM arx_live_commands WHERE command_id = ${commandId}
  `);
  return r.rows[0] as Record<string, unknown> | undefined;
}

async function main() {
  console.log(`ARX live-shared owner smoke test — ${BASE}\n`);

  // 1) login (case-insensitive — pass the email as the user types it)
  const login = await req("POST", "/api/auth/login", { email: EMAIL!.toLowerCase(), password: PASSWORD });
  console.log(`login                      → HTTP ${login.status}  ${fmt(login.ms)}`);
  if (login.status !== 200) { console.error("login failed", login.json); process.exit(2); }

  // 2) confirm owner identity from /api/me
  const me = await req("GET", "/api/me");
  const meData = (me.json as { user?: { id: number; email: string; role: string } } | null)?.user;
  console.log(`me                         → HTTP ${me.status}  ${fmt(me.ms)}  user=${meData?.email} role=${meData?.role} id=${meData?.id}`);
  if (meData?.id !== 4) { console.error("FATAL: not logged in as owner id=4"); process.exit(2); }

  // 3) confirm LIVE_SHARED access from account-mode (owner-facing, no diagnostic labels)
  const mode = await req("GET", "/api/me/account-mode");
  const modeData = mode.json as Record<string, unknown> | null;
  console.log(`account-mode               → HTTP ${mode.status}  ${fmt(mode.ms)}  mode=${modeData?.mode} canTrade=${modeData?.canTrade}`);

  // 4) DISPATCH — the real live-shared execute call
  console.log("\n── DISPATCH ──");
  const dispatchT0 = performance.now();
  const dispatch = await req("POST", "/api/trades/live-shared/execute", {
    confirmationIntent: "EXECUTE LIVE SHARED",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.01,
    stopLoss: 1.0000,   // wide SL well below any plausible EURUSD entry; satisfies physics SL gate
    takeProfit: null,
    rubyExplanationSummary: "qaLiveOwnerSmokeTest authorized owner live smoke",
  });
  console.log(`execute                    → HTTP ${dispatch.status}  ${fmt(dispatch.ms)}`);
  const dj = dispatch.json as { commandId?: string; stage?: string; reason?: string; detail?: string; ok?: boolean } | null;
  console.log(`  stage=${dj?.stage ?? "-"}  ok=${dj?.ok ?? "-"}  reason=${dj?.reason ?? "-"}  detail=${dj?.detail ?? "-"}`);
  const commandId = dj?.commandId;
  if (!commandId) {
    console.error("\nFATAL: no commandId returned. Full response:", JSON.stringify(dispatch.json, null, 2));
    process.exit(3);
  }
  console.log(`  commandId=${commandId}`);

  // 5) POLL the row until terminal state or 30s timeout
  console.log("\n── LIFECYCLE POLL (up to 30s, every 250ms) ──");
  const TERMINAL = new Set(["LIVE_FILLED", "LIVE_REJECTED", "LIVE_BLOCKED", "LIVE_CANCELLED", "LIVE_EXPIRED"]);
  const seen: Array<{ status: string; t: number; brokerTicket: unknown; fillPrice: unknown; reason: unknown }> = [];
  let row = await fetchCommandRow(commandId);
  if (row) seen.push({ status: String(row["status"]), t: 0, brokerTicket: row["broker_ticket"], fillPrice: row["fill_price"], reason: row["rejection_reason"] });
  const pollStart = performance.now();
  while (row && !TERMINAL.has(String(row["status"]))) {
    await new Promise(r => setTimeout(r, 250));
    if (performance.now() - pollStart > 30_000) break;
    const next = await fetchCommandRow(commandId);
    if (!next) break;
    const lastStatus = seen[seen.length - 1]?.status;
    if (String(next["status"]) !== lastStatus) {
      seen.push({ status: String(next["status"]), t: performance.now() - pollStart, brokerTicket: next["broker_ticket"], fillPrice: next["fill_price"], reason: next["rejection_reason"] });
    }
    row = next;
  }
  for (const s of seen) {
    console.log(`  +${fmt(s.t).padStart(7)}  status=${String(s.status).padEnd(28)} brokerTicket=${s.brokerTicket ?? "-"}  fillPrice=${s.fillPrice ?? "-"}  reason=${s.reason ?? "-"}`);
  }
  const totalMs = performance.now() - dispatchT0;
  console.log(`\n  full open-trade cycle: ${fmt(totalMs)}`);

  // 6) Final row dump
  console.log("\n── FINAL ROW ──");
  if (row) {
    console.log(`  id              = ${row["id"]}`);
    console.log(`  status          = ${row["status"]}`);
    console.log(`  rejection_reason= ${row["rejection_reason"] ?? "(none)"}`);
    console.log(`  broker_ticket   = ${row["broker_ticket"] ?? "(none)"}`);
    console.log(`  fill_price      = ${row["fill_price"] ?? "(none)"}`);
    console.log(`  executed_volume = ${row["executed_volume"] ?? "(none)"}`);
    console.log(`  mt5_retcode     = ${row["mt5_retcode"] ?? "(none)"}`);
    console.log(`  broker_message  = ${row["broker_message"] ?? "(none)"}`);
    console.log(`  created_at      = ${row["created_at"]}`);
    console.log(`  sent_to_mt5_at  = ${row["sent_to_mt5_at"] ?? "(never)"}`);
    console.log(`  picked_by_ea_at = ${row["picked_by_ea_at"] ?? "(never)"}`);
    console.log(`  filled_at       = ${row["filled_at"] ?? "(never)"}`);
    console.log(`  rejected_at     = ${row["rejected_at"] ?? "(never)"}`);
    console.log(`  closed_at       = ${row["closed_at"] ?? "(never)"}`);
  }

  // 7) UI surface — confirm the commands list returns the new row with
  //    no diagnostic / debug labels leaked to the user.
  const cmds = await req("GET", `/api/trades/live-shared/commands/${commandId}`);
  console.log(`\nUI commands GET           → HTTP ${cmds.status}  ${fmt(cmds.ms)}`);
  const cmdsStr = JSON.stringify(cmds.json);
  const FORBIDDEN = [
    "sourcePage", "idempotencyKey", "liveCommandHash",
    "dispatchGateSnapshot", "safetyGateSnapshot", "payload",
    "bridgeConnectionId", "accountLogin", "brokerServer", "accountNumber",
    "MT5_BRIDGE_TOKEN", "SESSION_SECRET",
  ];
  const leaked = FORBIDDEN.filter(k => cmdsStr.includes(k));
  console.log(`  forbidden-label leak check: ${leaked.length === 0 ? "OK (none leaked)" : "LEAK: " + leaked.join(", ")}`);

  // 8) If FILLED, try the close path
  if (String(row?.["status"]) === "LIVE_FILLED" && row?.["broker_ticket"]) {
    console.log("\n── CLOSE-TRADE FLOW ──");
    const closeT0 = performance.now();
    const close = await req("POST", `/api/trades/live-shared/positions/${row["broker_ticket"]}/close`, { confirmationIntent: "EXECUTE LIVE SHARED" });
    console.log(`close                      → HTTP ${close.status}  ${fmt(close.ms)}`);
    console.log(`  full close cycle: ${fmt(performance.now() - closeT0)}`);
    console.log(`  response: ${JSON.stringify(close.json).slice(0, 400)}`);
  }

  console.log("\nDone.");
  await db.$client.end?.();
}

void main().catch(e => { console.error(e); process.exit(1); });
