// Broker Hub — the one reader of the shared-master pool projection
// (arx_master_bridge_pool).
//
// The projection is OWNED and WRITTEN by lib/live/masterBridgePool.ts (LIVE
// execution domain): it recomputes balance/equity/margin mirrored from the
// pinned master mt5_connection plus allocation totals on every heartbeat and
// upserts one row per master. The admin pause/resume endpoints in
// routes/adminAllocations.ts write the sharedLivePaused flag. Both read the row
// back through this file, so there is one place that decides how the pool row
// is selected.
//
// Honesty: a row is what the last recompute stored. It carries
// lastMt5SnapshotAt / snapshotAgeMs / snapshotStatus (FRESH | STALE | MISSING)
// and recomputedAt so callers keep their staleness labels. No row means null,
// never a fabricated pool. This file never writes.
// CI guard single-broker-state-source keeps this table behind this file.

import { db, arxMasterBridgePoolTable, type ArxMasterBridgePool } from "@workspace/db";
import { eq } from "drizzle-orm";

export type MasterBridgePoolRow = ArxMasterBridgePool;

/** The pool row for one master connection, or null when none has been computed yet. */
export async function readMasterBridgePoolByMaster(masterConnectionId: number): Promise<MasterBridgePoolRow | null> {
  const rows = await db.select().from(arxMasterBridgePoolTable)
    .where(eq(arxMasterBridgePoolTable.masterConnectionId, masterConnectionId)).limit(1);
  return rows[0] ?? null;
}

/** True when any stored pool row is flagged over-allocated (cheap, unlocked pre-check). */
export async function anyMasterBridgePoolOverAllocated(): Promise<boolean> {
  const rows = await db.select({ id: arxMasterBridgePoolTable.id })
    .from(arxMasterBridgePoolTable)
    .where(eq(arxMasterBridgePoolTable.isOverAllocated, true))
    .limit(1);
  return rows.length > 0;
}
