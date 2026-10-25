/**
 * The persistence boundary for broker-observed positions.
 *
 * LIVE and the DEMO/legacy EA mirror still have different physical schemas.
 * Only this module queries them. Callers receive rows and column descriptors
 * for typed predicates/projections, never a table or an executable query builder.
 * Authentication, Risk Governor decisions and broker commands remain at their
 * existing boundaries: writing a snapshot is not authority to place a trade.
 *
 * Predicates are explicit because operator-wide reads, user reads, historical
 * reads and compare-and-set reconciliation have different scopes. Transactions
 * must be passed through; never replace a supplied executor with the global db.
 */
import { and, eq, getTableColumns, isNull, isNotNull, ne, desc, sql, type SQL } from "drizzle-orm";
import type {
  AnyPgColumn,
  PgInsertValue,
  PgUpdateSetSource,
  SelectedFields,
  SelectedFieldsFlat,
} from "drizzle-orm/pg-core";
import {
  db,
  pool,
  arxLivePositionsTable,
  livePositionsTable,
  sharedTradeAttributionTable,
  tradePoolAllocationsTable,
} from "@workspace/db";
import type { PoolClient } from "../concurrency/advisoryLock.js";

export type LivePositionRow = typeof arxLivePositionsTable.$inferSelect;
export type DemoPositionRow = typeof livePositionsTable.$inferSelect;
export const livePositionColumns = getTableColumns(arxLivePositionsTable);
export const demoPositionColumns = getTableColumns(livePositionsTable);

type Reader = Pick<typeof db, "select" | "selectDistinct">;
type Writer = Pick<typeof db, "insert" | "update">;
export interface PositionReadOptions {
  where?: SQL;
  orderBy?: Array<AnyPgColumn | SQL | SQL.Aliased>;
  groupBy?: Array<AnyPgColumn | SQL | SQL.Aliased>;
  limit?: number;
  distinct?: boolean;
}

interface ConfigurableRead {
  where(predicate: SQL): unknown;
  groupBy(...columns: Array<AnyPgColumn | SQL | SQL.Aliased>): unknown;
  orderBy(...columns: Array<AnyPgColumn | SQL | SQL.Aliased>): unknown;
  limit(count: number): unknown;
}

function configure(query: ConfigurableRead, options: PositionReadOptions): void {
  if (options.where !== undefined) query.where(options.where);
  if (options.groupBy !== undefined) query.groupBy(...options.groupBy);
  if (options.orderBy !== undefined) query.orderBy(...options.orderBy);
  if (options.limit !== undefined) query.limit(options.limit);
}

function requireWriteScope(where: SQL | undefined): SQL {
  if (!where) throw new Error("Position ledger writes require an explicit predicate");
  return where;
}

export const livePositionLedger = {
  async read(options: PositionReadOptions = {}, executor: Reader = db) {
    const query = executor.select().from(arxLivePositionsTable).$dynamic();
    configure(query, options);
    return query;
  },
  async select<T extends SelectedFields>(
    fields: T,
    options: PositionReadOptions = {},
    executor: Reader = db,
  ) {
    if (options.distinct) {
      const query = executor.selectDistinct(fields).from(arxLivePositionsTable).$dynamic();
      configure(query, options);
      return query;
    }
    const query = executor.select(fields).from(arxLivePositionsTable).$dynamic();
    configure(query, options);
    return query;
  },
};

