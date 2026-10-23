// bulkPerformancePostingGuardTest.ts — Automated proof (Task #108) that the bulk
// investor-performance posting flow (Task #86) stays HONEST and INDIVIDUALLY
// audited:
//   POST /api/admin/investors/bulk-performance
//
// The bulk post writes ONE INVESTOR_LEDGER_PERFORMANCE row per investor, each in
// its OWN fail-closed transaction (ledger insert + admin_action_audit_log row
// succeed together or that investor rolls back). It must never:
//   • roll several investors into one audit row (one audit row PER posted
//     investor),
//   • fabricate a figure — a PRO_RATA post on a zero/negative base is reported
//     SKIPPED_ZERO and writes NO ledger row and NO audit row,
//   • let one investor's failure roll back the others (partial success),
//   • drop the period-label attribution (every posted row carries it, in both
//     the ledger `reason` and the audit `afterState.periodLabel`).
//
// IT PROVES (all against the REAL Express app in-process):
//   1. A PRO_RATA bulk post across investors with VARIED balances posts exactly
//      ONE INVESTOR_LEDGER_PERFORMANCE ledger row + exactly ONE
//      INVESTOR_LEDGER_PERFORMANCE admin_action_audit_log row per POSTED
//      investor, with the correct pro-rata figure and the period label attached
//      to both.
//   2. A PRO_RATA post on a ZERO base and on a NEGATIVE base is reported
//      SKIPPED_ZERO and writes NO ledger row and NO audit row (nothing invented).
//   3. One investor's transaction failing (forced via a temporary BEFORE INSERT
//      trigger on admin_action_audit_log scoped to that investor) does NOT roll
//      back the others — the other investors stay POSTED (partial success) while
//      the failed one writes NO ledger row and NO audit row (fail-closed).
//   4. The period label is attached to EVERY posted row.
//
// SAFETY / ISOLATION:
//   - Seeds isolated system users (fixed TAG, isSystemUser=true) and operates
//     ONLY on their rows.
//   - Idempotent cleanup of every seeded row at the end, even on failure.
//   - Never places a trade / touches any execution / live / bridge surface; the
//     starting arx_live_commands count is asserted unchanged at the end.
//   - CI-safe: spins up the REAL Express app in-process on an ephemeral port (no
//     externally-running server required). Set ARX_QA_BASE_URL to probe an
//     already-running server instead. Only DATABASE_URL is required.
//
// Run: pnpm --filter @workspace/scripts run test:bulk-performance-posting

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
  investorPerformanceBatchesTable,
  adminActionAuditLogTable,
} from "@workspace/db/schema";
import { bulkPerformanceReason } from "../../artifacts/api-server/src/lib/investor/investorService.js";

const EXTERNAL_BASE = process.env["ARX_QA_BASE_URL"];
const TAG = `qaBulkPerf_${Date.now()}_${randomBytes(3).toString("hex")}`;
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 60 * 60 * 1000;
const TRIGGER_NAME = `arx_qa_bulkperf_fail_${randomBytes(4).toString("hex")}`;
const TRIGGER_FN = `arx_qa_bulkperf_fail_fn_${randomBytes(4).toString("hex")}`;

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

