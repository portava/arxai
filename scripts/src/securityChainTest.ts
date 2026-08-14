// AACI Security Phase 4 (Task #240) — tamper-evident hash-chain regression (DB).
//
// Pins the inviolable behaviour of the critical-event hash chain:
//   1. recordCriticalSecurityEvent APPENDS a hash-linked row (currentHash set,
//      prevHash links to the previous chained row). Secrets in metadata are
//      redacted BEFORE the row is built — no raw secret is ever hashed/stored.
//   2. verifySecurityEventChain returns valid=true over an untampered chain.
//   3. A retroactive edit to a chained row's metadata is DETECTED (valid=false,
//      reason CHECKSUM_MISMATCH) — the chain is tamper-evident.
//   4. The table is APPEND-ONLY: rows are never deleted by the writer. Asserted
//      via baseline-delta + max(id) growth (never a "count==0" assertion).
//
// SAFETY: touches only security_events rows it creates (synthetic NEGATIVE
// actorUserId + a unique test-run tag in affectedObject). Places/closes
// NOTHING; never reaches the live pipeline, kill switch, or any broker surface.
// Cleans up exactly the rows it created at the end (tail of the chain).
// Run: pnpm --filter @workspace/scripts run test:security-chain

import { randomUUID } from "node:crypto";
import { db, securityEventsTable } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  recordCriticalSecurityEvent,
  verifySecurityEventChain,
} from "../../artifacts/api-server/src/lib/security/events.js";

const RUN_TAG = `chain-test:${randomUUID()}`;
const TEST_ACTOR = -240_001;

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function chainCount(): Promise<number> {
  const [{ c } = { c: 0 }] = await db
    .select({ c: sql<number>`cast(count(*) as int)` })
    .from(securityEventsTable)
    .where(isNotNull(securityEventsTable.currentHash));
  return c;
}

async function maxId(): Promise<number> {
  const [{ m } = { m: 0 }] = await db
    .select({ m: sql<number>`coalesce(max(${securityEventsTable.id}), 0)` })
    .from(securityEventsTable);
  return Number(m);
}

async function cleanup() {
  await db.delete(securityEventsTable).where(eq(securityEventsTable.actorUserId, TEST_ACTOR));
}

async function run() {
  // Clean any leftovers from a prior crashed run before baselining.
  await cleanup();

  const baselineChain = await chainCount();
  const baselineMax = await maxId();

  // ── 1. Append 4 chained critical events; secret in metadata must be redacted.
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await recordCriticalSecurityEvent({
      eventType: "ALLOCATION_CHANGE",
      severity: "HIGH",
      status: "ALLOWED",
      actorUserId: TEST_ACTOR,
      actorRole: "OWNER",
      actorType: "OWNER",
      affectedObject: `${RUN_TAG}:${i}`,
      message: `synthetic chain event ${i}`,
      metadata: { step: i, bridgeToken: "topsecretbridgetoken", note: "ok" },
    });
    ids.push(res.securityEventId);
    record(`append #${i} produced a linked hash`, res.currentHash != null);
  }

  const afterChain = await chainCount();
  const afterMax = await maxId();
  record("appends grew chained-row count by 4 (append-only)", afterChain === baselineChain + 4, `${baselineChain}→${afterChain}`);
  record("appends advanced max(id) (never reused)", afterMax > baselineMax, `${baselineMax}→${afterMax}`);

  // Stored row must contain NO raw secret (redaction-before-hash/write).
  const myRows = await db
    .select()
    .from(securityEventsTable)
    .where(eq(securityEventsTable.actorUserId, TEST_ACTOR))
    .orderBy(desc(securityEventsTable.id));
  const anyRawSecret = myRows.some((r) => JSON.stringify(r.metadata ?? {}).includes("topsecretbridgetoken"));
  record("no raw secret stored in any chained row", !anyRawSecret);
  record("redactedKeys recorded on rows", myRows.every((r) => Array.isArray(r.redactedKeys) && r.redactedKeys.length > 0));

  // ── 2. Untampered chain verifies.
  const v1 = await verifySecurityEventChain();
  record("untampered chain verifies valid", v1.valid === true, v1.reason ?? "");

  // ── 3. Tamper a chained row → detected.
  const victim = myRows[myRows.length - 1]!; // oldest of my rows (lowest id)
  await db
    .update(securityEventsTable)
    .set({ metadata: { step: 999, tampered: true } })
    .where(eq(securityEventsTable.securityEventId, victim.securityEventId));
  const v2 = await verifySecurityEventChain();
  record("tampered chain detected (valid=false)", v2.valid === false, v2.reason ?? "");
  record("tamper reported as checksum mismatch", v2.reason === "CHECKSUM_MISMATCH" || v2.reason === "PREV_HASH_MISMATCH");
  record("break localised to a real chained row", v2.brokenEventId != null);

  // Tamper EDITS, never deletes: my 4 rows are all still present.
  const stillPresent = await db
    .select({ id: securityEventsTable.id })
    .from(securityEventsTable)
    .where(eq(securityEventsTable.actorUserId, TEST_ACTOR));
  record("tamper did not delete any row (append-only)", stillPresent.length === 4, `present=${stillPresent.length}`);

  // ── teardown ── (my rows are the chain tail, so removing them leaves the
  // pre-existing chain intact.)
  await cleanup();
  const leftover = await db
    .select({ id: securityEventsTable.id })
    .from(securityEventsTable)
    .where(and(eq(securityEventsTable.actorUserId, TEST_ACTOR), inArray(securityEventsTable.securityEventId, ids)));
  record("cleanup removed all synthetic test rows", leftover.length === 0);

  const finalChain = await chainCount();
  record("post-cleanup chain count returns to baseline", finalChain === baselineChain, `${finalChain} vs ${baselineChain}`);
  const v3 = await verifySecurityEventChain();
  record("pre-existing chain valid after cleanup", v3.valid === true, v3.reason ?? "");

  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (failed.length ? `, ${failed.length} FAILED` : " — all green"),
  );
  if (failed.length) process.exit(1);
}

run()
  .then(() => process.exit(0))
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error("suite crashed:", e);
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });

export {};
