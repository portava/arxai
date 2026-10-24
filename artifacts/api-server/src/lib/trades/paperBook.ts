// Legacy simulated-trade book: the `trades` table. There is no broker behind
// these rows — /execute-trade never places a broker order, even when Safety
// Core reports LIVE (the row's `mode` column then says "LIVE"; it is still a
// record only). See docs/TIER1_PAPER_BOOK.md.
//
// This module is the ONLY runtime writer of `trades` (check-single-paper-book):
//
//   recordLegacyExecuteTrade  — the /execute-trade record (routes/trades.ts),
//                               after that route's Safety Core, broker-health
//                               and confirmation gates.
//   cancelOpenLegacyTrades    — the bot emergency stop cancels the trader's
//                               own open rows (routes/bot.ts; risk-reducing).
//   applyPaperManagement      — a Position Guardian management step. Only
//                               lib/positionGuardian/manage.ts calls it, after
//                               the guardian has checked the step against its
//                               registry (a stop move never widens; a partial
//                               close always reduces size). The caller has
//                               already scoped the trade to its owner.

import { and, eq } from "drizzle-orm";
import { db, tradesTable } from "@workspace/db";

export type PaperTrade = typeof tradesTable.$inferSelect;
export type LegacyTradeInsert = typeof tradesTable.$inferInsert;

export type PaperManagementStep =
  | { kind: "MOVE_STOP"; newStop: number }
  | { kind: "PARTIAL_CLOSE"; newLot: number }
  | { kind: "CLOSE"; status: "CLOSED_WIN" | "CLOSED_LOSS"; pnl: number; closedAt: Date };

/** Persist one guardian-approved step; null when the trade no longer exists. */
export async function applyPaperManagement(tradeId: number, step: PaperManagementStep): Promise<PaperTrade | null> {
  const set = step.kind === "MOVE_STOP"
    ? { stopLoss: step.newStop }
    : step.kind === "PARTIAL_CLOSE"
      ? { lot: step.newLot }
      : { status: step.status, pnl: step.pnl, closedAt: step.closedAt };
  const [row] = await db.update(tradesTable).set(set).where(eq(tradesTable.id, tradeId)).returning();
  return row ?? null;
}

/** Record one /execute-trade row (the route has already run its gates and stamped the owner). */
export async function recordLegacyExecuteTrade(values: LegacyTradeInsert & { userId: number }): Promise<PaperTrade> {
  const inserted = await db.insert(tradesTable).values(values).returning();
  return inserted[0]!;
}

/**
 * Emergency stop: cancel every OPEN row the trader owns (status CANCELLED,
 * closed now, P&L 0). Returns the rows that were open, as read before the
 * cancel.
 */
export async function cancelOpenLegacyTrades(userId: number): Promise<PaperTrade[]> {
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.status, "OPEN"), eq(tradesTable.userId, userId)));
  for (const trade of openTrades) {
    await db
      .update(tradesTable)
      .set({ status: "CANCELLED", closedAt: new Date(), pnl: 0 })
      .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.userId, userId)));
  }
  return openTrades;
}