/** Broker-fact ingestion only; CI restricts consumers to the existing writers. */
export const livePositionWriter = {
  async update(
    values: PgUpdateSetSource<typeof arxLivePositionsTable>,
    where: SQL | undefined,
    executor: Writer = db,
  ) {
    return executor.update(arxLivePositionsTable).set(values).where(requireWriteScope(where));
  },
  async updateReturning<T extends SelectedFieldsFlat>(
    values: PgUpdateSetSource<typeof arxLivePositionsTable>,
    where: SQL | undefined,
    fields: T,
    executor: Writer = db,
  ) {
    return executor
      .update(arxLivePositionsTable)
      .set(values)
      .where(requireWriteScope(where))
      .returning(fields);
  },
  async insert(
    values: PgInsertValue<typeof arxLivePositionsTable>,
    ignoreDuplicateTicket = false,
    executor: Writer = db,
  ) {
    const query = executor.insert(arxLivePositionsTable).values(values);
    return ignoreDuplicateTicket
      ? query.onConflictDoNothing({
          target: [arxLivePositionsTable.userId, arxLivePositionsTable.brokerTicket],
        })
      : query;
  },
  async insertReturning<T extends SelectedFieldsFlat>(
    values: PgInsertValue<typeof arxLivePositionsTable>,
    fields: T,
    ignoreDuplicateTicket = false,
    executor: Writer = db,
  ) {
    const query = executor.insert(arxLivePositionsTable).values(values);
    return (
      ignoreDuplicateTicket
        ? query.onConflictDoNothing({
            target: [arxLivePositionsTable.userId, arxLivePositionsTable.brokerTicket],
          })
        : query
    ).returning(fields);
  },
};

export const demoPositionLedger = {
  async read(options: PositionReadOptions = {}, executor: Reader = db) {
    const query = executor.select().from(livePositionsTable).$dynamic();
    configure(query, options);
    return query;
  },
  async select<T extends SelectedFields>(
    fields: T,
    options: PositionReadOptions = {},
    executor: Reader = db,
  ) {
    if (options.distinct) {
      const query = executor.selectDistinct(fields).from(livePositionsTable).$dynamic();
      configure(query, options);
      return query;
    }
    const query = executor.select(fields).from(livePositionsTable).$dynamic();
    configure(query, options);
    return query;
  },
};

/** Broker-fact ingestion only; CI restricts consumers to the existing writers. */
export const demoPositionWriter = {
  async update(
    values: PgUpdateSetSource<typeof livePositionsTable>,
    where: SQL | undefined,
    executor: Writer = db,
  ) {
    return executor.update(livePositionsTable).set(values).where(requireWriteScope(where));
  },
  async updateReturning<T extends SelectedFieldsFlat>(
    values: PgUpdateSetSource<typeof livePositionsTable>,
    where: SQL | undefined,
    fields: T,
    executor: Writer = db,
  ) {
    return executor.update(livePositionsTable).set(values).where(requireWriteScope(where)).returning(fields);
  },
  async insert(
    values: PgInsertValue<typeof livePositionsTable>,
    ignoreDuplicateTicket = false,
    executor: Writer = db,
  ) {
    const query = executor.insert(livePositionsTable).values(values);
    return ignoreDuplicateTicket
      ? query.onConflictDoNothing({
          target: [livePositionsTable.userId, livePositionsTable.brokerPositionId],
        })
      : query;
  },
  async insertReturning<T extends SelectedFieldsFlat>(
    values: PgInsertValue<typeof livePositionsTable>,
    fields: T,
    ignoreDuplicateTicket = false,
    executor: Writer = db,
  ) {
    const query = executor.insert(livePositionsTable).values(values);
    return (
      ignoreDuplicateTicket
        ? query.onConflictDoNothing({
            target: [livePositionsTable.userId, livePositionsTable.brokerPositionId],
          })
        : query
    ).returning(fields);
  },
};

/** Tenant-scoped join owned here so callers cannot join position tables directly. */
export async function readOpenLivePositionsWithPools(executor: Pick<typeof db, "select"> = db) {
  return executor
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
}

