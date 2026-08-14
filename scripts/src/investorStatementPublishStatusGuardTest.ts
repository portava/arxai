// investorStatementPublishStatusGuardTest.ts — Automated proof (Task #123) that
// the two sibling admin investor-statement mutation endpoints are fail-closed:
//   POST /api/admin/investors/:id/statements                       (publish)
//   POST /api/admin/investors/:id/statements/:statementId/status   (status change)
//
// Task #102 already guards the EDIT (PATCH) and soft-REMOVE (DELETE) paths
// (see investorStatementAdminMutationGuardTest.ts). These two siblings mutate
// the SAME financial records but were not yet covered by the same fail-closed
// proof. The functional qaInvestorStatementTransparency.ts test exercises status
// transitions but does NOT prove audit-insert-failure → full rollback, so a
// regression that moved the audit write outside the transaction would pass it.
//
// Each path must:
//   • write exactly ONE fail-closed admin_action_audit_log row in the SAME
//     transaction as the mutation (audit can never be skipped),
//   • be scoped per investor — a statement from investor A can never be acted on
//     through investor B's id (returns 404, row untouched),
//   • reject non-admin callers (INVESTOR/USER → 403, anonymous → 401),
//   • roll the mutation back entirely if the audit insert fails (fail-closed):
//     no statement row published / no status change + event row persisted, and
//     the route returns 500.
//
// IT PROVES (all against the REAL Express app in-process):
//   1. A successful publish returns 200, creates exactly one statement row and
//      exactly one INVESTOR_STATEMENT_PUBLISH audit row (baseline-delta).
//   2. A successful status change (CORRECT) returns 200, mutates the row, appends
//      exactly one investor_statement_events row, and creates exactly one
//      INVESTOR_STATEMENT_STATUS_CORRECT audit row (baseline-delta).
//   3. A status change through the WRONG investor id returns 404 and does NOT
//      mutate the row, append an event, or write an audit row.
//   4. Non-admin sessions are rejected on BOTH paths: INVESTOR → 403,
//      plain USER → 403, anonymous → 401.
//   5. When the audit insert fails (forced via a temporary BEFORE INSERT trigger
//      on admin_action_audit_log keyed on a sentinel reason), the whole
//      transaction rolls back: the route returns 500, no statement row is
//      published / no status change + event row persists, and no audit row is
//      written.
//
// SAFETY / ISOLATION:
//   - Seeds isolated users (fixed TAG) and operates ONLY on their rows.
//   - Idempotent cleanup of every seeded row at the end, even on failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged at the end.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port (no
//     externally-running server required). Set ARX_QA_BASE_URL to probe an
//     already-running server instead. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:investor-statement-publish-status

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { inArray } from "drizzle-orm";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  investorProfilesTable,
  investorLedgerEntriesTable,
  investorAllocationPreferencesTable,
  investorStatementsTable,
  investorStatementEventsTable,
  adminActionAuditLogTable,
} from "@workspace/db/schema";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaStmtPub_${Date.now()}_${randomBytes(3).toString("hex")}`;
const FAIL_AUDIT_SENTINEL = `${TAG}_FORCE_AUDIT_FAILURE`;
const TRIGGER_NAME = `arx_qa_fail_audit_${randomBytes(4).toString("hex")}`;
const TRIGGER_FN = `arx_qa_fail_audit_fn_${randomBytes(4).toString("hex")}`;

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 60 * 60 * 1000;

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

type Actor = { id: number; email: string; cookie: string };

async function createActor(label: string, role: "INVESTOR" | "ADMIN" | "USER"): Promise<Actor> {
  const email = `${TAG}_${label}@arx.test`;
  const [u] = await db
    .insert(usersTable)
    .values({ email, name: `${TAG} ${label}`, role })
    .returning();
  const userId = u!.id;
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { id: userId, email, cookie: `${USER_SESSION_COOKIE}=${rawToken}` };
}

async function seedProfile(actor: Actor): Promise<void> {
  await db.insert(investorProfilesTable).values({
    userId: actor.id,
    displayName: `${TAG}_name`,
    baseCurrency: "USD",
    status: "active",
  });
}

async function seedStatement(ownerId: number, adminId: number, label: string): Promise<number> {
  const [row] = await db
    .insert(investorStatementsTable)
    .values({
      userId: ownerId,
      title: `${TAG}_${label}`,
      statementType: "STATEMENT",
      summary: `${TAG}_summary_${label}`,
      fileUrl: `https://example.test/${TAG}-${label}.pdf`,
      createdByAdminId: adminId,
    })
    .returning();
  return row!.id;
}

