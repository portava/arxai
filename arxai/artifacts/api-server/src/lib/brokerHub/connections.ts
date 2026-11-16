// Broker Hub — the one owner of broker connection facts (mt5_connection).
//
// A connection row carries everything ARX knows about a trader's broker
// account: who owns it, whether the bridge is alive, the account number,
// balance, equity and margin the EA last reported, and the token that
// authenticates the bridge. Every module reads and writes those facts
// through this file, so ownership, revocation and secret handling are
// decided in one place (Tier 1 finalization, item 1; ci guard
// broker-connection-single-owner keeps it that way).
//
// Reads come in three scopes:
//   per user  — listUserConnections / getUserConnection: never another
//               user's row;
//   operator  — getConnection / listConnections: platform views and
//               bridge plumbing that already act for a known connection;
//   bridge    — findConnectionByBridgeTokenHash: EA authentication only.
//
// Secrets: the bridge token hashes are dropped from every read except the
// bridge-auth lookup. Callers see `hasBridgeToken` instead.

import { db, mt5ConnectionTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export type BrokerConnectionRecord = typeof mt5ConnectionTable.$inferSelect;
export type BrokerConnectionInsert = typeof mt5ConnectionTable.$inferInsert;
export type BrokerConnectionPatch = Partial<Omit<BrokerConnectionInsert, "id">>;

/** The broker facts of a connection without its token hashes (a stored row also satisfies it). */
export type BrokerConnectionFacts = Omit<BrokerConnectionRecord, "apiKeyHash" | "previousApiKeyHash">;

/** A connection as every caller outside bridge auth sees it: no token hashes. */
export type BrokerConnection = BrokerConnectionFacts & {
  /** An active (non-revoked) bridge token is issued for this connection. */
  hasBridgeToken: boolean;
};

/** A db handle or an open transaction. */
type Reader = Pick<typeof db, "select">;
type Writer = Pick<typeof db, "update" | "insert">;

export function toBrokerConnection(row: BrokerConnectionRecord): BrokerConnection {
  const { apiKeyHash, previousApiKeyHash: _prev, ...rest } = row;
  return { ...rest, hasBridgeToken: apiKeyHash != null && row.tokenRevokedAt == null };
}

export interface ConnectionQuery {
  userIds?: number[];
  statuses?: string[];
  /** Bridge mode (MOCK | DEMO | LIVE_LOCKED | LIVE). */
  modes?: string[];
  connectionIds?: number[];
  /** Leave out connections whose bridge token was revoked. */
  activeTokenOnly?: boolean;
  order?: "newest" | "oldest" | "heartbeat" | "updated" | "accountSynced" | "positionsSnapshot";
  limit?: number;
}

function orderBy(o: ConnectionQuery["order"]) {
  switch (o) {
    case "oldest": return [asc(mt5ConnectionTable.id)];
    case "heartbeat": return [sql`${mt5ConnectionTable.lastHeartbeat} DESC NULLS LAST`, desc(mt5ConnectionTable.createdAt)];
    case "updated": return [desc(mt5ConnectionTable.updatedAt)];
    case "positionsSnapshot": return [sql`${mt5ConnectionTable.lastPositionsSnapshotAt} DESC NULLS LAST`, desc(mt5ConnectionTable.id)];
    case "accountSynced": return [sql`${mt5ConnectionTable.accountSyncedAt} DESC NULLS LAST`, desc(mt5ConnectionTable.id)];
    default: return [desc(mt5ConnectionTable.createdAt), desc(mt5ConnectionTable.id)];
  }
}

async function query(where: SQL[], q: ConnectionQuery, reader: Reader): Promise<BrokerConnection[]> {
  if (q.userIds && q.userIds.length === 0) return [];
  const conds = [...where];
  if (q.userIds) conds.push(inArray(mt5ConnectionTable.userId, q.userIds));
  if (q.connectionIds && q.connectionIds.length === 0) return [];
  if (q.statuses?.length) conds.push(inArray(mt5ConnectionTable.status, q.statuses));
  if (q.modes?.length) conds.push(inArray(mt5ConnectionTable.mode, q.modes));
  if (q.connectionIds) conds.push(inArray(mt5ConnectionTable.id, q.connectionIds));
  if (q.activeTokenOnly) conds.push(isNull(mt5ConnectionTable.tokenRevokedAt));
  const base = reader.select().from(mt5ConnectionTable).where(conds.length ? and(...conds) : undefined).orderBy(...orderBy(q.order));
  const rows = q.limit != null ? await base.limit(q.limit) : await base;
  return rows.map(toBrokerConnection);
}

// ── Per-user reads ─────────────────────────────────────────────────────────

/** The user's connections, newest first unless ordered otherwise. */
export function listUserConnections(userId: number, q: Omit<ConnectionQuery, "userIds"> = {}, reader: Reader = db): Promise<BrokerConnection[]> {
  return query([eq(mt5ConnectionTable.userId, userId)], q, reader);
}

/** One connection, only if this user owns it. */
export async function getUserConnection(userId: number, connectionId: number, reader: Reader = db): Promise<BrokerConnection | null> {
  const rows = await query([eq(mt5ConnectionTable.userId, userId), eq(mt5ConnectionTable.id, connectionId)], { limit: 1 }, reader);
  return rows[0] ?? null;
}

/**
 * The user's first-registered connection. Code that assumes one broker
 * account per trader reads this, so every such reader agrees on which row.
 */
export async function getUserPrimaryConnection(userId: number, reader: Reader = db): Promise<BrokerConnection | null> {
  const rows = await listUserConnections(userId, { order: "oldest", limit: 1 }, reader);
  return rows[0] ?? null;
}

/** Account-summary selection, shared by JSON, SSE, investor views and advice.
 * Most recently account-synced, then id; revoked connections never supply facts.
 * Execution routing remains explicit and does not use this display selection. */
export async function getUserAccountConnection(userId: number, reader: Reader = db): Promise<BrokerConnection | null> {
  return (await listUserConnections(userId, { order: "accountSynced" }, reader))
    .find(c => c.status !== "revoked" && c.tokenRevokedAt == null) ?? null;
}

/** The user's live bridge: most recent heartbeat among non-revoked connections. */
export async function getUserActiveConnection(userId: number, reader: Reader = db): Promise<BrokerConnection | null> {
  const rows = await listUserConnections(userId, { activeTokenOnly: true, order: "heartbeat", limit: 1 }, reader);
  return rows[0] ?? null;
}

/** Status not revoked and account type not demo (unclassified bridges count as live). */
function isLiveCandidate(c: BrokerConnection): boolean {
  return c.status !== "revoked" && (c.accountType == null || c.accountType !== "demo");
}

/** The user's live (non-demo, non-revoked) bridge: freshest heartbeat, or newest positions snapshot. */
export async function getUserLiveBridge(userId: number, by: "heartbeat" | "positionsSnapshot" = "heartbeat"): Promise<BrokerConnection | null> {
  return (await listUserConnections(userId, { order: by })).find(isLiveCandidate) ?? null;
}

/**
 * Newest complete positions-snapshot marker across the user's live bridges,
 * in ms, or null. Open positions are only trusted as current against it.
 */
export async function getUserLiveSnapshotMarkerMs(userId: number): Promise<number | null> {
  const times = (await listUserConnections(userId)).filter(isLiveCandidate)
    .map((c) => c.lastPositionsSnapshotAt?.getTime() ?? null).filter((t): t is number => t != null);
  return times.length ? Math.max(...times) : null;
}

/** Connections an owner scope admits (the caller's ownership helper builds it). */
export function listScopedConnections(scope: (userIdColumn: PgColumn) => SQL, q: ConnectionQuery = {}, reader: Reader = db): Promise<BrokerConnection[]> {
  return query([scope(mt5ConnectionTable.userId)], q, reader);
}

// ── Operator / plumbing reads ─────────────────────────────────────────────

/** A connection by id, for code that already acts for that connection (bridge, admin, routing). */
export async function getConnection(connectionId: number, reader: Reader = db): Promise<BrokerConnection | null> {
  const rows = await query([eq(mt5ConnectionTable.id, connectionId)], { limit: 1 }, reader);
  return rows[0] ?? null;
}

/** Lock the exact bridge while a server command target is validated. */
export async function lockConnection(connectionId: number, reader: Reader): Promise<BrokerConnection | null> {
  const [row] = await reader.select().from(mt5ConnectionTable)
    .where(eq(mt5ConnectionTable.id, connectionId)).for("update");
  return row ? toBrokerConnection(row) : null;
}

/** Connections across users, for operator views and platform health. */
export function listConnections(q: ConnectionQuery = {}, reader: Reader = db): Promise<BrokerConnection[]> {
  return query([], q, reader);
}

/** Whether any user has an active bridge token (presence only). */
export async function anyActiveBridgeToken(): Promise<boolean> {
  const rows = await listConnections({ activeTokenOnly: true });
  return rows.some((r) => r.hasBridgeToken);
}

// ── Bridge authentication ─────────────────────────────────────────────────

export interface BridgeTokenMatch {
  connection: BrokerConnectionRecord;
  /** "current" token, or the previous token inside its rotation grace window. */
  via: "current" | "previous_grace";
}

/** EA auth: the connection whose current or (in grace) previous token hashes to `hash`. */
export async function findConnectionByBridgeTokenHash(hash: string, now: Date = new Date()): Promise<BridgeTokenMatch | null> {
  const [cur] = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.apiKeyHash, hash), isNull(mt5ConnectionTable.tokenRevokedAt))).limit(1);
  if (cur) return { connection: cur, via: "current" };
  const grace = await db.select().from(mt5ConnectionTable)
    .where(and(eq(mt5ConnectionTable.previousApiKeyHash, hash), isNull(mt5ConnectionTable.tokenRevokedAt))).limit(1);
  const g = grace[0];
  if (g && g.previousTokenExpiresAt && g.previousTokenExpiresAt.getTime() > now.getTime()) return { connection: g, via: "previous_grace" };
  return null;
}

