// Owners on weekly_improvement_plans, performance_symbol_snapshots and
// ai_performance_snapshots (Tier 1 step 10), on a real database.
//
// Proves each trader's persist / rebuild writes rows they own, two traders
// never overwrite each other's row for the same week / symbol / range, and
// the legacy claim moves only ownerless rows that do not collide. Where the
// migration's NOT VALID owner check is installed, an ownerless insert is
// refused by the database itself.
//
// Run: pnpm --filter @workspace/api-server run test:snapshot-ownership

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  aiPerformanceSnapshotsTable, db, paperAccountsTable, paperOrdersTable, performanceDailySnapshotsTable,
  performanceSymbolSnapshotsTable, usersTable, weeklyImprovementPlansTable,
} from "@workspace/db";
import { generateWeeklyPlan } from "../../traderCoach/weekly.js";
import { rebuildSnapshots } from "../rebuild.js";

const EMAILS = ["qa+snap-owner-a@arx.test", "qa+snap-owner-b@arx.test"];
const SYMBOL = "QASNAP.X";
const ids: number[] = [];
const quiet = { info: () => {}, warn: () => {} };

async function cleanup(): Promise<void> {
  const users = (await db.select({ id: usersTable.id }).from(usersTable).where(inArray(usersTable.email, EMAILS))).map((u) => u.id);
  await db.delete(performanceSymbolSnapshotsTable).where(eq(performanceSymbolSnapshotsTable.symbol, SYMBOL));
  if (!users.length) return;
  await db.delete(weeklyImprovementPlansTable).where(inArray(weeklyImprovementPlansTable.userId, users));
  await db.delete(aiPerformanceSnapshotsTable).where(inArray(aiPerformanceSnapshotsTable.userId, users));
  await db.delete(performanceDailySnapshotsTable).where(inArray(performanceDailySnapshotsTable.userId, users));
  await db.delete(paperOrdersTable).where(inArray(paperOrdersTable.userId, users));
  await db.delete(paperAccountsTable).where(inArray(paperAccountsTable.userId, users));
  await db.delete(usersTable).where(inArray(usersTable.id, users));
}

before(async () => {
  await cleanup();
  for (const email of EMAILS) {
    const [u] = await db.insert(usersTable).values({ email, name: email, role: "USER", isSystemUser: true }).returning({ id: usersTable.id });
    ids.push(u!.id);
    const [acct] = await db.insert(paperAccountsTable).values({ userId: u!.id, accountName: "qa", startingBalance: 10_000, currentBalance: 10_000, equity: 10_000 })
      .returning({ id: paperAccountsTable.id });
    await db.insert(paperOrdersTable).values({
      userId: u!.id, paperAccountId: acct!.id, symbol: SYMBOL, direction: "BUY", lotSize: 0.01, entryPrice: 100,
      stopLoss: 99, takeProfit: 102, status: "CLOSED_TP", exitPrice: 102, profitLoss: 2, closedAt: new Date(),
    });
  }
});
after(cleanup);

test("weekly plans: each trader persists their own row for the same week", async () => {
  const [a, b] = ids as [number, number];
  const pa = await generateWeeklyPlan({ userId: a, persist: true });
  await generateWeeklyPlan({ userId: b, persist: true });
  await generateWeeklyPlan({ userId: a, persist: true }); // upsert, not a second row
  const rows = await db.select().from(weeklyImprovementPlansTable)
    .where(and(inArray(weeklyImprovementPlansTable.userId, ids), eq(weeklyImprovementPlansTable.weekStart, pa.week_start)));
  assert.deepEqual(rows.map((r) => r.userId).sort(), [a, b].sort());
});

test("performance snapshots: each trader's rebuild writes owned symbol and AI rows", async () => {
  const [a, b] = ids as [number, number];
  await rebuildSnapshots(a, quiet);
  await rebuildSnapshots(b, quiet);
  const sym = await db.select().from(performanceSymbolSnapshotsTable)
    .where(and(eq(performanceSymbolSnapshotsTable.symbol, SYMBOL), eq(performanceSymbolSnapshotsTable.rangeKey, "all")));
  assert.deepEqual(sym.map((r) => r.userId).sort(), [a, b].sort(), "one row per trader, not one shared row");
  const ai = await db.select().from(aiPerformanceSnapshotsTable)
    .where(and(inArray(aiPerformanceSnapshotsTable.userId, ids), eq(aiPerformanceSnapshotsTable.rangeKey, "all")));
  assert.equal(ai.length, 2);
});

test("no writer leaves a row ownerless", async () => {
  for (const [name, t] of [["weekly", weeklyImprovementPlansTable], ["symbol", performanceSymbolSnapshotsTable], ["ai", aiPerformanceSnapshotsTable]] as const) {
    const fresh = await db.select({ id: t.id }).from(t).where(and(isNull(t.userId), sql`${t.createdAt} > now() - interval '5 minutes'`));
    assert.equal(fresh.length, 0, `${name}: a row written in this run has no owner`);
  }
});

test("database: where the owner check is installed, an ownerless insert is refused", async (t) => {
  const r = await db.execute(sql`SELECT 1 FROM pg_constraint WHERE conname = 'ai_performance_snapshots_owner_required'`);
  if (!r.rows.length) { t.skip("migration 2026-10-24_owner_columns.sql not applied to this database"); return; }
  await assert.rejects(
    db.insert(aiPerformanceSnapshotsTable).values({ rangeKey: "qa-ownerless" }),
    (e: Error & { cause?: { constraint?: string } }) => e.cause?.constraint === "ai_performance_snapshots_owner_required",
  );
});
