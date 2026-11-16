// qaInvestorIsolationDeny.ts — End-to-end proof (Task #75) that:
//
//   1. ISOLATION — investor A's /me/investor/* reads NEVER return investor B's
//      rows (and vice versa). Cross-tenant leakage is checked at two levels:
//      the other investor's seed marker string, and a structural `userId` leak.
//   2. INVESTOR-DENY — an INVESTOR session is refused (403) on every /api/admin/*
//      surface and on every trade-execution endpoint. Anonymous callers get 401.
//   3. ALLOCATION LIFECYCLE — submit (PENDING_APPROVAL) → approve (ACTIVE +
//      profile risk updated) → re-submit + approve (prior ACTIVE → SUPERSEDED) →
//      reject requires a note (empty note 400, valid note REJECTED).
//
// This is a real-auth runtime test: it seeds two INVESTOR accounts + one ADMIN,
// each with a genuine per-user session cookie, and drives the live API through
// the shared proxy (localhost:80). It adds defense-in-depth on top of the
// static CI guards (perUserIsolationMeRoutes, product-role-enforcement).
//
// SAFETY: this script NEVER triggers a live broker dispatch. The starting
// arx_live_commands count is asserted to be unchanged at the end. All seeded
// rows (users, sessions, investor data, audit rows) are removed in cleanup.
//
// Exit code 0 on PASS, 1 on FAIL.

import { randomBytes, createHash } from "node:crypto";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  investorProfilesTable,
  investorLedgerEntriesTable,
  investorAllocationPreferencesTable,
  investorStatementsTable,
  adminActionAuditLogTable,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

// Inlined to avoid crossing the scripts rootDir into artifacts/api-server.
// Must stay byte-equivalent to artifacts/api-server/src/lib/auth/userSessions.ts.
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
async function createUserSession(userId: number): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: "qaInvestorIsolationDeny",
  });
  return rawToken;
}

const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaInv_${Date.now()}_${randomBytes(3).toString("hex")}`;

type Probe = { name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${note}`);
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

type Actor = {
  id: number;
  email: string;
  cookie: string;
  marker: string;
};

async function createActor(label: string, role: "INVESTOR" | "ADMIN"): Promise<Actor> {
  const email = `${TAG}_${label}@arx.test`;
  const [u] = await db
    .insert(usersTable)
    .values({ email, name: `${TAG} ${label}`, role })
    .returning();
  const userId = u!.id;
  const raw = await createUserSession(userId);
  return {
    id: userId,
    email,
    cookie: `${USER_SESSION_COOKIE}=${raw}`,
    marker: `${TAG}_MARK_${label}`,
  };
}

// Seed an investor's per-user data with a distinctive marker so cross-tenant
// leakage is observable in any response body.
async function seedInvestor(actor: Actor): Promise<void> {
  await db.insert(investorProfilesTable).values({
    userId: actor.id,
    displayName: `${actor.marker}_name`,
    baseCurrency: "USD",
    status: "active",
  });
  await db.insert(investorLedgerEntriesTable).values({
    userId: actor.id,
    entryType: "DEPOSIT",
    signedAmount: 10000,
    currency: "USD",
    reason: `${actor.marker}_deposit`,
    createdByAdminId: 0,
  });
  await db.insert(investorStatementsTable).values({
    userId: actor.id,
    title: `${actor.marker}_statement`,
    statementType: "STATEMENT",
    summary: `${actor.marker}_summary`,
    createdByAdminId: 0,
  });
}

type Resp = { status: number; bodyText: string; json: Record<string, unknown> | null };
async function req(
  actor: Actor | null,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Resp> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (actor) headers["cookie"] = actor.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const bodyText = await r.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: r.status, bodyText, json };
}

const INVESTOR_READ_ENDPOINTS = [
  "/api/me/investor/overview",
  "/api/me/investor/allocation",
  "/api/me/investor/performance",
  "/api/me/investor/exposure",
  "/api/me/investor/activity",
  "/api/me/investor/documents",
];

