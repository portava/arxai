// qaLaunchReadiness.ts — Production Launch Readiness Checklist acceptance proof.
//
// Seeds one ADMIN + one regular USER. Asserts:
//   * anon  → /admin/launch-readiness → 401/403
//   * user  → /admin/launch-readiness → 403
//   * admin → 200, has required shape (env, envSummary, safety, counts,
//             modeContext, launchBlockers, noLiveCommandEvidence, computedAt)
//   * env checklist has presence-only items (no string values look like secrets)
//   * no secret markers in any response body
//   * arx_live_commands count strict-zero before+after
//   * GET writes ADMIN_VIEWED_LAUNCH_READINESS to admin_action_audit_log
//
// Exit code 0 on PASS, 1 on FAIL.

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import { usersTable, authUserSessionsTable, adminActionAuditLogTable } from "@workspace/db/schema";
import { eq, inArray, desc } from "drizzle-orm";

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaLR_${Date.now()}_${randomBytes(3).toString("hex")}`;

type Probe = { name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${note}`);
}

async function createSession(userId: number): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId, tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1", userAgent: TAG,
  });
  return rawToken;
}

async function liveCmdCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

async function seedUser(label: "ADMIN" | "USER"): Promise<{ id: number; cookie: string }> {
  const email = `${TAG}_${label.toLowerCase()}@arx.test`;
  const [u] = await db.insert(usersTable).values({
    email, name: `${TAG} ${label}`, role: label,
  }).returning();
  const userId = u!.id;
  const token = await createSession(userId);
  return { id: userId, cookie: `${USER_SESSION_COOKIE}=${token}` };
}

// Markers that should NEVER appear in any response body. Note: env var NAMES
// like MT5_BRIDGE_TOKEN / SESSION_SECRET / ARX_LIVE_BROKER_EXECUTION_ENABLED
// are legitimately echoed by the env checklist as part of its presence-only
// contract — the contract is "no VALUES", proven separately by the
// env-presence-only-no-value-field assertion. We probe for *value-shaped*
// markers only.
const SECRET_MARKERS = [
  "apiKeyHash", "tokenHash", "X-MT5-Bridge-Token",
];
function bodyContainsSecret(body: string): string | null {
  for (const m of SECRET_MARKERS) if (body.includes(m)) return m;
  return null;
}

