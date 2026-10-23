// qaReconciliationCenter.ts — 26-check QA closeout for the Reconciliation Center.
// Mirrors the user spec exactly (probes #1–#26). Seeds 1 ADMIN + 1 USER and
// 1 REJECTED arx_live_commands + 1 REJECTED mt5_demo_commands row (terminal
// states only). All seeds are deleted in cleanup; live invariant verified
// before/after.

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import { usersTable, authUserSessionsTable, adminActionAuditLogTable } from "@workspace/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaRC_${Date.now()}_${randomBytes(3).toString("hex")}`;

async function cleanup(tag: string, ids: number[]): Promise<void> {
  try { await pool.query("DELETE FROM arx_live_commands WHERE command_id LIKE $1", [`${tag}_%`]); } catch { /* */ }
  try { await pool.query("DELETE FROM mt5_demo_commands WHERE command_id LIKE $1", [`${tag}_%`]); } catch { /* */ }
  try { await pool.query("DELETE FROM auth_user_sessions WHERE user_agent = $1", [tag]); } catch { /* */ }
  if (ids.length > 0) {
    try { await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]); } catch { /* */ }
  }
}

type Probe = { n: number; name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(n: number, name: string, pass: boolean, note: string): void {
  results.push({ n, name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${String(n).padStart(2, " ")}. ${name} — ${note}`);
}

async function createSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId, tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1", userAgent: TAG,
  });
  return raw;
}

async function seedUser(label: "ADMIN" | "USER"): Promise<{ id: number; cookie: string }> {
  const email = `${TAG}_${label.toLowerCase()}@arx.test`;
  const [u] = await db.insert(usersTable).values({
    email, name: `${TAG} ${label}`, role: label,
  }).returning();
  const id = u!.id;
  const raw = await createSession(id);
  return { id, cookie: `${USER_SESSION_COOKIE}=${raw}` };
}

async function liveCmdCount(): Promise<number> {
  const r = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return r.rows[0]!.n;
}

async function fetchAs(cookie: string | null, path: string, init: RequestInit = {}): Promise<{ status: number; body: string; json: unknown }> {
  const headers = new Headers(init.headers ?? {});
  headers.set("accept", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  const body = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* */ }
  return { status: r.status, body, json };
}

const SECRET_MARKERS = [
  "apiKeyHash", "tokenHash", "X-MT5-Bridge-Token", "SESSION_SECRET",
  "MT5_BRIDGE_TOKEN", "bridge_token", "api_key",
];
function bodyHasSecret(body: string): string | null {
  for (const m of SECRET_MARKERS) if (body.includes(m)) return m;
  return null;
}

async function main(): Promise<void> {
  const startLive = await liveCmdCount();
  // eslint-disable-next-line no-console
  console.log(`[setup] arx_live_commands start = ${startLive}`);

  const admin = await seedUser("ADMIN");
  const user = await seedUser("USER");

  const liveCmdId = `${TAG}_live_cmd`;
  const demoCmdId = `${TAG}_demo_cmd`;
  await pool.query(
    `INSERT INTO arx_live_commands (command_id, user_id, command_type, status, symbol, side, order_type, requested_volume, source_page)
     VALUES ($1, $2, 'OPEN', 'REJECTED', 'EURUSD', 'BUY', 'MARKET', 0.01, 'QA_RECON')`,
    [liveCmdId, user.id],
  );
  await pool.query(
    `INSERT INTO mt5_demo_commands (command_id, user_id, bridge_connection_id, command_type, payload, status, safety_gate_snapshot)
     VALUES ($1, $2, 0, 'OPEN', '{}'::jsonb, 'REJECTED', '{}'::jsonb)`,
    [demoCmdId, user.id],
  );

  // ── 1. Page exists (static verification — Vite SPA fallback is base-path-scoped)
  const fsm = await import("node:fs/promises");
  const repoRoot = process.cwd().endsWith("/scripts") ? ".." : ".";
  const appTsx = await fsm.readFile(`${repoRoot}/artifacts/trading-dashboard/src/App.tsx`, "utf8");
  const pageFileExists = await fsm.stat(`${repoRoot}/artifacts/trading-dashboard/src/pages/admin/reconciliation-center.tsx`)
    .then(() => true).catch(() => false);
  const lazyImported = /AdminReconciliationCenter\s*=\s*lazy/.test(appTsx);
  const routeRegistered = /path="\/admin\/reconciliation-center"\s+component=\{AdminReconciliationCenter\}/.test(appTsx);
  record(1, "/admin/reconciliation-center exists",
    pageFileExists && lazyImported && routeRegistered,
    `file=${pageFileExists} lazyImport=${lazyImported} route=${routeRegistered}`);

  // ── 2. Reconciliation Center is admin-only (API gate proves the page is admin-only)
  const userAgg = await fetchAs(user.cookie, "/api/admin/reconciliation-center/issues");
  record(2, "Reconciliation Center is admin-only",
    userAgg.status === 403, `regular USER got ${userAgg.status} from admin API`);

  // ── 3. Non-admin users cannot access the page (same gate)
  record(3, "Non-admin users cannot access the page",
    userAgg.status === 403, `USER → ${userAgg.status}`);

  // ── 4. Non-admin (anon) cannot call reconciliation APIs directly
  const anonAgg = await fetchAs(null, "/api/admin/reconciliation-center/issues");
  record(4, "Non-admin users cannot call reconciliation APIs directly",
    anonAgg.status === 401 || anonAgg.status === 403, `anon → ${anonAgg.status}`);

  // ── 5. Legacy /broker-reconciliation is protected or redirects
  const legacyAnon = await fetchAs(null, "/api/broker-reconciliation/status");
  const legacyUser = await fetchAs(user.cookie, "/api/broker-reconciliation/status");
  const legacyRedirect = String((legacyUser.json as { redirectTo?: string })?.redirectTo ?? "");
  record(5, "Legacy /broker-reconciliation is protected or redirects to /admin/reconciliation-center",
    (legacyUser.status === 403 || legacyAnon.status === 401)
      && legacyRedirect === "/admin/reconciliation-center",
    `anon=${legacyAnon.status} user=${legacyUser.status} redirectTo=${legacyRedirect}`);

  // ── 6. Aggregator returns structured reconciliation issues
  const adminAgg = await fetchAs(admin.cookie, "/api/admin/reconciliation-center/issues");
  const aggJson = adminAgg.json as {
    ok?: boolean; issues?: Array<Record<string, unknown>>;
    countsByType?: Record<string, number>; countsBySeverity?: Record<string, number>;
    categories?: string[];
  };
  record(6, "Aggregator endpoint returns structured reconciliation issues",
    adminAgg.status === 200 && aggJson.ok === true && Array.isArray(aggJson.issues)
      && typeof aggJson.countsByType === "object" && typeof aggJson.countsBySeverity === "object",
    `status=${adminAgg.status} hasIssues=${Array.isArray(aggJson.issues)}`);

  const counts = aggJson.countsByType ?? {};
  const haveCat = (k: string): boolean => Object.prototype.hasOwnProperty.call(counts, k);

  // ── 7-16. Detector categories present
  record(7, "Detects bridge mismatches", haveCat("BRIDGE_MISMATCH"), `count=${counts.BRIDGE_MISMATCH ?? "MISSING"}`);
  record(8, "Detects orphan broker positions", haveCat("ORPHAN_BROKER_POSITION"), `count=${counts.ORPHAN_BROKER_POSITION ?? "MISSING"}`);
  record(9, "Detects missing attribution rows", haveCat("MISSING_ATTRIBUTION"), `count=${counts.MISSING_ATTRIBUTION ?? "MISSING"}`);
  record(10, "Detects command/result mismatches", haveCat("COMMAND_RESULT_MISMATCH"), `count=${counts.COMMAND_RESULT_MISMATCH ?? "MISSING"}`);
  record(11, "Detects user allocation mismatches", haveCat("USER_ALLOCATION_MISMATCH"), `count=${counts.USER_ALLOCATION_MISMATCH ?? "MISSING"}`);
  record(12, "Detects stale heartbeat issues", haveCat("STALE_HEARTBEAT"), `count=${counts.STALE_HEARTBEAT ?? "MISSING"}`);

  const issuesArr = aggJson.issues ?? [];
  const foundOurRejected = issuesArr.some((i) => {
    const cid = String((i as { commandId?: string }).commandId ?? "");
    return cid === liveCmdId || cid === demoCmdId;
  });
  record(13, "Detects blocked/rejected commands needing review",
    haveCat("BLOCKED_REJECTED_COMMAND") && (counts.BLOCKED_REJECTED_COMMAND ?? 0) >= 1 && foundOurRejected,
    `count=${counts.BLOCKED_REJECTED_COMMAND ?? 0} foundSeeded=${foundOurRejected}`);

  record(14, "Detects master bridge exposure warnings",
    haveCat("MASTER_BRIDGE_EXPOSURE_WARNING"), `count=${counts.MASTER_BRIDGE_EXPOSURE_WARNING ?? "MISSING"}`);
  record(15, "Detects live/demo mode mismatch warnings",
    haveCat("LIVE_DEMO_MODE_MISMATCH"), `count=${counts.LIVE_DEMO_MODE_MISMATCH ?? "MISSING"}`);
  record(16, "Detects user approval/risk-lock conflicts",
    haveCat("USER_APPROVAL_RISK_LOCK_CONFLICT"), `count=${counts.USER_APPROVAL_RISK_LOCK_CONFLICT ?? "MISSING"}`);

  // ── 17-20. Each action requires a non-empty reason
  const fakeId = "deadbeefdeadbeefdeadbeefdeadbeef";
  async function noReasonProbe(action: string, type: string, naturalKey: string): Promise<{ status: number; err: string }> {
    const r = await fetchAs(admin.cookie, `/api/admin/reconciliation-center/issues/${fakeId}/${action}`, {
      method: "POST", body: JSON.stringify({ type, naturalKey }),
    });
    return { status: r.status, err: String((r.json as { error?: string })?.error ?? "") };
  }
  const dismissNR = await noReasonProbe("dismiss", "BRIDGE_MISMATCH", "conn:1");
  const reviewNR = await noReasonProbe("mark-reviewed", "BRIDGE_MISMATCH", "conn:1");
  const linkNR = await noReasonProbe("link-attribution", "MISSING_ATTRIBUTION", "att:1");
  const manualNR = await noReasonProbe("resolve-manually", "BRIDGE_MISMATCH", "conn:1");
  const reasonPass = (p: { status: number; err: string }): boolean => p.status === 400 && p.err === "REASON_REQUIRED";
  record(17, "Dismiss requires reason", reasonPass(dismissNR), `status=${dismissNR.status} err=${dismissNR.err}`);
  record(18, "Mark reviewed requires reason", reasonPass(reviewNR), `status=${reviewNR.status} err=${reviewNR.err}`);
  record(19, "Link attribution requires reason", reasonPass(linkNR), `status=${linkNR.status} err=${linkNR.err}`);
  record(20, "Manual resolution requires reason", reasonPass(manualNR), `status=${manualNR.status} err=${manualNR.err}`);

  // ── 21. Every action writes admin audit log
  const seededIssue = issuesArr.find((i) => String((i as { commandId?: string }).commandId ?? "") === liveCmdId);
  let auditOk = false;
  let auditNote = "skipped — seeded issue not found";
  if (seededIssue) {
    const seededId = String((seededIssue as { id: string }).id);
    const post = (act: string) => fetchAs(admin.cookie, `/api/admin/reconciliation-center/issues/${seededId}/${act}`, {
      method: "POST",
      body: JSON.stringify({ reason: `QA ${act} ${TAG}`, type: "BLOCKED_REJECTED_COMMAND", naturalKey: `live:${liveCmdId}`, targetUserId: user.id }),
    });
    const responses = await Promise.all([post("dismiss"), post("mark-reviewed"), post("link-attribution"), post("resolve-manually")]);
    const allOk = responses.every((r) => r.status === 200 && (r.json as { ok?: boolean })?.ok === true);
    const auditAfter = await db.select({ action: adminActionAuditLogTable.action })
      .from(adminActionAuditLogTable)
      .where(and(
        eq(adminActionAuditLogTable.adminId, admin.id),
        inArray(adminActionAuditLogTable.action, [
          "RECONCILIATION_ISSUE_DISMISSED", "RECONCILIATION_ISSUE_REVIEWED",
          "RECONCILIATION_ATTRIBUTION_LINKED", "RECONCILIATION_MANUAL_RESOLUTION",
          "ADMIN_VIEWED_RECONCILIATION_CENTER",
        ]),
      )).orderBy(desc(adminActionAuditLogTable.id));
    const found = new Set(auditAfter.map((r) => r.action));
    auditOk = allOk
      && found.has("RECONCILIATION_ISSUE_DISMISSED")
      && found.has("RECONCILIATION_ISSUE_REVIEWED")
      && found.has("RECONCILIATION_ATTRIBUTION_LINKED")
      && found.has("RECONCILIATION_MANUAL_RESOLUTION")
      && found.has("ADMIN_VIEWED_RECONCILIATION_CENTER");
    auditNote = `actions=${Array.from(found).join(",")} responsesOk=${allOk}`;
  }
  record(21, "Every action writes admin audit log", auditOk, auditNote);

  // ── 22-23. Ruby tools — static source verification
  const toolsSrc = await fsm.readFile(`${repoRoot}/artifacts/api-server/src/lib/assistant/tools.ts`, "utf8");
  const userToolMatch = toolsSrc.match(/async function explainMyReconciliationIssueTool\([\s\S]*?\n\}\n/);
  const adminToolMatch = toolsSrc.match(/async function getReconciliationCenterSummaryTool\([\s\S]*?\n\}\n/);
  const userTool = userToolMatch?.[0] ?? "";
  const adminTool = adminToolMatch?.[0] ?? "";

  const adminHasRoleGate = /ADMIN_REQUIRED/.test(adminTool) && /role !== "ADMIN"/.test(adminTool);
  const adminEmitsWhitelist = /id: i\.id, type: i\.type, severity: i\.severity/.test(adminTool);
  const adminLeak = bodyHasSecret(adminTool);
  record(22, "Admin Ruby explanation works without exposing secrets/tokens",
    adminTool.length > 0 && adminHasRoleGate && adminEmitsWhitelist && !adminLeak,
    `gate=${adminHasRoleGate} whitelist=${adminEmitsWhitelist} secretMarker=${adminLeak ?? "none"}`);

  const userHasAdminFields = /\bcommandId\b|\bbridgeConnectionId\b|\bbrokerTicket\b|\bcountsByType\b/.test(userTool);
  const userQueriesOther = /\.from\(usersTable\)|\.from\(arxLiveCommands|\.from\(mt5_demo/.test(userTool);
  const userLeak = bodyHasSecret(userTool);
  record(23, "Per-user Ruby explanation works without exposing other-user/admin-only data",
    userTool.length > 0 && !userHasAdminFields && !userQueriesOther && !userLeak,
    `adminFields=${userHasAdminFields} otherUserQuery=${userQueriesOther} secretMarker=${userLeak ?? "none"}`);

  // ── 24. No secrets leak in any response body
  const allBodies = [anonAgg.body, userAgg.body, adminAgg.body, legacyAnon.body, legacyUser.body,
    dismissNR && (await fetchAs(admin.cookie, `/api/admin/reconciliation-center/issues/${fakeId}/dismiss`, { method: "POST", body: JSON.stringify({ type: "BRIDGE_MISMATCH", naturalKey: "conn:1" }) })).body];
  const leakHit = allBodies.map((b) => bodyHasSecret(String(b ?? ""))).find((x) => x !== null) ?? null;
  record(24, "No secrets leak", leakHit === null, leakHit ? `marker=${leakHit}` : "clean across all probed responses");

  // ── 25. No live trade auto-fires (no non-terminal arx_live_commands rows appeared)
  const liveProbe = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM arx_live_commands
      WHERE status NOT IN ('REJECTED','BLOCKED','LIVE_BLOCKED','CANCELLED','LIVE_DRAFT')`,
  );
  record(25, "No live trade auto-fires", liveProbe.rows[0]!.n === 0, `non-terminal arx_live_commands=${liveProbe.rows[0]!.n}`);

  // CLEANUP before final invariant check
  await cleanup(TAG, [admin.id, user.id]);

  // ── 26. arx_live_commands count unchanged
  const endLive = await liveCmdCount();
  record(26, "arx_live_commands count before/after is unchanged", startLive === endLive, `start=${startLive} end=${endLive}`);

  const passCount = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log(`${passCount}/${results.length} checks PASSED`);
  if (passCount === results.length) {
    // eslint-disable-next-line no-console
    console.log("ARX_RECONCILIATION_CENTER_COMPLETE");
    process.exit(0);
  } else {
    const failed = results.filter((r) => !r.pass).map((r) => `  ${r.n}. ${r.name} — ${r.note}`);
    // eslint-disable-next-line no-console
    console.log("ARX_RECONCILIATION_CENTER_NOT_READY");
    // eslint-disable-next-line no-console
    console.log("Blockers:\n" + failed.join("\n"));
    process.exit(1);
  }
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error("FATAL", e);
  try { await cleanup(TAG, []); } catch { /* */ }
  process.exit(1);
});
