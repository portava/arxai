// Legacy broker rows can be used as diagnostic inputs only. Row ownership and
// one observed source tuple prevent cross-user/cross-bridge mixing; they do not
// attest historical account-era identity, which the store does not preserve.
import { db, brokerCandlesTable } from "@workspace/db";
import { and, desc, eq, gte, lte, isNull, inArray, type SQL } from "drizzle-orm";
import { listUserConnections } from "../brokerHub/connections.js";
import type { Candle } from "../strategyEngine.js";
import { timeframeMs } from "../backtestStrategyRegistry.js";

export async function loadDiagnosticBrokerHistory(args: {
  userId: number; symbol: string; timeframe: string;
  rangeStart: Date | null; rangeEnd: Date | null; maxBars: number;
}): Promise<{ candles: Candle[]; reason: "available_unattested" | "unavailable" | "ambiguous_source" | "invalid_bars" }> {
  const observedAt = Date.now();
  const conds: SQL[] = [
    eq(brokerCandlesTable.userId, args.userId),
    eq(brokerCandlesTable.symbol, args.symbol),
    eq(brokerCandlesTable.timeframe, args.timeframe),
    eq(brokerCandlesTable.isClosedBar, true),
  ];
  if (args.rangeStart) conds.push(gte(brokerCandlesTable.openTimeUtc, args.rangeStart));
  if (args.rangeEnd) conds.push(lte(brokerCandlesTable.openTimeUtc, args.rangeEnd));
  return db.transaction(async (tx) => {
    const ownedIds = (await listUserConnections(args.userId, {}, tx)).map((connection) => connection.id);
    if (!ownedIds.length) return { candles: [], reason: "unavailable" };
    const ownerConds = [...conds, inArray(brokerCandlesTable.bridgeConnectionId, ownedIds)];
    // One consistent snapshot for source selection and bars. Never select an
    // arbitrary newest bridge, or collapse two native symbols by timestamp.
    const identities = await tx.selectDistinct({
      bridgeId: brokerCandlesTable.bridgeConnectionId,
      brokerSymbol: brokerCandlesTable.brokerSymbol,
      accountNumber: brokerCandlesTable.accountNumber,
    }).from(brokerCandlesTable)
      .where(and(...ownerConds)).limit(2);
    if (identities.length !== 1) return { candles: [], reason: identities.length ? "ambiguous_source" : "unavailable" };
    const identity = identities[0]!;
    const rows = await tx.select({
      time: brokerCandlesTable.openTimeUtc, open: brokerCandlesTable.open,
      high: brokerCandlesTable.high, low: brokerCandlesTable.low,
      close: brokerCandlesTable.close, volume: brokerCandlesTable.tickVolume,
    }).from(brokerCandlesTable)
      .where(and(...ownerConds,
        eq(brokerCandlesTable.bridgeConnectionId, identity.bridgeId),
        eq(brokerCandlesTable.brokerSymbol, identity.brokerSymbol),
        identity.accountNumber == null ? isNull(brokerCandlesTable.accountNumber)
          : eq(brokerCandlesTable.accountNumber, identity.accountNumber)))
      .orderBy(desc(brokerCandlesTable.openTimeUtc)).limit(args.maxBars);
    if (rows.some((row) => !(row.time instanceof Date) || !Number.isFinite(row.time.getTime())
      || row.time.getTime() + timeframeMs(args.timeframe) > observedAt)) {
      return { candles: [], reason: "invalid_bars" };
    }
    const candles = rows.reverse().map((row) => ({ ...row, time: row.time.toISOString(), volume: row.volume ?? 0 }));
    if (candles.some((bar, index) =>
      ![bar.open, bar.high, bar.low, bar.close].every((price) => Number.isFinite(price) && price > 0)
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)
      || (index > 0 && Date.parse(bar.time) <= Date.parse(candles[index - 1]!.time)))) {
      return { candles: [], reason: "invalid_bars" };
    }
    return { candles, reason: "available_unattested" };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
