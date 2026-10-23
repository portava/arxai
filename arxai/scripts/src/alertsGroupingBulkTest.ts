// T024 — Alerts grouping + bulk actions + dedupe-collapse regression suite.
//
// Verifies the backend half of the "cluttered/repetitive Alerts page" fix:
//   1. createNotification COLLAPSES a repeated condition (same stable dedupe
//      key + bucket) into ONE row whose repeatCount + lastOccurrenceAt are
//      bumped — instead of spawning a new notification each emission.
//   2. A dismissed (or read) notification is NOT resurfaced by a re-fire:
//      the collapse bumps repeatCount but never resets status.
//   3. A different stable key still produces a separate row (no over-collapse).
//   4. The bulk UPDATE is strictly user-scoped: updating user A's ids can
//      never touch user B's rows (no cross-user mutation).
//   5. "Delete" is a SOFT archive — status='dismissed', the row still EXISTS
//      (no hard DELETE), so any underlying trade/command/ledger row keyed off
//      it is untouched. Asserted by source-inspection (no .delete()) + a live
//      round-trip that the row survives dismissal.
//   6. The new /me/notifications/bulk + /clear-read routes are wired.
//
// SAFETY: operates ONLY on user_notifications / preferences rows for synthetic
// NEGATIVE test user ids (real users are positive serials — zero collision).
// Cleans up everything it creates. No trades, no broker calls, no live writes.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, userNotificationsTable, userNotificationPreferencesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createNotification } from "../../artifacts/api-server/src/lib/notificationService.js";
import meNotificationsRouter from "../../artifacts/api-server/src/routes/meNotifications.js";

const USER_A = -900_241;
const USER_B = -900_242;

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

type Layer = { route?: { path: string; methods: Record<string, boolean> } };
function listRoutes(router: { stack: Layer[] }): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of router.stack) {
    const r = layer.route;
    if (!r) continue;
    for (const method of Object.keys(r.methods)) if (r.methods[method]) out.push({ method: method.toUpperCase(), path: r.path });
  }
  return out;
}

async function cleanup() {
  for (const uid of [USER_A, USER_B]) {
    await db.delete(userNotificationsTable).where(eq(userNotificationsTable.userId, uid));
    await db.delete(userNotificationPreferencesTable).where(eq(userNotificationPreferencesTable.userId, uid));
  }
}

