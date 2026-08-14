// qaTimingHarness.ts — Real-action timing harness for the LIVE_SHARED owner.
//
// Reads QA_OWNER_EMAIL / QA_OWNER_PASSWORD from process.env (NEVER logged,
// NEVER echoed, NEVER persisted to disk). Logs in via the real
// /api/auth/login form-equivalent, captures the session cookie in memory,
// and times the real HTTP endpoints behind each user action.
//
// All arx_live_commands rows created by this harness are tagged:
//   sourcePage = "QA_TIMING_HARNESS"
//   payload.qaTimingHarness = { testRunId, action, page, ts }
// so they are trivially separable from real operator audit history.
//
// Master switch `ARX_LIVE_BROKER_EXECUTION_ENABLED` MUST remain unset/false
// while this runs — every dispatch attempt will hit the 16-gate evaluator
// and return LIVE_BLOCKED. No broker fill is possible.
//
// Output: human-readable matrix to stdout PLUS a JSON report at
// /tmp/qa-timing-harness-<testRunId>.json for the user to inspect.

import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const BASE = process.env.QA_HARNESS_BASE_URL ?? "http://localhost:80";
const EMAIL = process.env.QA_OWNER_EMAIL;
const PASSWORD = process.env.QA_OWNER_PASSWORD;
const TEST_RUN_ID = `qa-timing-${Date.now()}-${randomUUID().slice(0, 8)}`;

if (!EMAIL || !PASSWORD) {
  console.error("FATAL: QA_OWNER_EMAIL / QA_OWNER_PASSWORD env vars are required.");
  process.exit(2);
}

// ── MASTER-SWITCH AWARENESS BANNER ──────────────────────────────────────
// Per owner directive (authorized live testing on the owner account), the
// harness no longer refuses to run when the server master switch is on.
// Instead it prints a one-line warning so the operator running it is
// aware that any successful dispatch from this run can enqueue a real
// SENT_TO_MT5_LIVE row that the EA may execute at the broker.
const MASTER_SWITCH_ON = String(process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED ?? "")
  .trim()
  .toLowerCase() === "true";
if (MASTER_SWITCH_ON) {
  console.warn("⚠  ARX_LIVE_BROKER_EXECUTION_ENABLED is ON in this process.");
  console.warn("   A dispatch that passes all 16 Phase B gates WILL enqueue a real");
  console.warn("   SENT_TO_MT5_LIVE row and may be picked up by the EA. Proceeding.");
}

// Budget table — sourced from the project speed targets. `null` budget
// means "report-only, no budget set" (e.g. server-side baselines).
type Budget = { ms: number; note: string } | null;
const BUDGETS: Record<string, Budget> = {
  "auth.login": { ms: 1000, note: "scrypt-bound; constant-time" },
  "dashboard.me": { ms: 200, note: "identity endpoint" },
  "dashboard.accountShell": { ms: 1000, note: "admin shell budget" },
  "dashboard.accountMode": { ms: 250, note: "unified mode resolver" },
  "dashboard.alerts.list": { ms: 500, note: "alerts list" },
  "dashboard.tradesOpen": { ms: 500, note: "open trades list" },
  "alerts.markOne": { ms: 100, note: "optimistic; backend can lag" },
  "alerts.markAll": { ms: 200, note: "optimistic; backend can lag" },
  "live.arming.preview": { ms: 750, note: "validate w/o provider" },
  "live.arming.read": { ms: 250, note: "small read" },
  "live.commands.list": { ms: 500, note: "user-scoped list" },
  "live.positions.list": { ms: 500, note: "EA-synced read" },
  "live.eaInputs": { ms: 500, note: "EA snapshot" },
  "live.bridgeDebug": { ms: 750, note: "diagnostics; can be slower" },
  "live.draft.create": { ms: 750, note: "validate w/o provider" },
  "live.draft.confirm": { ms: 250, note: "state transition" },
  "live.dispatch.gateEval": { ms: 1500, note: "16-gate eval + DB write" },
  "live.draft.cancel": { ms: 250, note: "state transition" },
  "ruby.firstToken": { ms: 1500, note: "Ruby first text" },
  "ruby.complete": { ms: 6000, note: "full SSE drain" },
  "admin.allocations.list": { ms: 1000, note: "admin shell budget" },
  "admin.allocations.usersEligible": { ms: 1000, note: "admin shell budget" },
};

