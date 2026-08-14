// Test: GET /api/admin/market-data/candle-depth end-to-end against the booted
// app (Task #434).
//
// candleDepthDiagnosticsTest.ts proves the buildCandleDepthReport() service is
// honest. This test proves the HTTP ROUTE's admin gate is wired correctly: the
// "Test Candle Depth" runner must be admin/OWNER-only, reject anonymous callers,
// reject ordinary users (the same effective-USER branch an admin-previewing-as-
// user is auto-downgraded into), require a symbol, and serve the report to an
// admin.
//
// What this proves against the REAL HTTP route (booted Express app, real session):
//   1. Anonymous GET                       → 401 AUTH_REQUIRED.
//   2. Authenticated USER (non-admin) GET  → 403 FORBIDDEN. This is exactly the
//      branch an admin-previewing-as-user lands in: the auth middleware projects
//      the EFFECTIVE role, and requireAdmin gates on it — a USER-effective
//      session can never reach the report.
//   3. Admin GET with NO ?symbol           → 400 SYMBOL_REQUIRED (a single click
//      can never fan provider load across the whole universe).
//   4. Admin GET with ?symbol=EURUSD       → 200 { ok:true, report } whose shape
//      matches the diagnostics contract (six timeframe rows, typed summary).
//
// SAFETY / ISOLATION
//   - Seeds two isolated system users (one USER, one ADMIN, fixed emails) and
//     operates ONLY on their rows. Idempotent: cleans up sessions + users at
//     start and end, even on failure.
//   - Read-only market-data telemetry: only the diagnostics GET is called. Never
//     places a trade, never reaches the EA or a broker, never touches arx_live_*.
//   - CI-safe / self-contained: spins up the REAL Express app in-process on an
//     ephemeral port. Set ARX_QA_BASE_URL to probe an already-running server
//     instead. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:candle-depth-route

import { randomBytes, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, authUserSessionsTable } from "@workspace/db";
import {
  getSharedBaseUrl,
  closeSharedServer,
  isEntrypoint,
  type CiTestResultLike,
} from "./ci/inProcessAppHarness.js";

const USER_EMAIL = "qa+candle-depth-route-user@arx.test";
const ADMIN_EMAIL = "qa+candle-depth-route-admin@arx.test";
const TEST_EMAILS = [USER_EMAIL, ADMIN_EMAIL];

const PATH = "/api/admin/market-data/candle-depth";

let passes = 0;
let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passes++;
    // eslint-disable-next-line no-console
    console.log(`  \u2713 ${label}`);
  } else {
    failures++;
    // eslint-disable-next-line no-console
    console.error(`  \u2717 ${label}`);
  }
}

async function cleanup(): Promise<void> {
  const rows = await db.select().from(usersTable).where(inArray(usersTable.email, TEST_EMAILS));
  const ids = rows.map((u) => u.id);
  if (ids.length) {
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
    await db.delete(usersTable).where(inArray(usersTable.id, ids));
  }
}

async function seedUser(email: string, role: "USER" | "ADMIN"): Promise<string> {
  const inserted = await db.insert(usersTable).values({
    email,
    name: `QA Candle Depth Route ${role}`,
    role,
    isSystemUser: true,
  }).returning();
  const user = inserted[0]!;
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `arx_user_session=${rawToken}`;
}

export async function run(): Promise<CiTestResultLike> {
  passes = 0;
  failures = 0;
  // eslint-disable-next-line no-console
  console.log("candleDepthDiagnosticsRouteTest");
  // eslint-disable-next-line no-console
  console.log("==============================\n");

  await cleanup();

  const baseUrl = await getSharedBaseUrl();

  const get = async (query: string, cookie?: string) => {
    const headers: Record<string, string> = {};
    if (cookie) headers["cookie"] = cookie;
    const res = await fetch(`${baseUrl}${PATH}${query}`, {
      method: "GET",
      headers,
      redirect: "manual",
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json } as { status: number; json: any };
  };

  try {
    const userCookie = await seedUser(USER_EMAIL, "USER");
    const adminCookie = await seedUser(ADMIN_EMAIL, "ADMIN");

    // ── 1. Anonymous → 401 ───────────────────────────────────────────────────
    const anon = await get("?symbol=EURUSD");
    assert(anon.status === 401, `anon GET → 401 (got ${anon.status})`);
    assert(anon.json?.error === "AUTH_REQUIRED", `anon error === "AUTH_REQUIRED" (got ${String(anon.json?.error)})`);

    // ── 2. Authenticated non-admin USER → 403 (preview-as-user downgrade branch)
    const asUser = await get("?symbol=EURUSD", userCookie);
    assert(asUser.status === 403, `non-admin USER GET → 403 (got ${asUser.status})`);
    assert(asUser.json?.error === "FORBIDDEN", `non-admin error === "FORBIDDEN" (got ${String(asUser.json?.error)})`);

    // ── 3. Admin with NO symbol → 400 SYMBOL_REQUIRED ───────────────────────
    const noSymbol = await get("", adminCookie);
    assert(noSymbol.status === 400, `admin GET without ?symbol → 400 (got ${noSymbol.status})`);
    assert(noSymbol.json?.error === "SYMBOL_REQUIRED", `missing-symbol error === "SYMBOL_REQUIRED" (got ${String(noSymbol.json?.error)})`);

    // ── 4. Admin with symbol → 200 + report shape ───────────────────────────
    const ok = await get("?symbol=EURUSD", adminCookie);
    assert(ok.status === 200, `admin GET ?symbol=EURUSD → 200 (got ${ok.status})`);
    assert(ok.json?.ok === true, `admin response ok === true (got ${String(ok.json?.ok)})`);
    const report = ok.json?.report;
    assert(report != null && typeof report === "object", "admin response carries a report object");
    assert(report?.symbol === "EURUSD", `report.symbol === "EURUSD" (got ${String(report?.symbol)})`);
    assert(Array.isArray(report?.rows) && report.rows.length === 6,
      `report.rows has the six canonical timeframes (got ${report?.rows?.length})`);
    assert(report?.summary != null && typeof report.summary.total === "number",
      "report carries a typed summary");
    assert(report?.liveQuote != null && typeof report.liveQuote.present === "boolean",
      "report carries the liveQuote availability block");
    // Honesty: no row may pass while empty/sourceless/unavailable (mirrors the
    // service contract through the real HTTP boundary).
    const dishonest = (report?.rows ?? []).some(
      (r: any) => r.pass && (r.returned === 0 || r.source == null || r.status === "unavailable"),
    );
    assert(!dishonest, "no served row passes while empty/sourceless/unavailable");
  } finally {
    await cleanup();
  }

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "candleDepthDiagnosticsRouteTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    async (r) => {
      await closeSharedServer().catch(() => {});
      process.exit(r.failures > 0 ? 1 : 0);
    },
    async (err) => {
      await cleanup().catch(() => {});
      await closeSharedServer().catch(() => {});
      // eslint-disable-next-line no-console
      console.error("[candleDepthDiagnosticsRouteTest] FAILED:", err);
      process.exit(1);
    },
  );
}