async function fetchAs(cookie: string | null, path: string): Promise<{ status: number; body: string; json: unknown }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${BASE}${path}`, { headers });
  const body = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* */ }
  return { status: r.status, body, json };
}

async function main() {
  const startLive = await liveCmdCount();
  console.log(`[setup] arx_live_commands start count = ${startLive}`);

  const admin = await seedUser("ADMIN");
  const user = await seedUser("USER");

  // anon
  const a = await fetchAs(null, "/api/admin/launch-readiness");
  record("anon-blocked", a.status === 401 || a.status === 403, `status=${a.status}`);

  // user
  const u = await fetchAs(user.cookie, "/api/admin/launch-readiness");
  record("user-blocked", u.status === 403, `status=${u.status}`);

  // admin
  const ad = await fetchAs(admin.cookie, "/api/admin/launch-readiness");
  record("admin-200", ad.status === 200, `status=${ad.status}`);

  const payload = (ad.json as { ok?: boolean; readiness?: Record<string, unknown> } | null);
  const r = payload?.readiness ?? null;
  const requiredKeys = ["env", "envSummary", "safety", "counts", "modeContext", "launchBlockers", "noLiveCommandEvidence", "computedAt"];
  const missing = r ? requiredKeys.filter((k) => !(k in r)) : requiredKeys;
  record("admin-shape", payload?.ok === true && missing.length === 0, `ok=${payload?.ok} missing=${JSON.stringify(missing)}`);

  // env subsection
  const e = await fetchAs(admin.cookie, "/api/admin/launch-readiness/env");
  const ej = e.json as { ok?: boolean; env?: Array<Record<string, unknown>>; summary?: Record<string, unknown> } | null;
  record("admin-env-200", e.status === 200 && ej?.ok === true && Array.isArray(ej?.env) && ej!.env!.length >= 8, `status=${e.status} count=${ej?.env?.length ?? 0}`);

  // env items must NOT contain a "value" field (presence-only contract)
  const envItems = ej?.env ?? [];
  const hasValueField = envItems.some((it) => "value" in it);
  record("env-presence-only-no-value-field", !hasValueField, hasValueField ? "FOUND value field in env item" : "no value field on any env item");

  // env items must contain required keys
  const envShapeOk = envItems.every((it) => "varName" in it && "present" in it && "required" in it && "scope" in it && "note" in it);
  record("env-item-shape", envShapeOk, envShapeOk ? "all items have varName/present/required/scope/note" : "missing keys on some items");

  // user blocked from env subroute
  const ue = await fetchAs(user.cookie, "/api/admin/launch-readiness/env");
  record("user-blocked-env", ue.status === 403, `status=${ue.status}`);

  // no secret markers across all responses
  for (const r2 of [a, u, ad, e, ue]) {
    const hit = bodyContainsSecret(r2.body);
    if (hit) { record("no-secret-markers", false, `LEAKED: ${hit} in body`); break; }
  }
  if (!results.find((x) => x.name === "no-secret-markers")) record("no-secret-markers", true, "all responses clean");

  // safety subsection shape
  const safety = (r?.safety as Record<string, unknown> | undefined) ?? {};
  const safetyOk = ["platformMode", "emergencyKillSwitch", "sharedLiveTradingEnabled", "accountRoutingMode"].every((k) => k in safety);
  record("safety-shape", safetyOk, safetyOk ? `keys present (platformMode=${String(safety.platformMode)})` : "missing safety keys");

  // counts shape
  const counts = (r?.counts as Record<string, unknown> | undefined) ?? {};
  const countsOk = "arxLiveCommandsTotal" in counts && counts.arxLiveCommandsTotal === 0;
  record("counts-arx-live-zero", countsOk, `arxLiveCommandsTotal=${counts.arxLiveCommandsTotal}`);

  // noLiveCommandEvidence is ok=true with strict-zero
  const evidence = (r?.noLiveCommandEvidence as { ok?: boolean; arxLiveCommandsCount?: number } | undefined) ?? {};
  record("evidence-strict-zero", evidence.ok === true && evidence.arxLiveCommandsCount === 0, `ok=${evidence.ok} count=${evidence.arxLiveCommandsCount}`);

  // audit-the-view: admin_action_audit_log gained an ADMIN_VIEWED_LAUNCH_READINESS row for this admin
  const auditRows = await db.select().from(adminActionAuditLogTable)
    .where(eq(adminActionAuditLogTable.adminId, admin.id))
    .orderBy(desc(adminActionAuditLogTable.createdAt))
    .limit(5);
  const viewed = auditRows.some((r3) => r3.action === "ADMIN_VIEWED_LAUNCH_READINESS");
  record("audit-the-view", viewed, viewed ? "row written" : "no audit row for ADMIN_VIEWED_LAUNCH_READINESS");

  const endLive = await liveCmdCount();
  record("arx_live_commands-unchanged", startLive === endLive, `start=${startLive} end=${endLive}`);
  record("arx_live_commands-strict-zero", startLive === 0 && endLive === 0, `start=${startLive} end=${endLive} (both must be 0)`);

  // cleanup
  try {
    await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.adminId, [admin.id, user.id]));
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, [admin.id, user.id]));
    await db.delete(usersTable).where(inArray(usersTable.id, [admin.id, user.id]));
  } catch { /* best-effort */ }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks PASSED`);
  await pool.end();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await pool.end(); } catch { /* */ }
  process.exit(1);
});