const ADMIN_ENDPOINTS: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
  { method: "GET", path: "/api/admin/investors" },
  { method: "GET", path: "/api/admin/investor-strategy-profiles" },
];

const EXECUTION_ENDPOINTS: Array<{ method: "POST"; path: string; body: unknown }> = [
  { method: "POST", path: "/api/trade/place", body: { symbol: "EURUSD", side: "BUY", lot: 0.01 } },
  { method: "POST", path: "/api/me/trade-actions", body: { symbol: "EURUSD", side: "BUY" } },
  { method: "POST", path: "/api/me/trade-actions/1/confirm", body: {} },
  { method: "POST", path: "/api/paper/demo-execution/queue", body: {} },
];

async function main(): Promise<void> {
  const startLive = await liveCommandsCount();
  // eslint-disable-next-line no-console
  console.log(`[INVARIANT] starting arx_live_commands count = ${startLive}`);

  let investorA: Actor | null = null;
  let investorB: Actor | null = null;
  let admin: Actor | null = null;

  try {
    investorA = await createActor("A", "INVESTOR");
    investorB = await createActor("B", "INVESTOR");
    admin = await createActor("ADM", "ADMIN");
    await seedInvestor(investorA);
    await seedInvestor(investorB);
    record("00_seed", true, `A=${investorA.id} B=${investorB.id} admin=${admin.id}`);

    // ── 1. Anonymous gets 401 on every investor read ────────────────────────
    let anonOk = 0;
    for (const ep of INVESTOR_READ_ENDPOINTS) {
      const r = await req(null, "GET", ep);
      if (r.status === 401) anonOk++;
    }
    record(
      "01_anon_401_on_all_reads",
      anonOk === INVESTOR_READ_ENDPOINTS.length,
      `${anonOk}/${INVESTOR_READ_ENDPOINTS.length} returned 401`,
    );

    // ── 2. Cross-tenant isolation on every investor read ────────────────────
    let leaks = 0;
    let aReadOk = 0;
    const leakDetail: string[] = [];
    for (const ep of INVESTOR_READ_ENDPOINTS) {
      const ra = await req(investorA, "GET", ep);
      const rb = await req(investorB, "GET", ep);
      if (ra.status === 200) aReadOk++;
      // marker leak — any status
      if (ra.bodyText.includes(investorB.marker)) {
        leaks++; leakDetail.push(`A→${ep}[${ra.status}] leaked B marker`);
      }
      if (rb.bodyText.includes(investorA.marker)) {
        leaks++; leakDetail.push(`B→${ep}[${rb.status}] leaked A marker`);
      }
      // structural userId leak — only on 2xx
      if (ra.status === 200 && new RegExp(`"user_?[Ii]d"\\s*:\\s*${investorB.id}\\b`).test(ra.bodyText)) {
        leaks++; leakDetail.push(`A→${ep} leaked B.id structurally`);
      }
      if (rb.status === 200 && new RegExp(`"user_?[Ii]d"\\s*:\\s*${investorA.id}\\b`).test(rb.bodyText)) {
        leaks++; leakDetail.push(`B→${ep} leaked A.id structurally`);
      }
    }
    record(
      "02_no_cross_tenant_leak",
      leaks === 0,
      leaks === 0
        ? `all ${INVESTOR_READ_ENDPOINTS.length} reads clean (A got ${aReadOk} 2xx)`
        : leakDetail.join(" | "),
    );

    // ── 3. Investor refused (403) on every admin surface ────────────────────
    let adminDenied = 0;
    const adminDetail: string[] = [];
    for (const ep of ADMIN_ENDPOINTS) {
      const r = await req(investorA, ep.method, ep.path, ep.body);
      if (r.status === 403) adminDenied++;
      else adminDetail.push(`${ep.path}=${r.status}`);
    }
    // Also a parameterized admin detail + the approve/reject mutations.
    for (const ep of [
      { method: "GET" as const, path: `/api/admin/investors/${investorB.id}` },
      { method: "POST" as const, path: `/api/admin/investors/${investorB.id}/allocation/1/approve`, body: {} },
      { method: "POST" as const, path: `/api/admin/investors/${investorB.id}/allocation/1/reject`, body: { note: "x" } },
    ]) {
      const r = await req(investorA, ep.method, ep.path, ep.body);
      if (r.status === 403) adminDenied++;
      else adminDetail.push(`${ep.path}=${r.status}`);
    }
    const totalAdmin = ADMIN_ENDPOINTS.length + 3;
    record(
      "03_investor_403_on_admin",
      adminDenied === totalAdmin,
      adminDenied === totalAdmin ? `${adminDenied}/${totalAdmin} returned 403` : adminDetail.join(" | "),
    );

    // ── 4. Investor refused (403) on every trade-execution endpoint ─────────
    let execDenied = 0;
    const execDetail: string[] = [];
    for (const ep of EXECUTION_ENDPOINTS) {
      const r = await req(investorA, ep.method, ep.path, ep.body);
      if (r.status === 403) execDenied++;
      else execDetail.push(`${ep.path}=${r.status}`);
    }
    record(
      "04_investor_403_on_execution",
      execDenied === EXECUTION_ENDPOINTS.length,
      execDenied === EXECUTION_ENDPOINTS.length
        ? `${execDenied}/${EXECUTION_ENDPOINTS.length} returned 403`
        : execDetail.join(" | "),
    );

    // ── 5. Allocation lifecycle: submit → PENDING_APPROVAL ──────────────────
    const submit1 = await req(investorA, "POST", "/api/me/investor/allocation", {
      profileKey: "CONSERVATIVE",
      riskDisclosureAccepted: true,
    });
    const pending1 = (submit1.json?.pending ?? null) as { id?: number; status?: string } | null;
    record(
      "05_submit_creates_pending",
      submit1.status === 200 && pending1?.status === "PENDING_APPROVAL" && typeof pending1?.id === "number",
      `status=${submit1.status} pending=${JSON.stringify(pending1)}`,
    );

    // ── 6. Disclosure is required ───────────────────────────────────────────
    const submitNoDisc = await req(investorA, "POST", "/api/me/investor/allocation", {
      profileKey: "BALANCED",
      riskDisclosureAccepted: false,
    });
    record(
      "06_disclosure_required",
      submitNoDisc.status === 400 && submitNoDisc.json?.error === "DISCLOSURE_REQUIRED",
      `status=${submitNoDisc.status} error=${String(submitNoDisc.json?.error)}`,
    );

    // ── 7. Admin approve → ACTIVE + profile risk profile updated ────────────
    const prefId1 = pending1!.id!;
    const approve1 = await req(admin, "POST", `/api/admin/investors/${investorA.id}/allocation/${prefId1}/approve`, {
      note: "first approval",
    });
    const [prefRow1] = await db
      .select()
      .from(investorAllocationPreferencesTable)
      .where(eq(investorAllocationPreferencesTable.id, prefId1));
    const [profRow1] = await db
      .select()
      .from(investorProfilesTable)
      .where(eq(investorProfilesTable.userId, investorA.id));
    record(
      "07_approve_activates_and_updates_profile",
      approve1.status === 200 && prefRow1?.status === "ACTIVE" && profRow1?.currentRiskProfile === "CONSERVATIVE",
      `status=${approve1.status} prefStatus=${prefRow1?.status} risk=${profRow1?.currentRiskProfile}`,
    );

    // ── 8. Re-submit + approve → prior ACTIVE becomes SUPERSEDED ─────────────
    const submit2 = await req(investorA, "POST", "/api/me/investor/allocation", {
      profileKey: "BALANCED",
      riskDisclosureAccepted: true,
    });
    const pending2 = (submit2.json?.pending ?? null) as { id?: number } | null;
    const prefId2 = pending2!.id!;
    const approve2 = await req(admin, "POST", `/api/admin/investors/${investorA.id}/allocation/${prefId2}/approve`, {
      note: "second approval",
    });
    const [prefRow1After] = await db
      .select()
      .from(investorAllocationPreferencesTable)
      .where(eq(investorAllocationPreferencesTable.id, prefId1));
    const [prefRow2] = await db
      .select()
      .from(investorAllocationPreferencesTable)
      .where(eq(investorAllocationPreferencesTable.id, prefId2));
    const [profRow2] = await db
      .select()
      .from(investorProfilesTable)
      .where(eq(investorProfilesTable.userId, investorA.id));
    record(
      "08_approve_supersedes_prior_active",
      approve2.status === 200 &&
        prefRow1After?.status === "SUPERSEDED" &&
        prefRow1After?.supersededAt != null &&
        prefRow2?.status === "ACTIVE" &&
        profRow2?.currentRiskProfile === "BALANCED",
      `prior=${prefRow1After?.status} new=${prefRow2?.status} risk=${profRow2?.currentRiskProfile}`,
    );

    // ── 9. Reject requires a note (empty → 400) ─────────────────────────────
    const submit3 = await req(investorA, "POST", "/api/me/investor/allocation", {
      profileKey: "CONSERVATIVE",
      riskDisclosureAccepted: true,
    });
    const pending3 = (submit3.json?.pending ?? null) as { id?: number } | null;
    const prefId3 = pending3!.id!;
    const rejectNoNote = await req(admin, "POST", `/api/admin/investors/${investorA.id}/allocation/${prefId3}/reject`, {});
    record(
      "09_reject_requires_note",
      rejectNoNote.status === 400,
      `empty-note reject status=${rejectNoNote.status} (expected 400)`,
    );

    // ── 10. Reject with note → REJECTED; ACTIVE pref untouched ──────────────
    const rejectWithNote = await req(admin, "POST", `/api/admin/investors/${investorA.id}/allocation/${prefId3}/reject`, {
      note: "not aligned with mandate",
    });
    const [prefRow3] = await db
      .select()
      .from(investorAllocationPreferencesTable)
      .where(eq(investorAllocationPreferencesTable.id, prefId3));
    const [prefRow2Still] = await db
      .select()
      .from(investorAllocationPreferencesTable)
      .where(eq(investorAllocationPreferencesTable.id, prefId2));
    record(
      "10_reject_with_note_rejects",
      rejectWithNote.status === 200 &&
        prefRow3?.status === "REJECTED" &&
        prefRow3?.reviewNote === "not aligned with mandate" &&
        prefRow2Still?.status === "ACTIVE",
      `rejected=${prefRow3?.status} note=${String(prefRow3?.reviewNote)} activeStill=${prefRow2Still?.status}`,
    );
  } catch (e) {
    record("FATAL", false, `unexpected error: ${(e as Error).message}`);
  } finally {
    // ── Cleanup every seeded row ──────────────────────────────────────────
    const ids = [investorA?.id, investorB?.id, admin?.id].filter((x): x is number => typeof x === "number");
    try {
      if (ids.length > 0) {
        await db.delete(investorAllocationPreferencesTable).where(inArray(investorAllocationPreferencesTable.userId, ids));
        await db.delete(investorLedgerEntriesTable).where(inArray(investorLedgerEntriesTable.userId, ids));
        await db.delete(investorStatementsTable).where(inArray(investorStatementsTable.userId, ids));
        await db.delete(investorProfilesTable).where(inArray(investorProfilesTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.targetUserId, ids));
        await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
      }
    } catch (e) {
      record("99_cleanup", false, `cleanup failed: ${(e as Error).message}`);
    }
  }

  // ── Final invariant: no live command was ever created ─────────────────────
  const endLive = await liveCommandsCount();
  record("98_no_live_command_created", endLive === startLive, `start=${startLive} end=${endLive}`);

  const failed = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`} — ${results.length} checks total`);
  await pool.end().catch(() => {});
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error(`[FATAL] ${(e as Error).message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