type Resp = { status: number; bodyText: string };
function makeReq(baseUrl: string) {
  return async function req(
    cookie: string | null,
    method: "POST",
    path: string,
    body?: unknown,
  ): Promise<Resp> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (cookie) headers["cookie"] = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, bodyText: await r.text() };
  };
}

async function auditCount(targetUserId: number, action: string): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM admin_action_audit_log WHERE target_user_id = $1 AND action = $2",
    [targetUserId, action],
  );
  return (r.rows[0] as { n: number }).n;
}

async function auditCountByReason(reason: string): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM admin_action_audit_log WHERE reason = $1",
    [reason],
  );
  return (r.rows[0] as { n: number }).n;
}

async function statementCountByTitle(userId: number, title: string): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM investor_statements WHERE user_id = $1 AND title = $2",
    [userId, title],
  );
  return (r.rows[0] as { n: number }).n;
}

async function eventCount(statementId: number): Promise<number> {
  const r = await pool.query(
    "SELECT COUNT(*)::int AS n FROM investor_statement_events WHERE statement_id = $1",
    [statementId],
  );
  return (r.rows[0] as { n: number }).n;
}

async function getStatement(id: number) {
  const rows = await db
    .select()
    .from(investorStatementsTable)
    .where(inArray(investorStatementsTable.id, [id]));
  return rows[0] ?? null;
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

async function installFailAuditTrigger(): Promise<void> {
  await pool.query(
    `CREATE FUNCTION ${TRIGGER_FN}() RETURNS trigger AS $$
     BEGIN
       IF NEW.reason = '${FAIL_AUDIT_SENTINEL}' THEN
         RAISE EXCEPTION 'arx qa forced audit failure';
       END IF;
       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql;`,
  );
  await pool.query(
    `CREATE TRIGGER ${TRIGGER_NAME} BEFORE INSERT ON admin_action_audit_log
     FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}();`,
  );
}

async function dropFailAuditTrigger(): Promise<void> {
  await pool
    .query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON admin_action_audit_log;`)
    .catch(() => {});
  await pool.query(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}();`).catch(() => {});
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("investorStatementPublishStatusGuardTest");
  // eslint-disable-next-line no-console
  console.log("========================================\n");

  const startLive = await liveCommandsCount();

  // ── Resolve a base URL: in-process ephemeral server unless ARX_QA_BASE_URL. ─
  let server: Server | null = null;
  let baseUrl: string;
  if (EXTERNAL_BASE) {
    baseUrl = EXTERNAL_BASE;
    // eslint-disable-next-line no-console
    console.log(`[setup] probing external server at ${baseUrl}\n`);
  } else {
    const app = (await import("../../artifacts/api-server/src/app.js")).default;
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    // eslint-disable-next-line no-console
    console.log(`[setup] in-process app listening on ${baseUrl}\n`);
  }
  const req = makeReq(baseUrl);

  let investorA: Actor | null = null;
  let investorB: Actor | null = null;
  let admin: Actor | null = null;
  let trader: Actor | null = null;

  try {
    investorA = await createActor("A", "INVESTOR");
    investorB = await createActor("B", "INVESTOR");
    admin = await createActor("ADM", "ADMIN");
    trader = await createActor("TRD", "USER");
    await seedProfile(investorA);
    await seedProfile(investorB);

    const publishUrl = (uid: number) => `/api/admin/investors/${uid}/statements`;
    const statusUrl = (uid: number, sid: number) =>
      `/api/admin/investors/${uid}/statements/${sid}/status`;

    // ── 1. Successful publish → 200, one statement row + one PUBLISH audit row ─
    // eslint-disable-next-line no-console
    console.log("1. Successful publish creates one statement row + one INVESTOR_STATEMENT_PUBLISH audit row");
    const publishTitle = `${TAG}_publish_ok`;
    const publishAuditBaseline = await auditCount(investorA.id, "INVESTOR_STATEMENT_PUBLISH");
    const publishStmtBaseline = await statementCountByTitle(investorA.id, publishTitle);
    const publishRes = await req(admin.cookie, "POST", publishUrl(investorA.id), {
      title: publishTitle,
      summary: `${TAG}_publish_summary`,
      reason: "Published the May closing statement.",
    });
    const publishAuditAfter = await auditCount(investorA.id, "INVESTOR_STATEMENT_PUBLISH");
    const publishStmtAfter = await statementCountByTitle(investorA.id, publishTitle);
    assert(publishRes.status === 200, `publish HTTP 200 (got ${publishRes.status})`);
    assert(
      publishStmtAfter - publishStmtBaseline === 1,
      `exactly one statement row created (delta=${publishStmtAfter - publishStmtBaseline})`,
    );
    assert(
      publishAuditAfter - publishAuditBaseline === 1,
      `exactly one INVESTOR_STATEMENT_PUBLISH audit row added (delta=${publishAuditAfter - publishAuditBaseline})`,
    );

    // ── 2. Successful status change (CORRECT) → 200, row mutated, one event +
    //       one INVESTOR_STATEMENT_STATUS_CORRECT audit row ──────────────────
    // eslint-disable-next-line no-console
    console.log("\n2. Successful status change writes one event + one INVESTOR_STATEMENT_STATUS_CORRECT audit row");
    const stmtStatus = await seedStatement(investorA.id, admin.id, "status");
    const statusAuditBaseline = await auditCount(investorA.id, "INVESTOR_STATEMENT_STATUS_CORRECT");
    const statusEventBaseline = await eventCount(stmtStatus);
    const statusRes = await req(admin.cookie, "POST", statusUrl(investorA.id, stmtStatus), {
      action: "CORRECT",
      reason: "Corrected a typo in the period label.",
    });
    const statusRow = await getStatement(stmtStatus);
    const statusAuditAfter = await auditCount(investorA.id, "INVESTOR_STATEMENT_STATUS_CORRECT");
    const statusEventAfter = await eventCount(stmtStatus);
    assert(statusRes.status === 200, `status change HTTP 200 (got ${statusRes.status})`);
    assert(statusRow?.status === "CORRECTED", `statement status is CORRECTED (got ${statusRow?.status})`);
    assert(
      statusEventAfter - statusEventBaseline === 1,
      `exactly one investor_statement_events row appended (delta=${statusEventAfter - statusEventBaseline})`,
    );
    assert(
      statusAuditAfter - statusAuditBaseline === 1,
      `exactly one INVESTOR_STATEMENT_STATUS_CORRECT audit row added (delta=${statusAuditAfter - statusAuditBaseline})`,
    );

    // ── 3. Wrong investor id → 404, row untouched, no event, no audit ────────
    // stmtCross belongs to A; we address it through B's id.
    // eslint-disable-next-line no-console
    console.log("\n3. Status change through the WRONG investor id returns 404 and does not mutate");
    const stmtCross = await seedStatement(investorA.id, admin.id, "cross");
    const crossAuditB = await auditCount(investorB.id, "INVESTOR_STATEMENT_STATUS_CORRECT");
    const crossEventBaseline = await eventCount(stmtCross);
    const crossRes = await req(admin.cookie, "POST", statusUrl(investorB.id, stmtCross), {
      action: "CORRECT",
      reason: "Cross-investor status change attempt.",
    });
    const afterCross = await getStatement(stmtCross);
    assert(crossRes.status === 404, `cross-investor status change → 404 (got ${crossRes.status})`);
    assert(afterCross?.status === "ACTIVE", `target statement untouched (status="${afterCross?.status}")`);
    assert(
      (await eventCount(stmtCross)) - crossEventBaseline === 0,
      `no investor_statement_events row written for the cross attempt`,
    );
    assert(
      (await auditCount(investorB.id, "INVESTOR_STATEMENT_STATUS_CORRECT")) - crossAuditB === 0,
      `no audit row written against the wrong investor id`,
    );

    // ── 4. Non-admin callers rejected on both paths ──────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n4. Non-admin callers are rejected (INVESTOR/USER → 403, anonymous → 401)");
    const stmtNonAdmin = await seedStatement(investorA.id, admin.id, "nonadmin");
    const pubBody = { title: `${TAG}_nope`, reason: "should be rejected" };
    const statBody = { action: "CORRECT" as const, reason: "should be rejected" };
    const investorPub = await req(investorA.cookie, "POST", publishUrl(investorA.id), pubBody);
    const traderPub = await req(trader.cookie, "POST", publishUrl(investorA.id), pubBody);
    const anonPub = await req(null, "POST", publishUrl(investorA.id), pubBody);
    const investorStat = await req(investorA.cookie, "POST", statusUrl(investorA.id, stmtNonAdmin), statBody);
    const traderStat = await req(trader.cookie, "POST", statusUrl(investorA.id, stmtNonAdmin), statBody);
    const anonStat = await req(null, "POST", statusUrl(investorA.id, stmtNonAdmin), statBody);
    assert(
      investorPub.status === 403 && traderPub.status === 403 && anonPub.status === 401,
      `publish: investor=${investorPub.status} trader=${traderPub.status} anon=${anonPub.status} (expected 403/403/401)`,
    );
    assert(
      investorStat.status === 403 && traderStat.status === 403 && anonStat.status === 401,
      `status: investor=${investorStat.status} trader=${traderStat.status} anon=${anonStat.status} (expected 403/403/401)`,
    );
    // The rejected publish/status must not have mutated anything.
    const rejectedStmt = await getStatement(stmtNonAdmin);
    assert(
      rejectedStmt?.status === "ACTIVE" && (await statementCountByTitle(investorA.id, `${TAG}_nope`)) === 0,
      `no row published / mutated by the rejected non-admin calls`,
    );

    // ── 5. Fail-closed — an audit-insert failure rolls the mutation back ──────
    // eslint-disable-next-line no-console
    console.log("\n5. A forced audit-insert failure rolls the whole mutation back (fail-closed)");
    const stmtFailStatus = await seedStatement(investorA.id, admin.id, "failstatus");
    await installFailAuditTrigger();
    try {
      // 5a. Publish fail-closed: no statement row created, no audit row.
      const failPublishTitle = `${TAG}_publish_rollback`;
      const failPubRes = await req(admin.cookie, "POST", publishUrl(investorA.id), {
        title: failPublishTitle,
        summary: `${TAG}_rollback_summary`,
        reason: FAIL_AUDIT_SENTINEL,
      });
      assert(failPubRes.status === 500, `publish with failing audit → 500 (got ${failPubRes.status})`);
      assert(
        (await statementCountByTitle(investorA.id, failPublishTitle)) === 0,
        `no statement row persisted for the rolled-back publish`,
      );

      // 5b. Status fail-closed: status stays ACTIVE, no event row persisted.
      const beforeFailStatus = await getStatement(stmtFailStatus);
      const failStatBaselineEvents = await eventCount(stmtFailStatus);
      const failStatRes = await req(admin.cookie, "POST", statusUrl(investorA.id, stmtFailStatus), {
        action: "CORRECT",
        reason: FAIL_AUDIT_SENTINEL,
      });
      const afterFailStatus = await getStatement(stmtFailStatus);
      assert(failStatRes.status === 500, `status change with failing audit → 500 (got ${failStatRes.status})`);
      assert(
        afterFailStatus?.status === "ACTIVE" && beforeFailStatus?.status === "ACTIVE",
        `statement status rolled back / stayed ACTIVE (got ${afterFailStatus?.status})`,
      );
      assert(
        (await eventCount(stmtFailStatus)) - failStatBaselineEvents === 0,
        `no investor_statement_events row persisted for the rolled-back status change`,
      );

      assert(
        (await auditCountByReason(FAIL_AUDIT_SENTINEL)) === 0,
        `no audit row persisted for the rolled-back mutations`,
      );
    } finally {
      await dropFailAuditTrigger();
    }
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    await dropFailAuditTrigger();
    const ids = [investorA?.id, investorB?.id, admin?.id, trader?.id].filter(
      (x): x is number => typeof x === "number",
    );
    try {
      if (ids.length > 0) {
        await db.delete(investorStatementEventsTable).where(inArray(investorStatementEventsTable.userId, ids));
        await db.delete(investorAllocationPreferencesTable).where(inArray(investorAllocationPreferencesTable.userId, ids));
        await db.delete(investorLedgerEntriesTable).where(inArray(investorLedgerEntriesTable.userId, ids));
        await db.delete(investorStatementsTable).where(inArray(investorStatementsTable.userId, ids));
        await db.delete(investorProfilesTable).where(inArray(investorProfilesTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.targetUserId, ids));
        await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
        await db.delete(usersTable).where(inArray(usersTable.id, ids));
      }
    } catch (e) {
      assert(false, `cleanup failed: ${(e as Error).message}`);
    }
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }

  const endLive = await liveCommandsCount();
  assert(endLive === startLive, `no live command created (start=${startLive} end=${endLive})`);

  // eslint-disable-next-line no-console
  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  await dropFailAuditTrigger().catch(() => {});
  // eslint-disable-next-line no-console
  console.error("[investorStatementPublishStatusGuardTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