async function createActor(label: string, role: "INVESTOR" | "ADMIN"): Promise<Actor> {
  const email = `${TAG}_${label}@arx.test`;
  const [u] = await db
    .insert(usersTable)
    .values({ email, name: `${TAG} ${label}`, role, isSystemUser: true })
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

async function seedInvestor(label: string, adminId: number): Promise<Actor> {
  const actor = await createActor(label, "INVESTOR");
  await db.insert(investorProfilesTable).values({
    userId: actor.id,
    displayName: `${TAG}_${label}`,
    baseCurrency: "USD",
    status: "active",
  });
  void adminId;
  return actor;
}

// Seed ledger contributions so an investor has a known currentValue (sum of
// signed amounts). Used to give PRO_RATA a varied real base.
async function seedLedger(
  userId: number,
  adminId: number,
  entries: Array<{ entryType: string; signedAmount: number }>,
): Promise<void> {
  if (entries.length === 0) return;
  await db.insert(investorLedgerEntriesTable).values(
    entries.map((e) => ({
      userId,
      entryType: e.entryType,
      signedAmount: e.signedAmount,
      currency: "USD",
      reason: `${TAG} seed`,
      createdByAdminId: adminId,
    })),
  );
}

// PERFORMANCE ledger rows tagged with this batch for one investor.
async function perfLedgerRows(
  userId: number,
  batchId: string,
): Promise<Array<{ signed_amount: number; reason: string; entry_type: string }>> {
  const r = await pool.query(
    `SELECT signed_amount, reason, entry_type
       FROM investor_ledger_entries
      WHERE user_id = $1 AND batch_id = $2 AND entry_type = 'PERFORMANCE'`,
    [userId, batchId],
  );
  return r.rows as Array<{ signed_amount: number; reason: string; entry_type: string }>;
}

// INVESTOR_LEDGER_PERFORMANCE audit rows for one investor in this batch.
async function perfAuditRows(
  userId: number,
  batchId: string,
): Promise<Array<{ after_state: Record<string, unknown> }>> {
  const r = await pool.query(
    `SELECT after_state
       FROM admin_action_audit_log
      WHERE target_user_id = $1
        AND action = 'INVESTOR_LEDGER_PERFORMANCE'
        AND after_state->>'batchId' = $2`,
    [userId, batchId],
  );
  return r.rows as Array<{ after_state: Record<string, unknown> }>;
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

async function installFailAuditTrigger(failUserId: number): Promise<void> {
  await pool.query(
    `CREATE FUNCTION ${TRIGGER_FN}() RETURNS trigger AS $$
     BEGIN
       IF NEW.target_user_id = ${failUserId} THEN
         RAISE EXCEPTION 'arx qa forced bulk-perf audit failure';
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

type BulkResult = {
  ok: boolean;
  batchId: string | null;
  periodLabel: string;
  mode: string;
  postedCount: number;
  skippedCount: number;
  failedCount: number;
  results: Array<{
    userId: number;
    amount: number;
    status: "POSTED" | "SKIPPED_ZERO" | "SKIPPED_NOT_FOUND" | "FAILED";
  }>;
};

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("bulkPerformancePostingGuardTest");
  // eslint-disable-next-line no-console
  console.log("===============================\n");

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

  async function postBulk(cookie: string, body: unknown): Promise<{ status: number; json: BulkResult }> {
    const r = await fetch(`${baseUrl}/api/admin/investors/bulk-performance`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as BulkResult };
  }

  let admin: Actor | null = null;
  const investors: Actor[] = [];
  const track = (a: Actor): Actor => {
    investors.push(a);
    return a;
  };

  try {
    admin = await createActor("ADM", "ADMIN");

    // ── 1. PRO_RATA across varied balances: per-posted-investor one row + one
    //       audit row, and SKIPPED_ZERO on a zero / negative base. ────────────
    // eslint-disable-next-line no-console
    console.log("1. PRO_RATA post: one ledger row + one audit row per POSTED investor; SKIPPED_ZERO writes nothing");
    const pPos = track(await seedInvestor("P_POS", admin.id)); // base 10000 → POSTED
    const pZero = track(await seedInvestor("P_ZERO", admin.id)); // base 0 → SKIPPED_ZERO
    const pNeg = track(await seedInvestor("P_NEG", admin.id)); // base -500 → SKIPPED_ZERO
    await seedLedger(pPos.id, admin.id, [{ entryType: "DEPOSIT", signedAmount: 10_000 }]);
    // pZero: no ledger → currentValue 0.
    await seedLedger(pNeg.id, admin.id, [
      { entryType: "DEPOSIT", signedAmount: 1_000 },
      { entryType: "WITHDRAWAL", signedAmount: -1_500 },
    ]);

    const periodA = "2026-05";
    const reasonA = "May fund performance posting.";
    const proRata = await postBulk(admin.cookie, {
      periodLabel: periodA,
      mode: "PRO_RATA",
      value: 2, // 2% of each investor's current value
      reason: reasonA,
      userIds: [pPos.id, pZero.id, pNeg.id],
    });
    assert(proRata.status === 200, `PRO_RATA post HTTP 200 (got ${proRata.status})`);
    assert(proRata.json.postedCount === 1, `postedCount=1 (got ${proRata.json.postedCount})`);
    assert(proRata.json.skippedCount === 2, `skippedCount=2 (got ${proRata.json.skippedCount})`);
    assert(proRata.json.failedCount === 0, `failedCount=0 (got ${proRata.json.failedCount})`);
    const batchA = proRata.json.batchId;
    assert(typeof batchA === "string" && batchA.length > 0, `batch id returned (got ${batchA})`);

    const resPos = proRata.json.results.find((r) => r.userId === pPos.id);
    const resZero = proRata.json.results.find((r) => r.userId === pZero.id);
    const resNeg = proRata.json.results.find((r) => r.userId === pNeg.id);
    assert(resPos?.status === "POSTED", `positive-base investor POSTED (got ${resPos?.status})`);
    assert(resZero?.status === "SKIPPED_ZERO", `zero-base investor SKIPPED_ZERO (got ${resZero?.status})`);
    assert(resNeg?.status === "SKIPPED_ZERO", `negative-base investor SKIPPED_ZERO (got ${resNeg?.status})`);

    // POSTED investor: exactly one PERFORMANCE ledger row, correct figure, period label folded in.
    const posLedger = await perfLedgerRows(pPos.id, batchA!);
    const posAudit = await perfAuditRows(pPos.id, batchA!);
    const expectedReasonA = bulkPerformanceReason(periodA, reasonA);
    assert(posLedger.length === 1, `POSTED investor has exactly ONE PERFORMANCE ledger row (got ${posLedger.length})`);
    assert(posAudit.length === 1, `POSTED investor has exactly ONE INVESTOR_LEDGER_PERFORMANCE audit row (got ${posAudit.length})`);
    assert(
      posLedger[0]?.signed_amount === 200,
      `pro-rata figure is 2% of 10000 = 200, not invented (got ${posLedger[0]?.signed_amount})`,
    );
    assert(
      posLedger[0]?.reason === expectedReasonA,
      `ledger reason carries the period label "${expectedReasonA}" (got "${posLedger[0]?.reason}")`,
    );
    assert(
      posAudit[0]?.after_state?.["periodLabel"] === periodA,
      `audit afterState.periodLabel = "${periodA}" (got "${String(posAudit[0]?.after_state?.["periodLabel"])}")`,
    );

    // SKIPPED investors: NO ledger row, NO audit row (nothing invented).
    const zeroLedger = await perfLedgerRows(pZero.id, batchA!);
    const zeroAudit = await perfAuditRows(pZero.id, batchA!);
    const negLedger = await perfLedgerRows(pNeg.id, batchA!);
    const negAudit = await perfAuditRows(pNeg.id, batchA!);
    assert(
      zeroLedger.length === 0 && zeroAudit.length === 0,
      `zero-base investor wrote NO ledger row and NO audit row (ledger=${zeroLedger.length} audit=${zeroAudit.length})`,
    );
    assert(
      negLedger.length === 0 && negAudit.length === 0,
      `negative-base investor wrote NO ledger row and NO audit row (ledger=${negLedger.length} audit=${negAudit.length})`,
    );

    // ── 2. Partial success + fail-closed: one investor's tx fails, others post ─
    // eslint-disable-next-line no-console
    console.log("\n2. One investor's failure does not roll back the others (partial success, fail-closed)");
    const f1 = track(await seedInvestor("F1", admin.id));
    const f2 = track(await seedInvestor("F2", admin.id));
    const fFail = track(await seedInvestor("F_FAIL", admin.id));

    // A trigger that fails the audit insert ONLY for fFail forces that
    // investor's whole transaction (ledger + audit) to roll back.
    await installFailAuditTrigger(fFail.id);
    const periodB = "2026-06";
    const reasonB = "June fund performance posting.";
    let fixed: { status: number; json: BulkResult };
    try {
      fixed = await postBulk(admin.cookie, {
        periodLabel: periodB,
        mode: "FIXED",
        value: 100, // flat +100 to every selected investor
        reason: reasonB,
        userIds: [f1.id, fFail.id, f2.id],
      });
    } finally {
      await dropFailAuditTrigger();
    }

    assert(fixed.status === 200, `FIXED post HTTP 200 despite one failure (got ${fixed.status})`);
    assert(fixed.json.postedCount === 2, `postedCount=2 — the two healthy investors stand (got ${fixed.json.postedCount})`);
    assert(fixed.json.failedCount === 1, `failedCount=1 — only the forced one failed (got ${fixed.json.failedCount})`);
    const batchB = fixed.json.batchId;
    assert(typeof batchB === "string" && batchB.length > 0, `batch id returned for partial-success post (got ${batchB})`);

    const resF1 = fixed.json.results.find((r) => r.userId === f1.id);
    const resF2 = fixed.json.results.find((r) => r.userId === f2.id);
    const resFail = fixed.json.results.find((r) => r.userId === fFail.id);
    assert(resF1?.status === "POSTED" && resF2?.status === "POSTED", `both healthy investors POSTED (f1=${resF1?.status} f2=${resF2?.status})`);
    assert(resFail?.status === "FAILED", `forced investor reported FAILED (got ${resFail?.status})`);

    // Healthy investors: exactly one ledger row + one audit row each, period label attached.
    const f1Ledger = await perfLedgerRows(f1.id, batchB!);
    const f1Audit = await perfAuditRows(f1.id, batchB!);
    const f2Ledger = await perfLedgerRows(f2.id, batchB!);
    const f2Audit = await perfAuditRows(f2.id, batchB!);
    const expectedReasonB = bulkPerformanceReason(periodB, reasonB);
    assert(
      f1Ledger.length === 1 && f1Audit.length === 1 && f2Ledger.length === 1 && f2Audit.length === 1,
      `each healthy investor has exactly one ledger row + one audit row (f1=${f1Ledger.length}/${f1Audit.length} f2=${f2Ledger.length}/${f2Audit.length})`,
    );
    assert(
      f1Ledger[0]?.signed_amount === 100 && f2Ledger[0]?.signed_amount === 100,
      `flat FIXED figure 100 applied to both healthy investors`,
    );
    assert(
      f1Ledger[0]?.reason === expectedReasonB && f2Ledger[0]?.reason === expectedReasonB,
      `period label attached to EVERY posted row in the partial-success batch`,
    );

    // Fail-closed: the forced investor wrote NO ledger row and NO audit row.
    const failLedger = await perfLedgerRows(fFail.id, batchB!);
    const failAudit = await perfAuditRows(fFail.id, batchB!);
    assert(
      failLedger.length === 0 && failAudit.length === 0,
      `forced investor's tx rolled back fully — NO ledger row, NO audit row (ledger=${failLedger.length} audit=${failAudit.length})`,
    );
  } catch (e) {
    assert(false, `unexpected error: ${(e as Error).message}`);
  } finally {
    await dropFailAuditTrigger().catch(() => {});
    const ids = [admin?.id, ...investors.map((a) => a.id)].filter(
      (x): x is number => typeof x === "number",
    );
    try {
      if (ids.length > 0) {
        await db.delete(investorPerformanceBatchesTable).where(inArray(investorPerformanceBatchesTable.createdByAdminId, ids));
        await db.delete(investorLedgerEntriesTable).where(inArray(investorLedgerEntriesTable.userId, ids));
        await db.delete(investorProfilesTable).where(inArray(investorProfilesTable.userId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.targetUserId, ids));
        await db.delete(adminActionAuditLogTable).where(inArray(adminActionAuditLogTable.adminId, ids));
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
  console.error("[bulkPerformancePostingGuardTest] FAILED:", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
