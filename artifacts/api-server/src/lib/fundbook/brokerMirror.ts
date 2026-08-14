// ARX Fund Book — broker-mirror read layer (Task #131). DB reads only.
//
// SAFETY / HONESTY (inviolable):
// - READ-ONLY against the bridge/broker tables (mt5_connection,
//   arx_live_positions). This module NEVER writes those tables, never closes a
//   position, and never touches any execution path.
// - getBrokerMirror returns RAW broker magnitudes (balance / equity / margin /
//   account numbers) and is ADMIN-ONLY by its callers. It is never exposed to
//   investors.
// - getPoolFloatingPl aggregates each open position's floating P/L into its
//   ASSIGNED pool. Unassigned positions contribute nothing and are returned
//   separately for an admin to resolve. The per-pool aggregate is the only
//   floating signal an investor ever sees (as their own pro-rata share),
//   never a raw position, ticket, or account number.

import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  mt5ConnectionTable,
  arxLivePositionsTable,
  tradePoolAllocationsTable,
  type ArxLivePosition,
} from "@workspace/db";
import {
  aggregatePoolFloatingPl,
  isFloatingPlIngestible,
  type MirrorPositionInput,
  type PoolFloatingAggregate,
} from "./plAllocator.js";
import {
  classifyBrokerFreshness,
  ageMsOf,
  type BrokerFreshness,
} from "./mirrorFreshness.js";

// A read handle satisfied by BOTH the singleton `db` and a transaction handle
// (`Tx`). The drawdown engine passes its own `tx` so the floating overlay is
// read from the SAME consistent snapshot as the rest of its inputs.
type DbReader = Pick<typeof db, "select">;

export interface OpenPositionWithPool extends ArxLivePosition {
  // The assigned pool id (null when UNASSIGNED), resolved from the allocation.
  strategyPoolId: number | null;
  allocationStatus: string | null;
}

/**
 * Read every OPEN broker position (closedAt IS NULL) and left-join its
 * trade-pool allocation so each position carries its assigned pool (or null).
 * System-level read used by both the admin mirror and the investor overlay.
 */
export async function getOpenPositionsWithPools(
  dbh: DbReader = db,
): Promise<OpenPositionWithPool[]> {
  const rows = await dbh
    .select({
      pos: arxLivePositionsTable,
      allocPoolId: tradePoolAllocationsTable.strategyPoolId,
      allocStatus: tradePoolAllocationsTable.status,
    })
    .from(arxLivePositionsTable)
    .leftJoin(
      tradePoolAllocationsTable,
      // Ticket uniqueness is per-user, so the join MUST be scoped by BOTH the
      // user id and the ticket — joining on ticket alone over-matches across
      // accounts and could attribute one user's position to another's pool.
      and(
        eq(arxLivePositionsTable.userId, tradePoolAllocationsTable.userId),
        eq(arxLivePositionsTable.brokerTicket, tradePoolAllocationsTable.brokerTicket),
      ),
    )
    .where(isNull(arxLivePositionsTable.closedAt));

  return rows.map((r) => {
    const assigned =
      r.allocStatus === "ASSIGNED" && r.allocPoolId != null ? r.allocPoolId : null;
    return {
      ...r.pos,
      strategyPoolId: assigned,
      allocationStatus: r.allocStatus ?? null,
    };
  });
}

/**
 * Aggregate open-position floating P/L into pools. Returns the per-pool sums
 * plus the unassigned list + data-unavailable count. The single source of the
 * floating overlay for the investor value endpoint and the drawdown engine.
 */
export async function getPoolFloatingPl(dbh: DbReader = db): Promise<{
  aggregate: PoolFloatingAggregate;
  positions: OpenPositionWithPool[];
}> {
  const positions = await getOpenPositionsWithPools(dbh);
  const inputs: MirrorPositionInput[] = positions.map((p) => ({
    brokerTicket: p.brokerTicket,
    userId: p.userId,
    symbol: p.symbol,
    floatingPl: p.floatingPl,
    strategyPoolId: p.strategyPoolId,
  }));
  return { aggregate: aggregatePoolFloatingPl(inputs), positions };
}

