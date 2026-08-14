// investorStatementAdminMutationGuardTest.ts — Automated proof (Task #102) that
// the admin edit / remove endpoints for investor statements are safe:
//   PATCH  /api/admin/investors/:id/statements/:statementId  (edit)
//   DELETE /api/admin/investors/:id/statements/:statementId  (soft remove)
//
// These mutate a financial record, so each must:
//   • write exactly ONE fail-closed admin_action_audit_log row in the SAME
//     transaction as the mutation (audit can never be skipped),
//   • be scoped per investor — a statement from investor A can never be edited
//     or deleted through investor B's id (returns 404, row untouched),
//   • reject non-admin callers (INVESTOR/USER → 403, anonymous → 401),
//   • roll the mutation back entirely if the audit insert fails (fail-closed).
//
// IT PROVES (all against the REAL Express app in-process):
//   1. A successful edit returns 200, mutates the row, and creates exactly one
//      INVESTOR_STATEMENT_EDIT audit row (baseline-delta, not count==0).
//   2. A successful remove returns 200, soft-removes the row (status=REMOVED,
//      still present), and creates exactly one INVESTOR_STATEMENT_STATUS_REMOVE
//      audit row (the lifecycle action the DELETE path emits).
//   3. Editing / deleting a statement through the WRONG investor id returns 404
//      and does NOT mutate the row or write an audit row for the wrong investor.
//   4. A non-admin session is rejected: INVESTOR → 403, plain USER → 403,
//      anonymous → 401 — for BOTH the edit and the remove path.
//   5. When the audit insert fails (forced via a temporary BEFORE INSERT trigger
//      on admin_action_audit_log), the whole transaction rolls back: the route
//      returns 500, the statement row is UNCHANGED, and no audit row is written.
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
// Run: pnpm --filter @workspace/scripts run test:investor-statement-admin-mutations

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
const TAG = `qaStmtMut_${Date.now()}_${randomBytes(3).toString("hex")}`;
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
    method: "PATCH" | "DELETE",
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
  console.log("investorStatementAdminMutationGuardTest");
  // eslint-disable-next-line no-console
  console.log("=======================================\n");

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

    const stmtEdit = await seedStatement(investorA.id, admin.id, "edit");
    const stmtRemove = await seedStatement(investorA.id, admin.id, "remove");
    const stmtCross = await seedStatement(investorA.id, admin.id, "cross");
    const stmtFailEdit = await seedStatement(investorA.id, admin.id, "failedit");
    const stmtFailDelete = await seedStatement(investorA.id, admin.id, "faildelete");

    const editUrl = (uid: number, sid: number) =>
      `/api/admin/investors/${uid}/statements/${sid}`;

    // ── 1. Successful edit → 200, row mutated, exactly one EDIT audit row ─────
    // eslint-disable-next-line no-console
    console.log("1. Successful edit writes exactly one INVESTOR_STATEMENT_EDIT audit row");
    const editBaseline = await auditCount(investorA.id, "INVESTOR_STATEMENT_EDIT");
    const newTitle = `${TAG}_edited_title`;
    const editRes = await req(admin.cookie, "PATCH", editUrl(investorA.id, stmtEdit), {
      title: newTitle,
      summary: `${TAG}_edited_summary`,
      reason: "Corrected the closing-balance figure.",
    });
    const editedRow = await getStatement(stmtEdit);
    const editAfter = await auditCount(investorA.id, "INVESTOR_STATEMENT_EDIT");
    assert(editRes.status === 200, `edit HTTP 200 (got ${editRes.status})`);
    assert(editedRow?.title === newTitle, `statement title was updated to the new value`);
    assert(
      editAfter - editBaseline === 1,
      `exactly one INVESTOR_STATEMENT_EDIT audit row added (delta=${editAfter - editBaseline})`,
    );

    // ── 2. Successful remove → 200, soft-removed, exactly one remove audit row ─
    // The DELETE path funnels through the lifecycle helper, which emits the
    // INVESTOR_STATEMENT_STATUS_REMOVE audit action (the remove audit row).
    // eslint-disable-next-line no-console
    console.log("\n2. Successful remove writes exactly one INVESTOR_STATEMENT_STATUS_REMOVE audit row");
    const removeBaseline = await auditCount(investorA.id, "INVESTOR_STATEMENT_STATUS_REMOVE");
    const removeRes = await req(
      admin.cookie,
      "DELETE",
      `${editUrl(investorA.id, stmtRemove)}?reason=${encodeURIComponent("Removed pending re-issue.")}`,
    );
    const removedRow = await getStatement(stmtRemove);
    const removeAfter = await auditCount(investorA.id, "INVESTOR_STATEMENT_STATUS_REMOVE");
    assert(removeRes.status === 200, `remove HTTP 200 (got ${removeRes.status})`);
    assert(removedRow != null, `statement row still present after remove (soft-delete, never hard-deleted)`);
    assert(removedRow?.status === "REMOVED", `statement status is REMOVED (got ${removedRow?.status})`);
    assert(
      removeAfter - removeBaseline === 1,
      `exactly one INVESTOR_STATEMENT_STATUS_REMOVE audit row added (delta=${removeAfter - removeBaseline})`,
    );

    // ── 3. Wrong investor id → 404, row untouched, no audit for wrong investor ─
    // stmtCross belongs to A; we address it through B's id.
    // eslint-disable-next-line no-console
    console.log("\n3. Editing/deleting through the WRONG investor id returns 404 and does not mutate");
    const crossEditAuditB = await auditCount(investorB.id, "INVESTOR_STATEMENT_EDIT");
    const crossEdit = await req(admin.cookie, "PATCH", editUrl(investorB.id, stmtCross), {
      title: `${TAG}_should_not_apply`,
      reason: "Cross-investor edit attempt.",
    });
    const afterCrossEdit = await getStatement(stmtCross);
    const crossDelAuditB = await auditCount(investorB.id, "INVESTOR_STATEMENT_STATUS_REMOVE");
    const crossDel = await req(
      admin.cookie,
      "DELETE",
      `${editUrl(investorB.id, stmtCross)}?reason=${encodeURIComponent("Cross-investor delete attempt.")}`,
    );
    const afterCrossDel = await getStatement(stmtCross);
    assert(crossEdit.status === 404, `cross-investor edit → 404 (got ${crossEdit.status})`);
    assert(crossDel.status === 404, `cross-investor delete → 404 (got ${crossDel.status})`);
    assert(
      afterCrossEdit?.title === `${TAG}_cross` && afterCrossDel?.status === "ACTIVE",
      `target statement untouched (title="${afterCrossEdit?.title}" status="${afterCrossDel?.status}")`,
    );
    assert(
      (await auditCount(investorB.id, "INVESTOR_STATEMENT_EDIT")) - crossEditAuditB === 0 &&
        (await auditCount(investorB.id, "INVESTOR_STATEMENT_STATUS_REMOVE")) - crossDelAuditB === 0,
      `no audit row written against the wrong investor id`,
    );

    // ── 4. Non-admin callers rejected on both paths ──────────────────────────
    // eslint-disable-next-line no-console
    console.log("\n4. Non-admin callers are rejected (INVESTOR/USER → 403, anonymous → 401)");
    const editBody = { title: `${TAG}_nope`, reason: "should be rejected" };
    const delQs = `?reason=${encodeURIComponent("should be rejected")}`;
    const investorEdit = await req(investorA.cookie, "PATCH", editUrl(investorA.id, stmtEdit), editBody);
    const traderEdit = await req(trader.cookie, "PATCH", editUrl(investorA.id, stmtEdit), editBody);
    const anonEdit = await req(null, "PATCH", editUrl(investorA.id, stmtEdit), editBody);
    const investorDel = await req(investorA.cookie, "DELETE", `${editUrl(investorA.id, stmtFailEdit)}${delQs}`);
    const traderDel = await req(trader.cookie, "DELETE", `${editUrl(investorA.id, stmtFailEdit)}${delQs}`);
    const anonDel = await req(null, "DELETE", `${editUrl(investorA.id, stmtFailEdit)}${delQs}`);
    assert(
      investorEdit.status === 403 && traderEdit.status === 403 && anonEdit.status === 401,
      `edit: investor=${investorEdit.status} trader=${traderEdit.status} anon=${anonEdit.status} (expected 403/403/401)`,
    );
    assert(
      investorDel.status === 403 && traderDel.status === 403 && anonDel.status === 401,
      `delete: investor=${investorDel.status} trader=${traderDel.status} anon=${anonDel.status} (expected 403/403/401)`,
    );

    // ── 5. Fail-closed — an audit-insert failure rolls the mutation back ──────
    // eslint-disable-next-line no-console
    console.log("\n5. A forced audit-insert failure rolls the whole mutation back (fail-closed)");
    await installFailAuditTrigger();
    try {
      // 5a. Edit fail-closed: title must NOT change, no audit row written.
      const beforeFailEdit = await getStatement(stmtFailEdit);
      const failEdit = await req(admin.cookie, "PATCH", editUrl(investorA.id, stmtFailEdit), {
        title: `${TAG}_rolled_back_title`,
        reason: FAIL_AUDIT_SENTINEL,
      });
      const afterFailEdit = await getStatement(stmtFailEdit);
      assert(failEdit.status === 500, `edit with failing audit → 500 (got ${failEdit.status})`);
      assert(
        afterFailEdit?.title === beforeFailEdit?.title && afterFailEdit?.title !== `${TAG}_rolled_back_title`,
        `statement title rolled back to "${beforeFailEdit?.title}" (mutation reverted)`,
      );

      // 5b. Delete fail-closed: status must stay ACTIVE, no audit/event written.
      const beforeFailDel = await getStatement(stmtFailDelete);
      const failDel = await req(
        admin.cookie,
        "DELETE",
        `${editUrl(investorA.id, stmtFailDelete)}?reason=${encodeURIComponent(FAIL_AUDIT_SENTINEL)}`,
      );
      const afterFailDel = await getStatement(stmtFailDelete);
      assert(failDel.status === 500, `delete with failing audit → 500 (got ${failDel.status})`);
      assert(
        afterFailDel?.status === "ACTIVE" && beforeFailDel?.status === "ACTIVE",
        `statement status rolled back / stayed ACTIVE (got ${afterFailDel?.status})`,
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
  console.error("[investorStatementAdminMutationGuardTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