// ── Writes ────────────────────────────────────────────────────────────────

/** Create a connection (the trader's MT5 setup). */
export async function createConnection(values: BrokerConnectionInsert, writer: Writer = db): Promise<BrokerConnectionRecord> {
  const [row] = await writer.insert(mt5ConnectionTable).values(values).returning();
  return row!;
}

/** Change a connection the user owns. Returns null when it is not theirs. */
export async function updateUserConnection(userId: number, connectionId: number, patch: BrokerConnectionPatch, writer: Writer = db): Promise<BrokerConnectionRecord | null> {
  const rows = await writer.update(mt5ConnectionTable).set(patch)
    .where(and(eq(mt5ConnectionTable.id, connectionId), eq(mt5ConnectionTable.userId, userId))).returning();
  return rows[0] ?? null;
}

/** Change a connection by id: bridge heartbeats and syncs, operator token actions. */
export async function updateConnection(connectionId: number, patch: BrokerConnectionPatch, writer: Writer = db): Promise<BrokerConnectionRecord | null> {
  const rows = await writer.update(mt5ConnectionTable).set(patch).where(eq(mt5ConnectionTable.id, connectionId)).returning();
  return rows[0] ?? null;
}

/**
 * Operator token rotation. The outgoing hash is parked for the grace window
 * (copied in SQL, so it never leaves the database); no grace = instant cutover.
 */
