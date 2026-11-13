// One bridge's own stored bars (chart stored-history display only).
//
// `broker_candles` is the bridge-scoped system of record the EA's candle push
// writes (brokerCandleStore.ts). The `market_candles` mt5_broker mirror is
// keyed symbol|timeframe|source only, so with two brokers connected it holds
// whichever bridge pushed last. A signed-in reader's stored history is read
// from their own bridge here first; the shared mirror stays the fallback and
// is labelled platform-wide.
//
// Read side only; no schema change. Closed bars only, one broker symbol only
// (series are never blended).

import { db, brokerCandlesTable, mt5ConnectionTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { normalizeBrokerTimeframe, TIMEFRAME_MS } from "./brokerCandleStore.js";
import { brokerHistoryIdentity } from "./brokerHistoryPolicy.js";
import type { Candle } from "./types.js";

export interface BridgeStoredCandles {
  candles: Candle[];
  brokerSymbol: string;
  userId: number;
  newest: string;
}

/** Newest closed bars this bridge stored for symbol|timeframe, oldest first; null when none. */
export async function readBridgeStoredCandles(
  bridgeConnectionId: number,
  symbol: string,
  timeframe: string,
  limit: number,
  nowMs: number = Date.now(),
): Promise<BridgeStoredCandles | null> {
  const tf = normalizeBrokerTimeframe(timeframe);
  if (!tf || !Number.isFinite(limit) || limit <= 0) return null;
  const [connection] = await db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, bridgeConnectionId));
  if (!connection || connection.userId == null) return null;
  const identity = brokerHistoryIdentity({ userId: connection.userId, bridgeConnectionId, accountNumber: connection.accountNumber, serverName: connection.serverName, clockBasis: "broker_server" });
  const rows = await db
    .select({
      time: brokerCandlesTable.openTimeUtc,
      open: brokerCandlesTable.open,
      high: brokerCandlesTable.high,
      low: brokerCandlesTable.low,
      close: brokerCandlesTable.close,
      volume: brokerCandlesTable.tickVolume,
      brokerSymbol: brokerCandlesTable.brokerSymbol,
      historyIdentity: brokerCandlesTable.historyIdentity,
      closeTime: brokerCandlesTable.closeTimeUtc,
      userId: brokerCandlesTable.userId,
    })
    .from(brokerCandlesTable)
    .where(and(
      eq(brokerCandlesTable.bridgeConnectionId, bridgeConnectionId),
      eq(brokerCandlesTable.userId, connection.userId),
      eq(brokerCandlesTable.historyIdentity, identity),
      eq(brokerCandlesTable.symbol, symbol.trim().toUpperCase()),
      eq(brokerCandlesTable.timeframe, tf),
      eq(brokerCandlesTable.isClosedBar, true),
    ))
    .orderBy(desc(brokerCandlesTable.openTimeUtc))
    .limit(Math.min(Math.floor(limit), 5000));
  const tfMs = TIMEFRAME_MS[tf];
  const first = rows.find((r) => r.time instanceof Date && (r.closeTime?.getTime() ?? r.time.getTime() + tfMs) <= nowMs);
  if (!first) return null;
  // One broker symbol: the one whose bar is newest.
  const picked = rows.filter((r) =>
    r.brokerSymbol === first.brokerSymbol && r.historyIdentity === first.historyIdentity && r.time instanceof Date && (r.closeTime?.getTime() ?? r.time.getTime() + tfMs) <= nowMs);
  const candles: Candle[] = picked.reverse().map((r) => ({
    time: r.time.toISOString(), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0,
  }));
  return { candles, brokerSymbol: first.brokerSymbol, userId: first.userId, newest: candles.at(-1)!.time };
}
