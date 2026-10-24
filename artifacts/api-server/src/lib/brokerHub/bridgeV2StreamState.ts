// Broker Hub — the one reader of Bridge v2 per-stream state
// (bridge_v2_stream_state).
//
// Bridge v2 ingest (lib/bridgeV2/ingest.ts) is the writer: it seeds each
// stream row, locks it (SELECT ... FOR UPDATE inside the ingest transaction)
// and advances the sequence and integrity counters. Every status read — the
// readiness/freshness derivation in lib/bridgeV2/status.ts and the admin
// stream trace in routes/bridgeV2.ts — goes through this file.
//
// Honesty: a row is what ingest last stored (lastEventAt, lastSequence,
// counters, updatedAt). Freshness is derived by lib/bridgeV2/status.ts from
// those timestamps; this file derives nothing and never writes. No rows means
// an empty list, never a fabricated stream.
// CI guard single-broker-state-source keeps this table behind this file.

import { db, bridgeV2StreamStateTable, type BridgeV2StreamState } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";

export type BridgeV2StreamStateRow = BridgeV2StreamState;

function scope(userId: number | null) {
  return userId != null ? eq(bridgeV2StreamStateTable.userId, userId) : sql`true`;
}

/** Every stream row for one user, or for all users when userId is null. Unordered. */
export function listBridgeV2StreamStates(userId: number | null): Promise<BridgeV2StreamStateRow[]> {
  return db.select().from(bridgeV2StreamStateTable).where(scope(userId));
}

/** Stream rows newest-updated first, capped at `limit` (admin integrity trace). */
export function listRecentBridgeV2StreamStates(userId: number | null, limit: number): Promise<BridgeV2StreamStateRow[]> {
  return db.select().from(bridgeV2StreamStateTable).where(scope(userId))
    .orderBy(desc(bridgeV2StreamStateTable.updatedAt)).limit(limit);
}
