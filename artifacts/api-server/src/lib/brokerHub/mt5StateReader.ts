// Broker Hub read side of the legacy EA account feed (mt5_state).
//
// The EA bridge (routes/mt5.ts) is the only writer: heartbeats, account and
// position syncs land in mt5_state there. Every other module reads the feed
// through these functions, so ownership and ordering are decided in one place
// (Tier 1 step 11; ci guard broker-state-single-reader keeps it that way).
//
// Three reads exist, matching the three ways the feed is used:
//   platform   — the install-wide EA terminal (first row), for operator
//                health, safety and legacy singleton views;
//   per user   — that user's latest synced snapshot;
//   scoped     — first row matching a caller-supplied owner scope
//                (ownerScope / BrokerOwner), legacy rows only when the scope
//                admits them.

import { db, mt5StateTable } from "@workspace/db";
import { asc, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export type Mt5StateRow = typeof mt5StateTable.$inferSelect;

/** A db handle or an open transaction. */
type Reader = Pick<typeof db, "select">;

/** The install-wide EA feed row (lowest id), or null before the first heartbeat. */
export async function readPlatformMt5State(reader: Reader = db): Promise<Mt5StateRow | null> {
  const rows = await reader.select().from(mt5StateTable).orderBy(asc(mt5StateTable.id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Said when readLatestUserMt5State finds no row for the user. The EA bridge
 * writes the feed into the install-wide row only and never stamps a user on
 * it, so "no row" means the user's positions and account were not read from
 * this feed, never that they hold none.
 */
export const MT5_STATE_NOT_ATTRIBUTED_NOTE =
  "No MT5 snapshot is stored for your account in the EA account feed (the feed is saved install-wide, not per user), so your open positions were not read here. This is not a count of zero.";

/** The user's most recently synced snapshot, or null. Never returns another user's row. */
export async function readLatestUserMt5State(userId: number): Promise<Mt5StateRow | null> {
  const rows = await db.select().from(mt5StateTable)
    .where(eq(mt5StateTable.userId, userId))
    .orderBy(sql`${mt5StateTable.lastSyncAt} DESC NULLS LAST`)
    .limit(1);
  return rows[0] ?? null;
}

/** First row the owner scope admits; the scope is built by the caller's ownership helper. */
export async function readScopedMt5State(scope: (userIdColumn: PgColumn) => SQL): Promise<Mt5StateRow | null> {
  const rows = await db.select().from(mt5StateTable)
    .where(scope(mt5StateTable.userId))
    .orderBy(asc(mt5StateTable.id))
    .limit(1);
  return rows[0] ?? null;
}
