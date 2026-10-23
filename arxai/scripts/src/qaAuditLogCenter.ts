// qaAuditLogCenter.ts — Audit Log Center + Compliance Evidence Export acceptance proof.
//
// Seeds one ADMIN session + one regular USER session and asserts:
//
//   * Anonymous → /admin/audit/center → 401 (via globalGate) or 403.
//   * Regular user → /admin/audit/center → 403 ADMIN_OR_OWNER_REQUIRED.
//   * Regular user → /admin/audit/export → 403.
//   * Admin → /admin/audit/center → 200, normalized event envelope with
//     required keys, categories listed.
//   * Admin → /admin/audit/export?format=json → 200, JSON body contains
//     exportId, exportedAt, adminId, filtersUsed, eventCount, sha256,
//     disclaimer, redactionNote, events.
//   * Admin → /admin/audit/export?format=csv → 200, body starts with
//     # exportId, # exportedAt, # adminId, # eventCount, # sha256,
//     # disclaimer header lines.
//   * No secret markers in any response body (bridge token, apiKeyHash,
//     SESSION_SECRET, MT5_BRIDGE_TOKEN).
//   * arx_live_commands count strict-zero before+after (no live trade
//     fired by the audit center surface).
//
// Exit code 0 on PASS, 1 on FAIL.

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import { usersTable, authUserSessionsTable } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaALC_${Date.now()}_${randomBytes(3).toString("hex")}`;

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

const SECRET_MARKERS = [
  "MT5_BRIDGE_TOKEN", "SESSION_SECRET", "apiKeyHash", "tokenHash",
  "ARX_LIVE_BROKER_EXECUTION_ENABLED", "X-MT5-Bridge-Token",
];
function bodyContainsSecret(body: string): string | null {
  for (const m of SECRET_MARKERS) {
    if (body.includes(m)) return m;
  }
  return null;
}

async function fetchAs(cookie: string | null, path: string): Promise<{ status: number; body: string; json: unknown }> {
  const headers: Record<string, string> = { accept: "application/json,text/csv" };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(`${BASE}${path}`, { headers });
  const body = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* csv ok */ }
  return { status: r.status, body, json };
}

async function main() {
  const startLive = await liveCmdCount();
  console.log(`[setup] arx_live_commands start count = ${startLive}`);

  const admin = await seedUser("ADMIN");
  const user = await seedUser("USER");

  try {
    // ─── 1. anonymous blocked ─────────────────────────────────────────────
    const anon = await fetchAs(null, "/api/admin/audit/center");
    record("anon-blocked", anon.status === 401 || anon.status === 403, `status=${anon.status}`);

    // ─── 2. regular user blocked from center ──────────────────────────────
    const userCenter = await fetchAs(user.cookie, "/api/admin/audit/center");
    record("user-blocked-center", userCenter.status === 403, `status=${userCenter.status}`);

    // ─── 3. regular user blocked from export ──────────────────────────────
    const userExp = await fetchAs(user.cookie, "/api/admin/audit/export?format=json");
    record("user-blocked-export", userExp.status === 403, `status=${userExp.status}`);

    // ─── 4. admin → center 200 + shape ────────────────────────────────────
    const adminCenter = await fetchAs(admin.cookie, "/api/admin/audit/center?limit=50");
    record("admin-center-200", adminCenter.status === 200, `status=${adminCenter.status}`);
    const c = adminCenter.json as { ok?: boolean; events?: unknown[]; categories?: string[]; count?: number } | null;
    record("admin-center-shape", !!c && c.ok === true && Array.isArray(c.events) && Array.isArray(c.categories),
      `ok=${c?.ok} events=${Array.isArray(c?.events)} categories=${JSON.stringify(c?.categories)}`);
    record("admin-center-categories-complete",
      Array.isArray(c?.categories) && ["ADMIN","TRADE","LIVE","SYSTEM"].every((k) => c!.categories!.includes(k)),
      `categories=${JSON.stringify(c?.categories)}`);

    // ─── 5. admin → export JSON ───────────────────────────────────────────
    const expJson = await fetchAs(admin.cookie, "/api/admin/audit/export?format=json&limit=20");
    record("admin-export-json-200", expJson.status === 200, `status=${expJson.status}`);
    const ej = expJson.json as Record<string, unknown> | null;
    const requiredJsonKeys = ["exportId", "exportedAt", "adminId", "filtersUsed", "eventCount", "sha256", "disclaimer", "redactionNote", "events"];
    const missingJson = requiredJsonKeys.filter((k) => !ej || !(k in ej));
    record("admin-export-json-shape", missingJson.length === 0, `missing=${JSON.stringify(missingJson)}`);
    record("admin-export-json-checksum-hex", typeof ej?.sha256 === "string" && /^[a-f0-9]{64}$/.test(String(ej?.sha256)),
      `sha256=${String(ej?.sha256).slice(0, 16)}…`);
    record("admin-export-json-disclaimer-present", typeof ej?.disclaimer === "string" && String(ej?.disclaimer).includes("Not a legal"),
      `disclaimer starts="${String(ej?.disclaimer ?? "").slice(0, 40)}…"`);
    record("admin-export-json-adminId-correct", ej?.adminId === admin.id,
      `got=${ej?.adminId} want=${admin.id}`);

    // ─── 6. admin → export CSV ────────────────────────────────────────────
    const expCsv = await fetchAs(admin.cookie, "/api/admin/audit/export?format=csv&limit=20");
    record("admin-export-csv-200", expCsv.status === 200, `status=${expCsv.status}`);
    const csvHeaderLines = ["# exportId,", "# exportedAt,", "# adminId,", "# eventCount,", "# sha256,", "# disclaimer,"];
    const missingCsv = csvHeaderLines.filter((h) => !expCsv.body.includes(h));
    record("admin-export-csv-headers", missingCsv.length === 0, `missing=${JSON.stringify(missingCsv)}`);

    // ─── 7. no secret markers in any admin response ───────────────────────
    const bodies: Array<[string, string]> = [
      ["center", adminCenter.body],
      ["export-json", expJson.body],
      ["export-csv", expCsv.body],
    ];
    let secretLeak: string | null = null;
    for (const [tag, b] of bodies) {
      const hit = bodyContainsSecret(b);
      if (hit) { secretLeak = `${tag}:${hit}`; break; }
    }
    record("no-secret-markers", secretLeak === null, secretLeak ? `leaked: ${secretLeak}` : "all responses clean");

    // ─── 8. invalid format → 400 ──────────────────────────────────────────
    const bad = await fetchAs(admin.cookie, "/api/admin/audit/export?format=xls");
    record("admin-export-invalid-format-400", bad.status === 400, `status=${bad.status}`);

    // ─── 9. categories endpoint admin-only + presets ──────────────────────
    const userCats = await fetchAs(user.cookie, "/api/admin/audit/categories");
    record("user-blocked-categories", userCats.status === 403, `status=${userCats.status}`);
    const adminCats = await fetchAs(admin.cookie, "/api/admin/audit/categories");
    const ac = adminCats.json as { presets?: unknown[] } | null;
    record("admin-categories-presets", adminCats.status === 200 && Array.isArray(ac?.presets) && ac!.presets!.length >= 5,
      `status=${adminCats.status} presets=${ac?.presets?.length}`);

    // ─── 10. arx_live_commands strict-zero ────────────────────────────────
    const endLive = await liveCmdCount();
    record("arx_live_commands-unchanged", startLive === endLive, `start=${startLive} end=${endLive}`);
    record("arx_live_commands-strict-zero", startLive === 0 && endLive === 0,
      `start=${startLive} end=${endLive} (both must be 0)`);
  } finally {
    // cleanup
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, [admin.id, user.id]));
    await db.delete(usersTable).where(inArray(usersTable.id, [admin.id, user.id]));
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks ${passed === total ? "PASSED" : "FAILED"}`);
  if (passed !== total) process.exit(1);
}

main().catch((e) => {
  console.error("qaAuditLogCenter failed:", e);
  process.exit(1);
});
