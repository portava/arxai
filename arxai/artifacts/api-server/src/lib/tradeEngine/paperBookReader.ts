// The paper book's read side (owner decision 7).
//
// paper_orders is the canonical simulated-position book (written only by
// ./paperVenue.ts). Automated PAPER P/L, activity, losing streaks and risk
// decisions read it through these functions, so every reader agrees on what
// "open", "settled" and "realized" mean:
//
//   open      status = 'OPEN'
//   settled   status <> 'OPEN' with a closed_at (CLOSED_SL / CLOSED_TP /
//             CLOSED_MANUAL, and a CANCELLED the venue settled); a voided
//             order (CANCELLED, no closed_at) never counts
//   realized  sum of profit_loss over settled orders
//
// The other two tables are NOT paper facts and are never mixed in here:
// paper_trades is the trader's hand-entered journal (lib/riskGovernor/
// journal.ts), and trades is the legacy simulated record and the DEMO
// ledger. Nothing here sums across those tables.
//
// Reads only. Pure source of facts; decides nothing.

import { db, paperAccountsTable, paperOrdersTable } from "@workspace/db";
import { and, desc, eq, gte, isNull, ne, sql, type SQL } from "drizzle-orm";

export type PaperOrderRow = typeof paperOrdersTable.$inferSelect;
export type PaperAccountRow = typeof paperAccountsTable.$inferSelect;

/** Which part of the book a read covers. */
export type PaperBookScope =
  /** One paper account (the Risk Governor reads the active account). */
  | { account: number }
  /** Every paper account of one trader. */
  | { user: number }
  /** The autopilot owner's orders for one strategy; owner null = ownerless rows. */
  | { owner: number | null; strategyId: string }
  /** The operator's whole-install read model (no owner filter). */
  | { install: true };

function scopeWhere(scope: PaperBookScope): SQL | undefined {
  if ("account" in scope) return eq(paperOrdersTable.paperAccountId, scope.account);
  if ("user" in scope) return eq(paperOrdersTable.userId, scope.user);
  if ("strategyId" in scope) {
    return and(
      eq(paperOrdersTable.strategyId, scope.strategyId),
      scope.owner == null ? isNull(paperOrdersTable.userId) : eq(paperOrdersTable.userId, scope.owner),
    );
  }
  return undefined;
}

const SETTLED = and(ne(paperOrdersTable.status, "OPEN"), sql`${paperOrdersTable.closedAt} is not null`);

/** True for an order status the venue has settled (not OPEN). */
export function isSettledPaperStatus(status: string): boolean {
  return status !== "OPEN";
}

/**
 * Realized P/L of one settled order. An order settled without a recorded
 * profit_loss (no current writer does this) reads its sign from the fill
 * prices, so missing P/L never reads as a win or resets a losing streak.
 */
export function realizedOf(o: Pick<PaperOrderRow, "exitPrice" | "entryPrice" | "direction" | "lotSize"> & { profitLoss: number | null }): number {
  if (o.profitLoss != null) return Number(o.profitLoss);
  if (o.exitPrice == null) return 0;
  const dir = o.direction === "SELL" ? -1 : 1;
  return (o.exitPrice - o.entryPrice) * dir * Math.abs(o.lotSize || 1);
}

/** The trader's paper account: the given id (if theirs), else the newest active one. */
export async function readActivePaperAccount(userId: number, accountId?: number | null): Promise<PaperAccountRow | null> {
  const rows = accountId != null
    ? await db.select().from(paperAccountsTable).where(and(
        eq(paperAccountsTable.id, accountId), eq(paperAccountsTable.userId, userId))).limit(1)
    : await db.select().from(paperAccountsTable).where(and(
        eq(paperAccountsTable.userId, userId), eq(paperAccountsTable.isActive, 1)))
        .orderBy(desc(paperAccountsTable.createdAt)).limit(1);
  return rows[0] ?? null;
}

/** Open orders in scope. */
export async function readOpenPaperOrders(scope: PaperBookScope): Promise<PaperOrderRow[]> {
  return db.select().from(paperOrdersTable).where(and(eq(paperOrdersTable.status, "OPEN"), scopeWhere(scope)));
}

/** Orders in scope opened at or after `since` (any status). */
export async function readPaperOrdersOpenedSince(scope: PaperBookScope, since: Date): Promise<PaperOrderRow[]> {
  return db.select().from(paperOrdersTable).where(and(gte(paperOrdersTable.openedAt, since), scopeWhere(scope)));
}

/** Orders in scope opened at or after `since` that are still open. */
export async function countPaperOpenedSinceStillOpen(scope: PaperBookScope, since: Date): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(paperOrdersTable).where(and(
    eq(paperOrdersTable.status, "OPEN"), gte(paperOrdersTable.openedAt, since), scopeWhere(scope)));
  return Number(r?.n ?? 0);
}

/** Realized P/L of orders in scope settled at or after `since`. */
export async function sumPaperRealizedSince(scope: PaperBookScope, since: Date): Promise<number> {
  const rows = await db.select({
    profitLoss: paperOrdersTable.profitLoss, exitPrice: paperOrdersTable.exitPrice, entryPrice: paperOrdersTable.entryPrice,
    direction: paperOrdersTable.direction, lotSize: paperOrdersTable.lotSize,
  }).from(paperOrdersTable).where(and(SETTLED, gte(paperOrdersTable.closedAt, since), scopeWhere(scope)));
  return rows.reduce((s, o) => s + realizedOf(o), 0);
}

/**
 * Settled orders in scope, newest close first, with `closedAt` and the
 * realized `pnl`. `since` bounds the close time; `limit` the row count.
 */
export async function readPaperCloses(
  scope: PaperBookScope,
  opts: { since?: Date; limit?: number } = {},
): Promise<Array<PaperOrderRow & { closedAt: Date; pnl: number }>> {
  const q = db.select().from(paperOrdersTable)
    .where(and(SETTLED, opts.since ? gte(paperOrdersTable.closedAt, opts.since) : undefined, scopeWhere(scope)))
    .orderBy(desc(paperOrdersTable.closedAt));
  const rows = opts.limit != null ? await q.limit(opts.limit) : await q;
  return rows.map((o) => ({ ...o, closedAt: o.closedAt!, pnl: realizedOf(o) }));
}

/** Every order in scope (any status), for read models that link orders to decisions. */
export async function readPaperOrders(scope: PaperBookScope): Promise<PaperOrderRow[]> {
  return db.select().from(paperOrdersTable).where(scopeWhere(scope));
}
