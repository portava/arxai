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
//   realized  the RISK count of settled orders (sumPaperRealizedSince,
//             paperPnl.paperRiskTotals): the lower of two full totals over
//             the same closes, their booked total and their total at the
//             paper risk model (move × lots × 100), so no loss total or
//             equity cap reads looser than either basis and none drifts below
//             both; a losing streak reads each close's sign (realizedOf)
//   booked    bookedRealizedOf(): profit_loss as booked (an amount not sized
//             counts only when it lost, at the governor's paper model, and a
//             win of unknown size counts 0); the account balance adds it up
//
// The other two tables are NOT paper facts and are never mixed in here:
// paper_trades is the trader's hand-entered journal (lib/riskGovernor/
// journal.ts), and trades is the legacy simulated record and the DEMO
// ledger. Nothing here sums across those tables.
//
// Reads only. Pure source of facts; decides nothing.

import { db, paperAccountsTable, paperOrdersTable } from "@workspace/db";
import { and, desc, eq, gte, isNull, ne, sql, type SQL } from "drizzle-orm";
import { paperBookedRealized, paperRiskRealized, paperRiskTotals, type PaperCloseFigures } from "../paperExecution/paperPnl.js";

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
 * The paper book's RISK count of ONE settled order
 * (paperExecution/paperPnl.ts paperRiskRealized): the lower of its booked
 * amount (bookedRealizedOf) and the paper risk model (move × lots × 100). Its
 * sign is the close's sign, which the losing streak and win counts read: a
 * stop-out of unknown size reads as a loss, a win of unknown size counts 0.
 * A total over several closes (the daily loss total, the weekly P/L, the
 * equity a cap is valued on) is never a sum of these: it is the lower of the
 * booked total and the model total over the same closes (paperRiskTotals,
 * sumPaperRealizedSince), because a sum of per-close minimums takes every win
 * at the smaller figure and every loss at the larger one and drifts below
 * both totals. A risk count, not a measured result: the booked amount is the
 * P&L shown and the balance.
 */
export function realizedOf(o: PaperCloseFigures): number {
  return paperRiskRealized(o);
}

/**
 * Booked P/L of one settled order (paperPnl.paperBookedRealized): the stored
 * profit_loss when it is a sized amount; an amount that could not be sized
 * counts only when it lost (at the paper risk model) and a win of unknown
 * size counts 0. The paper account's balance adds this up.
 */
export function bookedRealizedOf(o: PaperCloseFigures): number {
  return paperBookedRealized(o);
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

/**
 * Realized P/L of orders in scope settled at or after `since`, as the RISK
 * count: the lower of their booked total and their total at the paper risk
 * model (paperPnl.paperRiskTotals), never a sum of per-close figures.
 */
export async function sumPaperRealizedSince(scope: PaperBookScope, since: Date): Promise<number> {
  const rows = await db.select({
    profitLoss: paperOrdersTable.profitLoss, exitPrice: paperOrdersTable.exitPrice, entryPrice: paperOrdersTable.entryPrice,
    direction: paperOrdersTable.direction, lotSize: paperOrdersTable.lotSize,
  }).from(paperOrdersTable).where(and(SETTLED, gte(paperOrdersTable.closedAt, since), scopeWhere(scope)));
  return paperRiskTotals(rows).risk;
}

/**
 * Settled orders in scope, newest close first, with `closedAt` and the
 * close's own risk count `pnl` (realizedOf: read its sign, never add these up
 * for a total; paperPnl.paperRiskTotals gives the total). `since` bounds the
 * close time; `limit` the row count.
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
