// Broker Hub — the one reader of the read-only connector's stored snapshots
// (broker_readonly_snapshots) and diagnostics (broker_readonly_logs).
//
// The Build KK read-only connector (lib/brokerReadOnly/service.ts) is the
// writer: it decides what a snapshot contains, redacts it and inserts it.
// Every read — the connector's own views and the notification ingest — goes
// through this file, so per-owner scoping is decided once. Every read is
// scoped to one owner id: legacy ownerless rows (user_id NULL) are never
// returned, and an owner of 0 matches nothing (fail closed).
//
// Honesty: a stored snapshot's `connected` is what the provider reported at
// createdAt, not a live status; callers carry createdAt with it. No snapshot
// means null, never a fabricated connected state.
// CI guard single-broker-state-source keeps these tables behind this file.

import { db, brokerReadonlyLogsTable, brokerReadonlySnapshotsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

export type ReadOnlySnapshotRow = typeof brokerReadonlySnapshotsTable.$inferSelect;
export type ReadOnlyLogRow = typeof brokerReadonlyLogsTable.$inferSelect;

/** "id": insertion order (connector views); "createdAt": event time (notification ingest). */
export type ReadOnlyOrder = "id" | "createdAt";

/** The owner's newest snapshots. */
export function listOwnerReadOnlySnapshots(ownerId: number, limit: number, order: ReadOnlyOrder = "id"): Promise<ReadOnlySnapshotRow[]> {
  const col = order === "id" ? brokerReadonlySnapshotsTable.id : brokerReadonlySnapshotsTable.createdAt;
  return db.select().from(brokerReadonlySnapshotsTable)
    .where(eq(brokerReadonlySnapshotsTable.userId, ownerId))
    .orderBy(desc(col)).limit(limit);
}

/** The owner's newest diagnostics. */
export function listOwnerReadOnlyLogs(ownerId: number, limit: number, order: ReadOnlyOrder = "id"): Promise<ReadOnlyLogRow[]> {
  const col = order === "id" ? brokerReadonlyLogsTable.id : brokerReadonlyLogsTable.createdAt;
  return db.select().from(brokerReadonlyLogsTable)
    .where(eq(brokerReadonlyLogsTable.userId, ownerId))
    .orderBy(desc(col)).limit(limit);
}

/** What the owner's newest snapshot reported, with its time; null when none exists. */
export async function readOwnerLatestReadOnlyStatus(ownerId: number): Promise<{ createdAt: Date; provider: string; connected: boolean } | null> {
  const [last] = await db.select({
    createdAt: brokerReadonlySnapshotsTable.createdAt,
    provider: brokerReadonlySnapshotsTable.provider,
    connected: brokerReadonlySnapshotsTable.connected,
  }).from(brokerReadonlySnapshotsTable)
    .where(eq(brokerReadonlySnapshotsTable.userId, ownerId))
    .orderBy(desc(brokerReadonlySnapshotsTable.id))
    .limit(1);
  return last ?? null;
}