/**
 * The single freshness verdict for the floating-P/L overlay, derived from the
 * newest COMPLETE positions-snapshot marker across all bridges. This is the
 * only broker-derived signal an investor sees about their live P/L share — a
 * label, never a raw broker field. MISSING when no bridge has ever delivered a
 * snapshot.
 */
export async function getOverlayFreshness(now: number = Date.now()): Promise<{
  freshness: BrokerFreshness;
  asOf: Date | null;
}> {
  const connections = await db
    .select({ snapshotAt: mt5ConnectionTable.lastPositionsSnapshotAt })
    .from(mt5ConnectionTable);
  let newest: Date | null = null;
  for (const c of connections) {
    if (c.snapshotAt && (newest == null || c.snapshotAt > newest)) newest = c.snapshotAt;
  }
  return { freshness: classifyBrokerFreshness(ageMsOf(newest, now), { now }), asOf: newest };
}

export interface BridgeMirror {
  bridgeConnectionId: number;
  userId: number | null;
  connectionName: string | null;
  status: string;
  accountType: string;
  accountBalance: number;
  accountEquity: number;
  margin: number;
  freeMargin: number;
  accountCurrency: string | null;
  lastHeartbeatAt: Date | null;
  lastPositionsSnapshotAt: Date | null;
  // Freshness of the most recent of (heartbeat, positions snapshot).
  freshness: BrokerFreshness;
  freshnessAsOf: Date | null;
  openPositionCount: number;
  floatingPlTotal: number;
}

/**
 * ADMIN-ONLY broker mirror: per-bridge account state + open-position summary +
 * a 4-state freshness signal. Raw broker magnitudes — never exposed to
 * investors. Read-only.
 */
export async function getBrokerMirror(now: number = Date.now()): Promise<{
  bridges: BridgeMirror[];
  positions: OpenPositionWithPool[];
}> {
  const [connections, { positions }] = await Promise.all([
    db.select().from(mt5ConnectionTable),
    getPoolFloatingPl(),
  ]);

  const byBridge = new Map<number, OpenPositionWithPool[]>();
  for (const p of positions) {
    const list = byBridge.get(p.bridgeConnectionId) ?? [];
    list.push(p);
    byBridge.set(p.bridgeConnectionId, list);
  }

  const bridges: BridgeMirror[] = connections.map((c) => {
    const hbAge = ageMsOf(c.lastHeartbeat, now);
    const snapAge = ageMsOf(c.lastPositionsSnapshotAt, now);
    // Use the most recent of the two signals for the freshness verdict.
    const newestAge =
      hbAge == null ? snapAge : snapAge == null ? hbAge : Math.min(hbAge, snapAge);
    const freshnessAsOf =
      hbAge == null && snapAge == null
        ? null
        : hbAge == null
          ? c.lastPositionsSnapshotAt
          : snapAge == null
            ? c.lastHeartbeat
            : hbAge <= snapAge
              ? c.lastHeartbeat
              : c.lastPositionsSnapshotAt;
    const list = byBridge.get(c.id) ?? [];
    const floatingPlTotal = list.reduce(
      (acc, p) => (isFloatingPlIngestible(p.floatingPl) ? acc + p.floatingPl : acc),
      0,
    );
    return {
      bridgeConnectionId: c.id,
      userId: c.userId ?? null,
      connectionName: c.connectionName ?? null,
      status: c.status,
      accountType: c.accountType,
      accountBalance: c.accountBalance ?? 0,
      accountEquity: c.accountEquity ?? 0,
      margin: c.margin ?? 0,
      freeMargin: c.freeMargin ?? 0,
      accountCurrency: c.accountCurrency ?? null,
      lastHeartbeatAt: c.lastHeartbeat ?? null,
      lastPositionsSnapshotAt: c.lastPositionsSnapshotAt ?? null,
      freshness: classifyBrokerFreshness(newestAge, { now }),
      freshnessAsOf: freshnessAsOf ?? null,
      openPositionCount: list.length,
      floatingPlTotal: floatingPlTotal,
    };
  });

  return { bridges, positions };
}