/** Tenant-scoped join owned here so callers cannot join position tables directly. */
export async function readAttributedLivePositions(userId: number) {
  return db
    .select({
      id: sharedTradeAttributionTable.id,
      virtualAccountId: sharedTradeAttributionTable.virtualAccountId,
      sharedMasterAccountId: sharedTradeAttributionTable.sharedMasterAccountId,
      symbol: sharedTradeAttributionTable.symbol,
      side: sharedTradeAttributionTable.side,
      lotSize: sharedTradeAttributionTable.lotSize,
      stopLoss: sharedTradeAttributionTable.stopLoss,
      takeProfit: sharedTradeAttributionTable.takeProfit,
      slippage: sharedTradeAttributionTable.slippage,
      brokerTicket: arxLivePositionsTable.brokerTicket,
      entryPrice: arxLivePositionsTable.entryPrice,
      currentPrice: arxLivePositionsTable.currentPrice,
      pnl: arxLivePositionsTable.floatingPl,
      openedAt: arxLivePositionsTable.openedAt,
      lastSyncedAt: arxLivePositionsTable.lastSyncedAt,
    })
    .from(sharedTradeAttributionTable)
    .innerJoin(
      arxLivePositionsTable,
      and(
        // Per-user isolation: arx_live_positions uniqueness is (user_id,
        // broker_ticket), NOT global — so the join MUST be scoped by user or a
        // shared ticket string could cross-join another user's live position.
        eq(arxLivePositionsTable.userId, sharedTradeAttributionTable.userId),
        eq(arxLivePositionsTable.brokerTicket, sharedTradeAttributionTable.mt5PositionTicket),
        isNull(arxLivePositionsTable.closedAt),
        isNull(arxLivePositionsTable.reconcileState),
      ),
    )
    .where(
      and(
        eq(sharedTradeAttributionTable.userId, userId),
        eq(sharedTradeAttributionTable.status, "open"),
        isNotNull(sharedTradeAttributionTable.mt5PositionTicket),
        ne(sharedTradeAttributionTable.mt5PositionTicket, ""),
      ),
    )
    .orderBy(desc(arxLivePositionsTable.openedAt));
}

/** Must use the caller's advisory-lock transaction connection. */
export async function readLiveFloatingLoss(client: Pick<PoolClient, "query">, userId: number) {
  return client.query<{ loss: string | number | null }>(
    `SELECT COALESCE(SUM(LEAST(floating_pl, 0)), 0) AS loss
           FROM arx_live_positions
          WHERE user_id = $1
            AND closed_at IS NULL
            AND reconcile_state IS NULL`,
    [userId],
  );
}

/** Operator detector: unreconciled open broker rows without a governed entry. */
export async function readOrphanLivePositions() {
  return pool.query<Record<string, unknown>>(
    `SELECT p.id, p.user_id, p.bridge_connection_id, p.broker_ticket, p.symbol,
              p.source_command_id, p.opened_at,
              p.broker_absent_snapshot_count, p.first_broker_absent_at,
              p.last_broker_absent_at, p.last_reliable_snapshot_at
         FROM arx_live_positions p
        WHERE p.closed_at IS NULL
          AND p.reconcile_state IS NULL
          AND (p.source_command_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM arx_live_commands c
                               WHERE c.command_id = p.source_command_id))
        LIMIT 50`,
  );
}

/** Diagnostic count; no guessed ownership or trade authority. */
export async function countDemoPositions(): Promise<number> {
  const [row] = await demoPositionLedger.select({ c: sql<number>`count(*)::int` });
  return row?.c ?? 0;
}

export interface LivePositionReconciliationMetadata {
  reconcileState: string;
  reconcileNote: string;
  reconciledByAdminId: number | null;
  reconciledAt: Date;
  sourceCommandId?: string;
}

/** Operator metadata only, in the same transaction as its audit record. */
export async function reconcileLivePositionMetadata(
  id: number,
  metadata: LivePositionReconciliationMetadata,
  executor: Pick<typeof db, "update">,
) {
  // Copy only metadata keys: a wider object cannot smuggle protection/ownership changes.
  const { reconcileState, reconcileNote, reconciledByAdminId, reconciledAt, sourceCommandId } = metadata;
  return executor
    .update(arxLivePositionsTable)
    .set({
      reconcileState,
      reconcileNote,
      reconciledByAdminId,
      reconciledAt,
      sourceCommandId,
    })
    .where(eq(arxLivePositionsTable.id, id))
    .returning();
}
