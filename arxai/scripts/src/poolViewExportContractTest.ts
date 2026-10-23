// poolViewExportContractTest.ts — Pool-view evidence exporter acceptance proof.
//
// Guards the new /api/admin/audit/pool-views/export handler against
// regressions. Pool-view exports are used as incident-report evidence, so we
// prove:
//
//   * Anonymous → 401 (globalGate) or 403.
//   * Regular user → 403 ADMIN_OR_OWNER_REQUIRED (JSON and CSV).
//   * Admin bad format (?format=xls) → 400 INVALID_FORMAT.
//   * Admin → JSON export → 200 with the full evidence envelope
//     (exportId, exportedAt, adminId, filtersUsed, eventCount, sha256,
//     disclaimer, redactionNote, views) and a 64-hex checksum.
//   * The returned sha256 actually matches a SHA-256 recomputed over the
//     returned `views` array (the checksum is honest evidence).
//   * adminId in the envelope == the exporting admin's id.
//   * Admin → CSV export → 200 with the # exportId / # exportedAt /
//     # adminId / # eventCount / # sha256 / # disclaimer header lines and
//     the id,adminId,adminEmail,adminRole,ipAddress,createdAt column row.
//   * from / to / dedupe filters each change the exported output.
//   * ROLE-SCOPED IP REDACTION: raw operator IPs are OWNER-only. In both the
//     on-screen list and the JSON/CSV export, an OWNER session sees the real
//     ipAddress while an ADMIN session (a non-owner) sees "[REDACTED]". The
//     adminEmail stays visible to both tiers so the "who viewed" feed remains
//     useful. (admin-previewing-as-user is blocked one tier up with 403.)
//   * Every successful export writes exactly one ADMIN_EXPORTED_AUDIT row
//     scoped "pool-views" — proven with baseline-delta bookkeeping (the
//     audit table is append-only; we never assert count == 0).
//   * No secret markers leak into any response body.
//   * arx_live_commands is unchanged (the export surface never trades).
//
// Exit code 0 on PASS, 1 on FAIL.

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  adminActionAuditLogTable,
} from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaPVX_${Date.now()}_${randomBytes(3).toString("hex")}`;

// Isolated date window far from any real rows so the from/to filter probes
// are deterministic regardless of what else is in admin_action_audit_log.
const T0 = "2001-01-01T00:00:00.000Z"; // rowA — exporting admin
const T1 = "2001-01-01T00:01:00.000Z"; // rowB — same admin (dedupe target)
const T2 = "2001-01-01T00:02:00.000Z"; // rowC — second admin
const WINDOW_FROM = "2001-01-01T00:00:00.000Z";
const WINDOW_TO = "2001-01-01T01:00:00.000Z";

type PoolViewRow = {
  id: number;
  adminId: number | null;
  adminEmail: string | null;
  adminRole: string;
  ipAddress: string | null;
  createdAt: string;
};

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

async function seedUser(label: "ADMIN" | "USER" | "ADMIN2" | "OWNER"): Promise<{ id: number; cookie: string }> {
  const role = label === "USER" ? "USER" : label === "OWNER" ? "OWNER" : "ADMIN";
  const email = `${TAG}_${label.toLowerCase()}@arx.test`;
  const [u] = await db.insert(usersTable).values({
    email, name: `${TAG} ${label}`, role,
  }).returning();
  const userId = u!.id;
  const token = await createSession(userId);
  return { id: userId, cookie: `${USER_SESSION_COOKIE}=${token}` };
}

async function liveCmdCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

// Baseline-delta bookkeeping for the append-only ADMIN_EXPORTED_AUDIT feed
// scoped to "pool-views". Never asserts count == 0.
async function poolViewExportAuditCount(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(adminActionAuditLogTable)
    .where(and(
      eq(adminActionAuditLogTable.action, "ADMIN_EXPORTED_AUDIT"),
      sql`${adminActionAuditLogTable.afterState}->>'scope' = 'pool-views'`,
    ));
  return rows[0]?.n ?? 0;
}

const SECRET_MARKERS = [
  "MT5_BRIDGE_TOKEN", "SESSION_SECRET", "apiKeyHash", "tokenHash",
  "ARX_LIVE_BROKER_EXECUTION_ENABLED", "X-MT5-Bridge-Token",
];
function bodyContainsSecret(body: string): string | null {
  for (const m of SECRET_MARKERS) if (body.includes(m)) return m;
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

const WIN = `from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent(WINDOW_TO)}`;

async function main() {
  const startLive = await liveCmdCount();

  const admin = await seedUser("ADMIN");
  const admin2 = await seedUser("ADMIN2");
  const user = await seedUser("USER");
  const owner = await seedUser("OWNER");

  // Seed three ALLOCATION_POOL_VIEWED rows in the isolated window:
  //   rowA (T0, admin), rowB (T1, admin — same admin → dedupe), rowC (T2, admin2)
  const seeded = await db.insert(adminActionAuditLogTable).values([
    { adminId: admin.id, adminRole: "ADMIN", action: "ALLOCATION_POOL_VIEWED", ipAddress: "10.0.0.1", createdAt: new Date(T0) },
    { adminId: admin.id, adminRole: "ADMIN", action: "ALLOCATION_POOL_VIEWED", ipAddress: "10.0.0.1", createdAt: new Date(T1) },
    { adminId: admin2.id, adminRole: "ADMIN", action: "ALLOCATION_POOL_VIEWED", ipAddress: "10.0.0.2", createdAt: new Date(T2) },
  ]).returning({ id: adminActionAuditLogTable.id });
  const seededIds = seeded.map((r) => r.id);

  const auditBaseline = await poolViewExportAuditCount();
  let expectedExports = 0;

  try {
    // ─── 1. anonymous blocked ─────────────────────────────────────────────
    const anon = await fetchAs(null, "/api/admin/audit/pool-views/export?format=json");
    record("anon-blocked", anon.status === 401 || anon.status === 403, `status=${anon.status}`);

    // ─── 2. regular user blocked (json + csv) ─────────────────────────────
    const userJson = await fetchAs(user.cookie, "/api/admin/audit/pool-views/export?format=json");
    record("user-blocked-json", userJson.status === 403, `status=${userJson.status}`);
    const userCsv = await fetchAs(user.cookie, "/api/admin/audit/pool-views/export?format=csv");
    record("user-blocked-csv", userCsv.status === 403, `status=${userCsv.status}`);

    // ─── 3. bad format → 400 ──────────────────────────────────────────────
    const bad = await fetchAs(admin.cookie, "/api/admin/audit/pool-views/export?format=xls");
    record("admin-bad-format-400", bad.status === 400, `status=${bad.status}`);
    const bj = bad.json as { error?: string } | null;
    record("admin-bad-format-error-code", bj?.error === "INVALID_FORMAT", `error=${bj?.error}`);

    // ─── 4. admin JSON export within isolated window ──────────────────────
    const expJson = await fetchAs(admin.cookie, `/api/admin/audit/pool-views/export?format=json&${WIN}`);
    expectedExports++;
    record("admin-export-json-200", expJson.status === 200, `status=${expJson.status}`);
    const ej = expJson.json as Record<string, unknown> | null;
    const requiredKeys = ["exportId", "exportedAt", "adminId", "filtersUsed", "eventCount", "sha256", "disclaimer", "redactionNote", "views"];
    const missing = requiredKeys.filter((k) => !ej || !(k in ej));
    record("admin-export-json-envelope", missing.length === 0, `missing=${JSON.stringify(missing)}`);
    record("admin-export-json-checksum-hex", typeof ej?.sha256 === "string" && /^[a-f0-9]{64}$/.test(String(ej?.sha256)),
      `sha256=${String(ej?.sha256).slice(0, 16)}…`);
    record("admin-export-json-adminId-correct", ej?.adminId === admin.id, `got=${ej?.adminId} want=${admin.id}`);
    record("admin-export-json-disclaimer", typeof ej?.disclaimer === "string" && String(ej?.disclaimer).includes("Not a legal"),
      `disclaimer="${String(ej?.disclaimer ?? "").slice(0, 32)}…"`);

    // checksum must match a recompute over the returned views array
    const views = Array.isArray(ej?.views) ? ej!.views : [];
    const recomputed = createHash("sha256").update(JSON.stringify(views)).digest("hex");
    record("admin-export-json-checksum-matches-views", recomputed === ej?.sha256,
      `recomputed=${recomputed.slice(0, 16)}… returned=${String(ej?.sha256).slice(0, 16)}…`);
    record("admin-export-json-eventCount-matches", ej?.eventCount === views.length,
      `eventCount=${ej?.eventCount} views.length=${views.length}`);

    // window should isolate exactly our 3 seeded rows
    const fullCount = Number(ej?.eventCount ?? -1);
    record("admin-export-json-window-isolates-3", fullCount === 3, `eventCount=${fullCount} (want 3)`);

    // filtersUsed should echo the request
    const fu = ej?.filtersUsed as { from?: string; to?: string; dedupe?: boolean; limit?: number } | undefined;
    record("admin-export-json-filtersUsed-echo",
      !!fu && fu.from === WINDOW_FROM && fu.to === WINDOW_TO && fu.dedupe === false,
      `filtersUsed=${JSON.stringify(fu)}`);

    // ─── 5. dedupe filter changes output ──────────────────────────────────
    const expDedupe = await fetchAs(admin.cookie, `/api/admin/audit/pool-views/export?format=json&${WIN}&dedupe=true`);
    expectedExports++;
    const ed = expDedupe.json as { eventCount?: number; filtersUsed?: { dedupe?: boolean } } | null;
    record("admin-export-dedupe-collapses",
      expDedupe.status === 200 && ed?.eventCount === 2 && fullCount === 3,
      `dedupeCount=${ed?.eventCount} fullCount=${fullCount} (3→2 expected)`);
    record("admin-export-dedupe-flag-echo", ed?.filtersUsed?.dedupe === true, `dedupe=${ed?.filtersUsed?.dedupe}`);

    // ─── 6. `from` filter narrows output ──────────────────────────────────
    const fromNarrow = `from=${encodeURIComponent("2001-01-01T00:01:30.000Z")}&to=${encodeURIComponent(WINDOW_TO)}`;
    const expFrom = await fetchAs(admin.cookie, `/api/admin/audit/pool-views/export?format=json&${fromNarrow}`);
    expectedExports++;
    const efr = expFrom.json as { eventCount?: number } | null;
    record("admin-export-from-narrows",
      expFrom.status === 200 && efr?.eventCount === 1 && fullCount === 3,
      `fromCount=${efr?.eventCount} fullCount=${fullCount} (3→1 expected)`);

    // ─── 7. `to` filter narrows output ────────────────────────────────────
    const toNarrow = `from=${encodeURIComponent(WINDOW_FROM)}&to=${encodeURIComponent("2001-01-01T00:00:30.000Z")}`;
    const expTo = await fetchAs(admin.cookie, `/api/admin/audit/pool-views/export?format=json&${toNarrow}`);
    expectedExports++;
    const eto = expTo.json as { eventCount?: number } | null;
    record("admin-export-to-narrows",
      expTo.status === 200 && eto?.eventCount === 1 && fullCount === 3,
      `toCount=${eto?.eventCount} fullCount=${fullCount} (3→1 expected)`);

    // ─── 8. admin CSV export ──────────────────────────────────────────────
    const expCsv = await fetchAs(admin.cookie, `/api/admin/audit/pool-views/export?format=csv&${WIN}`);
    expectedExports++;
    record("admin-export-csv-200", expCsv.status === 200, `status=${expCsv.status}`);
    const csvHeaderLines = ["# exportId,", "# exportedAt,", "# adminId,", "# eventCount,", "# sha256,", "# disclaimer,"];
    const missingCsv = csvHeaderLines.filter((h) => !expCsv.body.includes(h));
    record("admin-export-csv-headers", missingCsv.length === 0, `missing=${JSON.stringify(missingCsv)}`);
    record("admin-export-csv-column-row",
      expCsv.body.includes("id,adminId,adminEmail,adminRole,ipAddress,createdAt"),
      "data column header present");

    // ─── 8b. role-scoped IP redaction (OWNER sees raw, ADMIN redacted) ────
    // The pool-view feed exposes operator IPs. Per the safety boundary, raw
    // operator IPs are OWNER-only; ADMIN (a non-owner) must see them redacted
    // in BOTH the on-screen list and the evidence export, while adminEmail
    // stays visible to every operator tier so the "who viewed" feed is still
    // useful. admin-previewing-as-user is blocked one tier higher (403) and is
    // covered by the user-blocked probes above.

    // List — admin sees redacted IP, raw IP absent, email still present.
    const listAdmin = await fetchAs(admin.cookie, `/api/admin/audit/pool-views?${WIN}`);
    const laViews = ((listAdmin.json as { views?: PoolViewRow[] } | null)?.views) ?? [];
    record("list-admin-200", listAdmin.status === 200, `status=${listAdmin.status}`);
    record("list-admin-ip-redacted",
      laViews.length === 3 && laViews.every((v) => v.ipAddress === "[REDACTED]"),
      `ips=${JSON.stringify(laViews.map((v) => v.ipAddress))}`);
    record("list-admin-ip-no-raw",
      !listAdmin.body.includes("10.0.0.1") && !listAdmin.body.includes("10.0.0.2"),
      "no raw 10.0.0.x in admin list body");
    record("list-admin-email-present",
      laViews.length > 0 && laViews.every((v) => typeof v.adminEmail === "string" && v.adminEmail.length > 0),
      `emails=${JSON.stringify(laViews.map((v) => v.adminEmail))}`);

    // List — owner sees the real IPs.
    const listOwner = await fetchAs(owner.cookie, `/api/admin/audit/pool-views?${WIN}`);
    const loViews = ((listOwner.json as { views?: PoolViewRow[] } | null)?.views) ?? [];
    record("list-owner-200", listOwner.status === 200, `status=${listOwner.status}`);
    record("list-owner-ip-raw",
      loViews.some((v) => v.ipAddress === "10.0.0.1") && loViews.some((v) => v.ipAddress === "10.0.0.2"),
      `ips=${JSON.stringify(loViews.map((v) => v.ipAddress))}`);
    record("list-owner-no-redaction",
      loViews.every((v) => v.ipAddress !== "[REDACTED]"),
      "owner list carries no [REDACTED] ip");

    // Export JSON — admin redacted (reusing the section-4 admin export views).
    record("export-admin-json-ip-redacted",
      views.length === 3 && (views as PoolViewRow[]).every((v) => v.ipAddress === "[REDACTED]"),
      `ips=${JSON.stringify((views as PoolViewRow[]).map((v) => v.ipAddress))}`);
    record("export-admin-json-no-raw-ip",
      !expJson.body.includes("10.0.0.1") && !expJson.body.includes("10.0.0.2"),
      "no raw 10.0.0.x in admin json export");

    // Export JSON — owner raw.
    const ownerJson = await fetchAs(owner.cookie, `/api/admin/audit/pool-views/export?format=json&${WIN}`);
    expectedExports++;
    const ojViews = ((ownerJson.json as { views?: PoolViewRow[] } | null)?.views) ?? [];
    record("export-owner-json-200", ownerJson.status === 200, `status=${ownerJson.status}`);
    record("export-owner-json-ip-raw",
      ojViews.some((v) => v.ipAddress === "10.0.0.1") && ojViews.some((v) => v.ipAddress === "10.0.0.2"),
      `ips=${JSON.stringify(ojViews.map((v) => v.ipAddress))}`);

    // Export CSV — admin redacted (reusing the section-8 admin csv export).
    record("export-admin-csv-ip-redacted",
      expCsv.body.includes("[REDACTED]") && !expCsv.body.includes("10.0.0.1") && !expCsv.body.includes("10.0.0.2"),
      "admin csv masks raw ip");

    // Export CSV — owner raw.
    const ownerCsv = await fetchAs(owner.cookie, `/api/admin/audit/pool-views/export?format=csv&${WIN}`);
    expectedExports++;
    record("export-owner-csv-ip-raw",
      ownerCsv.status === 200 && ownerCsv.body.includes("10.0.0.1") && ownerCsv.body.includes("10.0.0.2"),
      `status=${ownerCsv.status}`);

    // ─── 9. no secret markers in any response body ────────────────────────
    const bodies: Array<[string, string]> = [
      ["export-json", expJson.body],
      ["export-dedupe", expDedupe.body],
      ["export-csv", expCsv.body],
    ];
    let leak: string | null = null;
    for (const [tag, b] of bodies) { const hit = bodyContainsSecret(b); if (hit) { leak = `${tag}:${hit}`; break; } }
    record("no-secret-markers", leak === null, leak ? `leaked: ${leak}` : "all responses clean");

    // ─── 10. ADMIN_EXPORTED_AUDIT (scope pool-views) baseline-delta ───────
    const auditAfter = await poolViewExportAuditCount();
    const delta = auditAfter - auditBaseline;
    record("admin-export-audit-row-per-export",
      delta === expectedExports,
      `baseline=${auditBaseline} after=${auditAfter} delta=${delta} expected=${expectedExports}`);

    // ─── 11. arx_live_commands unchanged ──────────────────────────────────
    const endLive = await liveCmdCount();
    record("arx_live_commands-unchanged", startLive === endLive, `start=${startLive} end=${endLive}`);
  } finally {
    // Clean up only our synthetic fixtures (seeded ALLOCATION_POOL_VIEWED
    // rows, sessions, users). The handler-written ADMIN_EXPORTED_AUDIT rows
    // are append-only evidence and are intentionally left in place — that is
    // exactly why the audit assertion uses baseline-delta bookkeeping.
    if (seededIds.length) {
      await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.id, seededIds));
    }
    const userIds = [admin.id, admin2.id, user.id];
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${passed}/${total} checks ${passed === total ? "PASSED" : "FAILED"}`);
  if (passed !== total) process.exit(1);
}

main().catch((e) => {
  console.error("poolViewExportContractTest failed:", e);
  process.exit(1);
});