type Row = {
  action: string;
  ms: number;
  status: number | "n/a";
  pass: boolean | null; // null = no budget
  budgetMs: number | null;
  note: string;
  detail?: string;
};
const rows: Row[] = [];
let sessionCookie = "";

function record(action: string, ms: number, status: number | "n/a", detail?: string) {
  const b = BUDGETS[action];
  const pass = b ? ms <= b.ms : null;
  rows.push({ action, ms: Math.round(ms * 10) / 10, status, pass, budgetMs: b?.ms ?? null, note: b?.note ?? "", detail });
  const pad = (s: string, n: number) => s.padEnd(n);
  const tag = pass === null ? "INFO" : pass ? "PASS" : "FAIL";
  const budget = b ? `≤${b.ms}ms` : "(no budget)";
  // eslint-disable-next-line no-console
  console.log(`${pad(tag, 4)}  ${pad(action, 34)}  ${String(Math.round(ms)).padStart(5)}ms  ${pad(budget, 11)}  HTTP ${status}${detail ? "  " + detail : ""}`);
}

async function timed(action: string, fn: () => Promise<{ status: number; detail?: string }>) {
  const t0 = performance.now();
  let res: { status: number; detail?: string };
  try {
    res = await fn();
  } catch (e) {
    const ms = performance.now() - t0;
    record(action, ms, "n/a", `ERR ${(e as Error).message.slice(0, 80)}`);
    return null;
  }
  const ms = performance.now() - t0;
  record(action, ms, res.status, res.detail);
  return { ms, ...res };
}

async function req(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (sessionCookie) headers.cookie = sessionCookie;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return r;
}

async function timedJson(action: string, method: string, path: string, body?: unknown) {
  return timed(action, async () => {
    const r = await req(method, path, body);
    return { status: r.status };
  });
}