export async function rotateBridgeToken(connectionId: number, t: {
  hash: string; last4: string; now: Date; graceExpiry: Date | null; adminId: number | null; reason: string;
}, writer: Writer = db): Promise<BrokerConnectionRecord | null> {
  const rows = await writer.update(mt5ConnectionTable).set({
    apiKeyHash: t.hash,
    tokenLast4: t.last4,
    tokenCreatedAt: t.now,
    previousApiKeyHash: t.graceExpiry ? sql`${mt5ConnectionTable.apiKeyHash}` : null,
    previousTokenExpiresAt: t.graceExpiry,
    tokenRotatedAt: t.now,
    tokenRotatedByAdminId: t.adminId,
    tokenRotationReason: t.reason,
    updatedAt: t.now,
  }).where(eq(mt5ConnectionTable.id, connectionId)).returning();
  return rows[0] ?? null;
}

/** Revoke a bridge: both the active and any grace token stop authenticating. */
export async function revokeBridgeToken(connectionId: number, now: Date, writer: Writer = db): Promise<BrokerConnectionRecord | null> {
  return updateConnection(connectionId, {
    status: "revoked", tokenRevokedAt: now, apiKeyHash: null, previousApiKeyHash: null, previousTokenExpiresAt: null, updatedAt: now,
  }, writer);
}

/** Remove test-fixture connections a QA script created. Never called by the app. */
export async function deleteFixtureConnections(connectionIds: number[]): Promise<void> {
  if (connectionIds.length) await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.id, connectionIds));
}