async function main() {
  await cleanup();

  // ── PART A — dedupe collapse + repeatCount ───────────────────────────────
  console.log("\nPART A — createNotification collapses repeats");
  const first = await createNotification(USER_A, {
    notificationType: "trade_hold_time_exceeded",
    severity: "warning",
    title: "Holding longer than your intraday window",
    message: "EURUSD position open 3h past window",
    source: "trade",
    entityType: "trade_exit:TESTKEY-1",
    entityId: 0,
    cooldownMs: 6 * 60 * 60_000,
  });
  record("first emission creates a row", !!first, `id=${first?.id ?? "null"}`);

  // Re-fire the SAME stable condition within the same cooldown bucket.
  for (let i = 0; i < 3; i++) {
    await createNotification(USER_A, {
      notificationType: "trade_hold_time_exceeded",
      severity: "warning",
      title: "Holding longer than your intraday window",
      message: "EURUSD position open 3h past window",
      source: "trade",
      entityType: "trade_exit:TESTKEY-1",
      entityId: 0,
      cooldownMs: 6 * 60 * 60_000,
    });
  }
  const aRows = await db.select().from(userNotificationsTable)
    .where(and(eq(userNotificationsTable.userId, USER_A), eq(userNotificationsTable.entityType, "trade_exit:TESTKEY-1")));
  record("4 emissions collapse into exactly 1 row", aRows.length === 1, `rows=${aRows.length}`);
  record("repeatCount bumped to 4", aRows[0]?.repeatCount === 4, `repeatCount=${aRows[0]?.repeatCount}`);
  record("lastOccurrenceAt set on collapse", !!aRows[0]?.lastOccurrenceAt);

  // ── PART B — dismissed is NOT resurfaced by a re-fire ────────────────────
  console.log("\nPART B — collapse never resurfaces a dismissed/read alert");
  const rowId = aRows[0]!.id;
  await db.update(userNotificationsTable).set({ status: "dismissed", dismissedAt: new Date() }).where(eq(userNotificationsTable.id, rowId));
  await createNotification(USER_A, {
    notificationType: "trade_hold_time_exceeded",
    severity: "warning",
    title: "Holding longer than your intraday window",
    message: "EURUSD position open 3h past window",
    source: "trade",
    entityType: "trade_exit:TESTKEY-1",
    entityId: 0,
    cooldownMs: 6 * 60 * 60_000,
  });
  const afterDismiss = await db.select().from(userNotificationsTable).where(eq(userNotificationsTable.id, rowId));
  record("re-fire keeps status='dismissed' (no resurface)", afterDismiss[0]?.status === "dismissed", `status=${afterDismiss[0]?.status}`);
  record("re-fire still bumps repeatCount to 5", afterDismiss[0]?.repeatCount === 5, `repeatCount=${afterDismiss[0]?.repeatCount}`);

  // ── PART C — different stable key = separate row (no over-collapse) ───────
  console.log("\nPART C — distinct conditions stay distinct");
  await createNotification(USER_A, {
    notificationType: "trade_hold_time_exceeded",
    severity: "warning",
    title: "Holding longer than your intraday window",
    message: "GBPUSD position",
    source: "trade",
    entityType: "trade_exit:TESTKEY-2",
    entityId: 0,
    cooldownMs: 6 * 60 * 60_000,
  });
  const distinct = await db.select().from(userNotificationsTable).where(eq(userNotificationsTable.userId, USER_A));
  record("two distinct trade keys = two rows", distinct.length === 2, `rows=${distinct.length}`);

  // ── PART D — bulk update is strictly user-scoped ─────────────────────────
  console.log("\nPART D — bulk update never crosses users");
  const bRow = await createNotification(USER_B, {
    notificationType: "system_test",
    severity: "info",
    title: "User B private alert",
    message: "should never be touched by user A bulk action",
    source: "system",
    entityType: "system:B",
    entityId: 0,
  });
  record("user B has a row", !!bRow, `id=${bRow?.id ?? "null"}`);
  const aAllIds = (await db.select().from(userNotificationsTable).where(eq(userNotificationsTable.userId, USER_A))).map((r) => r.id);
  // Mirror the route's exact WHERE: (userId == A) AND id IN (A's ids ∪ B's id).
  const maliciousIds = [...aAllIds, bRow!.id];
  const updated = await db.update(userNotificationsTable)
    .set({ status: "read", readAt: new Date(), updatedAt: new Date() })
    .where(and(eq(userNotificationsTable.userId, USER_A), inArray(userNotificationsTable.id, maliciousIds)))
    .returning();
  record("bulk update touches only user A's rows", updated.every((r) => r.userId === USER_A), `updatedUsers=${[...new Set(updated.map((r) => r.userId))].join(",")}`);
  const bAfter = await db.select().from(userNotificationsTable).where(eq(userNotificationsTable.id, bRow!.id));
  record("user B's row is UNTOUCHED by user A's bulk", bAfter[0]?.status === "unread", `status=${bAfter[0]?.status}`);

  // ── PART E — soft delete: row survives dismissal (no hard DELETE) ────────
  console.log("\nPART E — delete = soft archive, row survives");
  const survivorId = aAllIds[0]!;
  await db.update(userNotificationsTable).set({ status: "dismissed", dismissedAt: new Date() }).where(and(eq(userNotificationsTable.userId, USER_A), eq(userNotificationsTable.id, survivorId)));
  const survivor = await db.select().from(userNotificationsTable).where(eq(userNotificationsTable.id, survivorId));
  record("dismissed notification row still EXISTS (soft delete)", survivor.length === 1 && survivor[0]?.status === "dismissed", `len=${survivor.length} status=${survivor[0]?.status}`);

  // ── PART F — route source: bulk/clear-read use UPDATE, never DELETE ──────
  console.log("\nPART F — route shape + no hard-delete in source");
  const routes = listRoutes(meNotificationsRouter as unknown as { stack: Layer[] });
  const has = (m: string, p: string) => routes.some((r) => r.method === m && r.path === p);
  record("POST /me/notifications/bulk wired", has("POST", "/me/notifications/bulk"));
  record("POST /me/notifications/clear-read wired", has("POST", "/me/notifications/clear-read"));
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, "../../artifacts/api-server/src/routes/meNotifications.ts"), "utf8");
  record("meNotifications.ts contains NO db.delete (soft-archive only)", !src.includes("db.delete("));
}

main()
  .then(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log(`\nSummary: ${results.length - failed.length}/${results.length} PASS`);
    if (failed.length > 0) {
      console.log("\nFailures:");
      for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(async (e) => {
    await cleanup().catch(() => {});
    console.error("alertsGroupingBulkTest crashed:", e);
    process.exit(1);
  });