async function loginAndCaptureCookie(): Promise<boolean> {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const ms = performance.now() - t0;
  // Capture set-cookie header(s). Node fetch returns combined with comma; we
  // need to split on the trailing date separator. Easier: take everything
  // up to the first space-following-comma break is unreliable, so use
  // headers.getSetCookie() in Node 22+.
  const setCookies = typeof (r.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (r.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : (r.headers.get("set-cookie")?.split(/,\s*(?=[A-Za-z0-9_-]+=)/) ?? []);
  sessionCookie = setCookies.map((c: string) => c.split(";")[0]).join("; ");
  record("auth.login", ms, r.status, r.status === 200 ? "session cookie captured" : "LOGIN FAILED");
  return r.status === 200 && sessionCookie.length > 0;
}

async function rubySendAndMeasureSse(conversationId: string) {
  const t0 = performance.now();
  const r = await req("POST", `/api/me/assistant/conversations/${conversationId}/messages`, {
    content: `[QA_TIMING_HARNESS ${TEST_RUN_ID}] What's the current market session? Reply briefly.`,
  });
  if (!r.ok || !r.body) {
    const ms = performance.now() - t0;
    record("ruby.firstToken", ms, r.status, "NO BODY");
    record("ruby.complete", ms, r.status, "NO BODY");
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let firstTokenMs: number | null = null;
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (firstTokenMs === null) {
      // Scan ALL `data: {...}` lines accumulated so far; the first events
      // are typically safety / intent / ping — we want the first `content`.
      for (const m of buf.matchAll(/data:\s*(\{[^\n]+\})/g)) {
        try {
          const ev = JSON.parse(m[1]!) as { type?: string; content?: string };
          if (ev.type === "content" && typeof ev.content === "string" && ev.content.length > 0) {
            firstTokenMs = performance.now() - t0;
            break;
          }
        } catch { /* keep reading */ }
      }
    }
  }
  const totalMs = performance.now() - t0;
  record("ruby.firstToken", firstTokenMs ?? totalMs, r.status, firstTokenMs === null ? "no content event seen" : "first non-empty content");
  record("ruby.complete", totalMs, r.status, "SSE drained");
}

async function main() {
  console.log(`\nARX timing harness — testRunId=${TEST_RUN_ID}`);
  console.log(`Base URL: ${BASE}\n`);

  // Baseline live-command count before anything
  const baseline = await db.execute(sql`SELECT COUNT(*)::int n, COALESCE(MAX(id),0)::int max_id FROM arx_live_commands`);
  const baselineN = Number((baseline.rows[0] as { n: number }).n);
  const baselineMaxId = Number((baseline.rows[0] as { max_id: number }).max_id);
  console.log(`Baseline arx_live_commands: count=${baselineN} maxId=${baselineMaxId}\n`);

  // ── auth ────────────────────────────────────────────────────────────
  const ok = await loginAndCaptureCookie();
  if (!ok) { console.error("Login failed; aborting harness."); process.exit(1); }

  // ── dashboard cluster ───────────────────────────────────────────────
  await timedJson("dashboard.me", "GET", "/api/me");
  await timedJson("dashboard.accountShell", "GET", "/api/me/account-shell");
  await timedJson("dashboard.accountMode", "GET", "/api/me/account-mode");
  await timedJson("dashboard.alerts.list", "GET", "/api/me/alerts");
  await timedJson("dashboard.tradesOpen", "GET", "/api/me/trades/open");

  // ── live readiness/positions/eaInputs/bridge-debug ──────────────────
  await timedJson("live.arming.read", "GET", "/api/me/live/arming");
  await timedJson("live.arming.preview", "POST", "/api/me/live/arming/preview", {});
  await timedJson("live.commands.list", "GET", "/api/me/live/commands?limit=10");
  await timedJson("live.positions.list", "GET", "/api/me/live/positions");
  await timedJson("live.eaInputs", "GET", "/api/me/live/ea-inputs");
  await timedJson("live.bridgeDebug", "GET", "/api/me/live/bridge-debug");

  // ── alerts: read list then dismiss one if any exist ─────────────────
  try {
    const alertsR = await req("GET", "/api/me/alerts");
    const alertsBody = (await alertsR.json()) as { alerts?: Array<{ id: number }> };
    const firstId = alertsBody?.alerts?.[0]?.id;
    if (firstId) {
      await timedJson("alerts.markOne", "POST", `/api/me/alerts/${firstId}/read`);
    } else {
      record("alerts.markOne", 0, "n/a", "no alerts in queue — skipped (cannot dismiss none)");
    }
    await timedJson("alerts.markAll", "POST", "/api/me/alerts/read-all");
  } catch (e) {
    record("alerts.markOne", 0, "n/a", `ERR ${(e as Error).message}`);
  }

  // ── admin allocations ───────────────────────────────────────────────
  await timedJson("admin.allocations.list", "GET", "/api/admin/allocations");
  await timedJson("admin.allocations.usersEligible", "GET", "/api/admin/allocations/users-eligible");

  // ── live trade ticket — full draft → confirm → dispatch (BLOCKED) ───
  // sourcePage tags the row clearly as harness; payload tags with testRunId.
  // Master switch off → dispatch will return BLOCKED with reason
  // LIVE_BROKER_EXECUTION_DISABLED. No broker fill possible.
  let commandId = "";
  const draftRes = await timed("live.draft.create", async () => {
    const r = await req("POST", "/api/me/live/commands", {
      commandType: "PLACE_LIVE_MARKET_ORDER",
      symbol: "EURUSD",
      side: "BUY",
      orderType: "MARKET_BUY",
      requestedVolume: 0.01,
      stopLoss: 1.04500,
      takeProfit: 1.06500,
      sourcePage: "QA_TIMING_HARNESS",
      rubyExplanationSummary: `harness draft testRunId=${TEST_RUN_ID}`,
      payload: { qaTimingHarness: { testRunId: TEST_RUN_ID, action: "live.draft.create", page: "QA_HARNESS" } },
    });
    const body = await r.json() as { command?: { id?: string; commandId?: string }; reason?: string; detail?: string };
    commandId = String(body?.command?.commandId ?? body?.command?.id ?? "");
    const refuse = body?.reason ? `refused=${body.reason}${body.detail ? "/" + body.detail : ""}` : "no commandId";
    return { status: r.status, detail: commandId ? `commandId=${commandId.slice(0, 16)}…` : refuse };
  });

  if (draftRes && commandId) {
    await timedJson("live.draft.confirm", "POST", `/api/me/live/commands/${commandId}/confirm`, {});
    await timed("live.dispatch.gateEval", async () => {
      const r = await req("POST", `/api/me/live/commands/${commandId}/dispatch`, {});
      const body = await r.json() as { reason?: string; status?: string; blockReasons?: string[] };
      const reason = body?.reason ?? body?.blockReasons?.[0] ?? body?.status ?? "?";
      return { status: r.status, detail: `gate=${reason.slice(0, 40)}` };
    });
    await timedJson("live.draft.cancel", "POST", `/api/me/live/commands/${commandId}/cancel`, { reason: "qa_timing_harness_cleanup" });
  }

  // ── Ruby SSE ────────────────────────────────────────────────────────
  try {
    const convR = await req("POST", "/api/me/assistant/conversations", { title: `QA timing ${TEST_RUN_ID}` });
    const convBody = await convR.json() as { conversation?: { id?: number | string }; id?: number | string };
    const convId = String(convBody?.conversation?.id ?? convBody?.id ?? "");
    if (convId) {
      await rubySendAndMeasureSse(convId);
    } else {
      record("ruby.firstToken", 0, convR.status, "could not create conversation");
    }
  } catch (e) {
    record("ruby.firstToken", 0, "n/a", `ERR ${(e as Error).message.slice(0, 80)}`);
  }

  // ── final audit-table verification ──────────────────────────────────
  const after = await db.execute(sql`SELECT COUNT(*)::int n, COALESCE(MAX(id),0)::int max_id FROM arx_live_commands`);
  const afterN = Number((after.rows[0] as { n: number }).n);
  const afterMaxId = Number((after.rows[0] as { max_id: number }).max_id);
  const newRows = await db.execute(sql`
    SELECT id, status, source_page, rejection_reason, broker_ticket, fill_price, command_id
    FROM arx_live_commands WHERE id > ${baselineMaxId} ORDER BY id ASC
  `);
  const newRowList = newRows.rows as Array<{ id: number; status: string; source_page: string; rejection_reason: string | null; broker_ticket: string | null; fill_price: number | null; command_id: string }>;
  const anyFilled = newRowList.some(r => r.status === "LIVE_FILLED" || r.broker_ticket || r.fill_price != null);
  const allTagged = newRowList.every(r => r.source_page === "QA_TIMING_HARNESS");

  console.log("\n── arx_live_commands audit ─────────────────────────────");
  console.log(`baseline: count=${baselineN} maxId=${baselineMaxId}`);
  console.log(`after:    count=${afterN} maxId=${afterMaxId}  (newRows=${newRowList.length})`);
  for (const r of newRowList) {
    console.log(`  id=${r.id} status=${r.status} source=${r.source_page} rejReason=${r.rejection_reason ?? "-"} brokerTicket=${r.broker_ticket ?? "-"} fillPrice=${r.fill_price ?? "-"}`);
  }
  console.log(`all harness rows tagged QA_TIMING_HARNESS: ${allTagged}`);
  console.log(`any broker fill / ticket: ${anyFilled}  (must be false)`);

  // ── summary ─────────────────────────────────────────────────────────
  const failed = rows.filter(r => r.pass === false);
  const passed = rows.filter(r => r.pass === true);
  const info = rows.filter(r => r.pass === null);
  console.log("\n── summary ─────────────────────────────────────────────");
  console.log(`PASS=${passed.length}  FAIL=${failed.length}  INFO=${info.length}  total=${rows.length}`);
  if (failed.length) {
    console.log("\nFAILING (over budget):");
    for (const r of failed) {
      console.log(`  ${r.action}  ${r.ms}ms  > budget ${r.budgetMs}ms   note=${r.note}`);
    }
  }

  // ── persist JSON report ─────────────────────────────────────────────
  const reportPath = `/tmp/qa-timing-harness-${TEST_RUN_ID}.json`;
  writeFileSync(reportPath, JSON.stringify({
    testRunId: TEST_RUN_ID,
    base: BASE,
    timestamp: new Date().toISOString(),
    auditBaseline: { count: baselineN, maxId: baselineMaxId },
    auditAfter: { count: afterN, maxId: afterMaxId, newRows: newRowList },
    allTagged, anyFilled,
    rows,
  }, null, 2));
  console.log(`\nJSON report → ${reportPath}\n`);

  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
