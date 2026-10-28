// Legacy simulated-trade book: the `trades` table. There is no broker behind
// these rows — the retired /execute-trade endpoint never placed a broker
// order. A row's `mode` column ("LIVE" / "DEMO") recorded the Safety Core
// state at the time, NOT a broker execution. See docs/TIER1_PAPER_BOOK.md.
//
// Owner decision 14 (2026-10-25): /execute-trade is retired (HTTP 410), so
// nothing inserts new rows here any more. The historical rows are kept;
// this module only manages existing ones. check-single-paper-book refuses a
// trades insert anywhere, including here.
//
// This module is the ONLY runtime writer of `trades` (check-single-paper-book):
//
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

export type PaperManagementStep =
  | { kind: "MOVE_STOP"; newStop: number }
  | { kind: "PARTIAL_CLOSE"; newLot: number }
  | {
    kind: "CLOSE"; status: "CLOSED_WIN" | "CLOSED_LOSS"; closedAt: Date;
    /** null only with pnlStatus "UNKNOWN": the P&L could not be sized. */
    pnl: number | null;
    pnlStatus?: "UNKNOWN" | null;
    dataQualityFlag?: string | null;
  };

/** Persist one guardian-approved step; null when the trade no longer exists. */
export async function applyPaperManagement(tradeId: number, step: PaperManagementStep): Promise<PaperTrade | null> {
  const set = step.kind === "MOVE_STOP"
    ? { stopLoss: step.newStop }
    : step.kind === "PARTIAL_CLOSE"
      ? { lot: step.newLot }
      : {
        status: step.status, pnl: step.pnl, closedAt: step.closedAt,
        pnlStatus: step.pnlStatus ?? null, dataQualityFlag: step.dataQualityFlag ?? null,
      };
  const [row] = await db.update(tradesTable).set(set).where(eq(tradesTable.id, tradeId)).returning();
  return row ?? null;
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
