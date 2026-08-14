// QA — Expired registration-key sweep (Task #724).
//
// Proves sweepExpiredPendingKeys() against the real DB:
//   • Honest scope  — only status='PENDING' AND expiresAt < now transition;
//                     future-expiry, NULL-expiry, ACCEPTED, REVOKED rows untouched.
//   • Transition    — matched rows move PENDING → EXPIRED (terminal).
//   • Idempotent    — a second run with the same clock changes nothing (marked=0).
//   • Audited       — exactly ONE audit row per run that marks ≥1 key; NO audit
//                     row written for a no-op run.
//
// DB-backed, fully self-cleaning (scoped to TEST_SWEEP_724 cohort), no HTTP, no
// live trade. Manual-only test:* (not wired into ci / ci:integration).

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { betaInvitesRepo } from "@workspace/db";
const { sweepExpiredPendingKeys, EXPIRED_KEY_SWEEP_BATCH_SIZE } = betaInvitesRepo;

const COHORT = "TEST_SWEEP_724";
const results: Array<{ id: string; ok: boolean; detail: string }> = [];
function pass(id: string, d: string): void { results.push({ id, ok: true, detail: d }); }
function fail(id: string, d: string): void { results.push({ id, ok: false, detail: d }); }

type Row = { id: number; status: string };
function rowsOf<T>(r: unknown): T[] {
  return ((r as { rows?: T[] }).rows ?? (r as T[])) as T[];
}

async function statusById(id: number): Promise<string | null> {
  const r = await db.execute(sql`SELECT status FROM beta_invites WHERE id = ${id}`);
  return rowsOf<{ status: string }>(r)[0]?.status ?? null;
}

