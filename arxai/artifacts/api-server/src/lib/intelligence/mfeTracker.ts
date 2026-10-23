// Phase UX2 — MFE / MAE / peak-P&L tracker.
//
// Reads the most recent snapshot for (userId, tradeKey) and extends the
// running MFE/MAE/peakPnl with the current observation. Never overwrites
// history — caller inserts a new snapshot each tick.

import { db } from "@workspace/db";
import { tradeIntelligenceSnapshotsTable } from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";

export type Running = {
  mfe: number | null;
  mae: number | null;
  peakPnl: number | null;
};

export async function getRunning(userId: number, tradeKey: string): Promise<Running> {
  const [prev] = await db.select({
    mfe: tradeIntelligenceSnapshotsTable.mfe,
    mae: tradeIntelligenceSnapshotsTable.mae,
    peakPnl: tradeIntelligenceSnapshotsTable.peakPnl,
  })
    .from(tradeIntelligenceSnapshotsTable)
    .where(and(
      eq(tradeIntelligenceSnapshotsTable.userId, userId),
      eq(tradeIntelligenceSnapshotsTable.tradeKey, tradeKey),
    ))
    .orderBy(desc(tradeIntelligenceSnapshotsTable.createdAt))
    .limit(1);
  return {
    mfe: prev?.mfe ?? null,
    mae: prev?.mae ?? null,
    peakPnl: prev?.peakPnl ?? null,
  };
}

export function nextRunning(prev: Running, opts: {
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
}): Running {
  let mfe = prev.mfe;
  let mae = prev.mae;
  let peakPnl = prev.peakPnl;
  if (opts.entryPrice != null && opts.currentPrice != null) {
    const favor = opts.side === "BUY"
      ? opts.currentPrice - opts.entryPrice
      : opts.entryPrice - opts.currentPrice;
    if (favor > 0) mfe = Math.max(mfe ?? 0, favor);
    if (favor < 0) mae = Math.min(mae ?? 0, favor);
  }
  if (opts.unrealizedPnl != null) {
    peakPnl = Math.max(peakPnl ?? Number.NEGATIVE_INFINITY, opts.unrealizedPnl);
    if (!Number.isFinite(peakPnl)) peakPnl = opts.unrealizedPnl;
  }
  return { mfe, mae, peakPnl };
}
