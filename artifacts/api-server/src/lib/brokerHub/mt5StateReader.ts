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

/**
 * The install-wide EA feed row, or null before the first heartbeat.
 *
 * mt5_state holds one row per bridge user (plus, on an upgraded install, the
 * legacy unowned row until a user adopts it). The platform read is the row of
 * the EA that heartbeated most recently; ties and never-heartbeated rows fall
 * back to the lowest id. It is an operator view of "the terminal that is
 * talking to us now", never any one user's account.
 */
export async function readPlatformMt5State(reader: Reader = db): Promise<Mt5StateRow | null> {
  const rows = await reader.select().from(mt5StateTable)
    .orderBy(sql`${mt5StateTable.lastHeartbeatAt} DESC NULLS LAST`, asc(mt5StateTable.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Said when readLatestUserMt5State finds no row for the user. Each bridge
 * user's EA writes its own mt5_state row, so "no row" means this user's EA has
 * not sent a snapshot yet (or their bridge is not attached): the positions and
 * account were not read, never that they hold none.
 */
export const MT5_STATE_NOT_ATTRIBUTED_NOTE =
  "No MT5 snapshot is stored for your account yet: your Expert Advisor has not sent one through your bridge, so your open positions were not read here. This is not a count of zero.";

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