// Captured audit invocations — we inject our own auditFn so the audit assertion
// is hermetic and pollution-proof (no dependence on the shared audit_events
// table, and unaffected by the hourly worker running concurrently).
type AuditCall = { eventType: string; payload: Record<string, unknown> };

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM beta_invites WHERE cohort = ${COHORT}`);
}

async function seed(
  label: string, status: string, expiresSql: ReturnType<typeof sql>,
): Promise<number> {
  // keyPrefix carries the cohort so audit/cleanup can scope to this run.
  const prefix = `ARX-${COHORT}-${label}`;
  const r = await db.execute(sql`
    INSERT INTO beta_invites (cohort, email, invite_code_hash, key_prefix, status, expires_at)
    VALUES (${COHORT}, ${label.toLowerCase() + "@arx.test"}, ${"swh-" + label + "-" + Date.now()},
            ${prefix}, ${status}, ${expiresSql})
    RETURNING id
  `);
  return rowsOf<{ id: number }>(r)[0]!.id;
}

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("QA — Expired registration-key sweep (Task #724)");
  console.log("=".repeat(72));

  await cleanup();

  // Seeds.
  const past1 = await seed("PAST1", "PENDING", sql`NOW() - INTERVAL '2 days'`);
  const past2 = await seed("PAST2", "PENDING", sql`NOW() - INTERVAL '1 hour'`);
  const future = await seed("FUTURE", "PENDING", sql`NOW() + INTERVAL '7 days'`);
  const noexp = await seed("NOEXP", "PENDING", sql`NULL`);
  const accepted = await seed("ACCEPTED", "ACCEPTED", sql`NOW() - INTERVAL '3 days'`);
  const revoked = await seed("REVOKED", "REVOKED", sql`NOW() - INTERVAL '3 days'`);

  // ── Run 1 ──
  // Subset semantics: the shared dev DB may already hold other lapsed PENDING
  // keys (from prior seed runs) which this sweep also legitimately expires. We
  // assert OUR two rows are among those marked, marked===scanned (every scanned
  // candidate transitioned), and never that the global count equals exactly 2.
  const run1Calls: AuditCall[] = [];
  const captureRun1 = async (_tx: unknown, eventType: string, payload: Record<string, unknown>) => {
    run1Calls.push({ eventType, payload });
  };
  const run1 = await sweepExpiredPendingKeys(new Date(), captureRun1);
  const run1Set = new Set(run1.ids);

  if (run1.marked >= 2 && run1.marked === run1.scanned && run1Set.has(past1) && run1Set.has(past2)) {
    pass("T1", `run1 swept our 2 lapsed PENDING keys (marked=${run1.marked}, scanned=${run1.scanned}, ours=${past1},${past2})`);
  } else {
    fail("T1", `marked=${run1.marked} scanned=${run1.scanned} hasPast1=${run1Set.has(past1)} hasPast2=${run1Set.has(past2)}`);
  }

  // T2: lapsed rows now EXPIRED.
  const s1 = await statusById(past1), s2 = await statusById(past2);
  if (s1 === "EXPIRED" && s2 === "EXPIRED") pass("T2", "both lapsed keys are now EXPIRED");
  else fail("T2", `past1=${s1} past2=${s2}`);

  // T3: out-of-scope rows untouched.
  const sf = await statusById(future), sn = await statusById(noexp);
  const sa = await statusById(accepted), sr = await statusById(revoked);
  if (sf === "PENDING" && sn === "PENDING" && sa === "ACCEPTED" && sr === "REVOKED") {
    pass("T3", "future/null-expiry/accepted/revoked all untouched");
  } else {
    fail("T3", `future=${sf} noexp=${sn} accepted=${sa} revoked=${sr}`);
  }

  // T4: exactly ONE audit call for run 1, naming our swept ids.
  const auditIds = run1Calls[0]?.payload?.["ids"] as number[] | undefined;
  const auditMarked = run1Calls[0]?.payload?.["markedCount"] as number | undefined;
  if (
    run1Calls.length === 1 &&
    run1Calls[0]!.eventType === "registration_keys_expired_swept" &&
    Array.isArray(auditIds) && auditIds.includes(past1) && auditIds.includes(past2) &&
    auditMarked === run1.marked
  ) {
    pass("T4", `run1 wrote exactly 1 audit event naming swept ids (markedCount=${auditMarked})`);
  } else {
    fail("T4", `calls=${run1Calls.length} type=${run1Calls[0]?.eventType} ids=${JSON.stringify(auditIds)} markedCount=${auditMarked}`);
  }

  // ── Run 2 (idempotent) ──
  const run2Calls: AuditCall[] = [];
  const captureRun2 = async (_tx: unknown, eventType: string, payload: Record<string, unknown>) => {
    run2Calls.push({ eventType, payload });
  };
  const run2 = await sweepExpiredPendingKeys(new Date(), captureRun2);
  if (run2.marked === 0 && run2.scanned === 0 && run2.ids.length === 0) {
    pass("T5", "run2 is a no-op (marked=0, scanned=0) — idempotent");
  } else {
    fail("T5", `marked=${run2.marked} scanned=${run2.scanned} ids=${run2.ids.join(",")}`);
  }

  // T6: the no-op run writes NO audit event at all.
  if (run2Calls.length === 0) pass("T6", "no-op run wrote NO audit event");
  else fail("T6", `no-op run wrote ${run2Calls.length} audit event(s): ${JSON.stringify(run2Calls.map((c) => c.eventType))}`);

  // T7: final state — exactly the 2 lapsed keys EXPIRED in this cohort.
  const finalRows = rowsOf<Row>(await db.execute(
    sql`SELECT id, status FROM beta_invites WHERE cohort = ${COHORT} AND status = 'EXPIRED'`,
  ));
  if (finalRows.length === 2) pass("T7", `exactly 2 EXPIRED rows in cohort (no over-sweep)`);
  else fail("T7", `EXPIRED rows = ${finalRows.length}`);

  // ── T8/T9: multi-batch strict idempotency ──
  // Bulk-seed MORE than one batch of lapsed PENDING keys, then prove a SINGLE
  // invocation drains the entire backlog (so an immediate rerun is a true
  // no-op). With a single-batch cap this run would have left a remainder.
  const BATCH_N = EXPIRED_KEY_SWEEP_BATCH_SIZE + 1; // forces ≥2 batches
  const batchPrefix = `ARX-${COHORT}-BATCH`;
  const stamp = Date.now();
  await db.execute(sql`
    INSERT INTO beta_invites (cohort, email, invite_code_hash, key_prefix, status, expires_at)
    SELECT ${COHORT}, 'batch' || g || '@arx.test', ${"swh-batch-" + stamp + "-"} || g,
           ${batchPrefix} || g, 'PENDING', NOW() - INTERVAL '2 days'
    FROM generate_series(1, ${BATCH_N}) AS g
  `);

  const run3 = await sweepExpiredPendingKeys(new Date());
  // The whole backlog (≥ BATCH_N) drained in one call ⇒ scanned exceeded a
  // single batch, proving the loop ran ≥2 batches.
  const batchExpired = rowsOf<Row>(await db.execute(
    sql`SELECT id FROM beta_invites WHERE cohort = ${COHORT} AND key_prefix LIKE ${batchPrefix + "%"} AND status = 'EXPIRED'`,
  )).length;
  if (run3.scanned > EXPIRED_KEY_SWEEP_BATCH_SIZE && batchExpired === BATCH_N) {
    pass("T8", `single invocation drained ${BATCH_N} keys across ≥2 batches (scanned=${run3.scanned})`);
  } else {
    fail("T8", `scanned=${run3.scanned} batchExpired=${batchExpired} expected=${BATCH_N} (batchSize=${EXPIRED_KEY_SWEEP_BATCH_SIZE})`);
  }

  const run4 = await sweepExpiredPendingKeys(new Date());
  if (run4.marked === 0 && run4.scanned === 0) {
    pass("T9", "rerun after full drain is a true no-op (marked=0, scanned=0)");
  } else {
    fail("T9", `marked=${run4.marked} scanned=${run4.scanned}`);
  }

  await cleanup();

  console.log("");
  for (const r of results) console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.id.padEnd(4)} ${r.detail}`);
  const failCount = results.filter((r) => !r.ok).length;
  console.log("");
  console.log("=".repeat(72));
  console.log(`OVERALL: ${failCount === 0 ? "PASS" : "FAIL"}  ${results.length - failCount}/${results.length}`);
  console.log("=".repeat(72));

  await pool.end();
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(async (e: unknown) => {
  console.error("registrationKeyExpirySweepTest crashed:", e instanceof Error ? e.message : e);
  try { await cleanup(); } catch { /* noop */ }
  try { await pool.end(); } catch { /* noop */ }
  process.exit(2);
});
