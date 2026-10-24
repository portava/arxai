// Simulated (paper) trade book: applies a management step to a row of the
// `trades` table. There is no broker behind these rows.
//
// Only lib/positionGuardian/manage.ts calls this, after the guardian has
// checked the step against its registry (a stop move never widens; a partial
// close always reduces size). The caller has already scoped the trade to its
// owner.

import { eq } from "drizzle-orm";
import { db, tradesTable } from "@workspace/db";

export type PaperTrade = typeof tradesTable.$inferSelect;

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
