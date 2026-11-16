import {
  arxSymbolSpecsTable,
  db,
  mt5ConnectionTable,
} from "@workspace/db";
import { findSeries, readBars, type BrokerCandleRow } from "../data/brokerCandleRows.js";

/** The candle fields the projection exposes (unchanged from the old reads). */
const projectedCandle = (r: BrokerCandleRow) => ({
  brokerSymbol: r.brokerSymbol, timeframe: r.timeframe, openTimeUtc: r.openTimeUtc, closeTimeUtc: r.closeTimeUtc,
  open: r.open, high: r.high, low: r.low, close: r.close, tickVolume: r.tickVolume, realVolume: r.realVolume,
  source: r.source, terminalId: r.terminalId, isClosedBar: r.isClosedBar, receivedAt: r.receivedAt,
});
import { and, desc, eq } from "drizzle-orm";
import { brokerHistoryIdentity } from "../data/brokerHistoryPolicy.js";
async function ownedHistory(userId: number, connectionId: number) {
  const [connection] = await db.select().from(mt5ConnectionTable).where(and(eq(mt5ConnectionTable.id, connectionId), eq(mt5ConnectionTable.userId, userId)));
  return connection ? brokerHistoryIdentity({userId, bridgeConnectionId: connectionId, accountNumber: connection.accountNumber, serverName: connection.serverName, clockBasis: "broker_server"}) : null;
}
import type { Mt5ProjectionReader } from "./mt5ReadOnlyAdapter.js";

export const mt5ProjectionReader: Mt5ProjectionReader = {
  async readOwnedConnection(userId, connectionId) {
    const rows = await db.select({
      id: mt5ConnectionTable.id,
      userId: mt5ConnectionTable.userId,
      status: mt5ConnectionTable.status,
      lastHeartbeat: mt5ConnectionTable.lastHeartbeat,
      accountNumber: mt5ConnectionTable.accountNumber,
      brokerName: mt5ConnectionTable.brokerName,
      serverName: mt5ConnectionTable.serverName,
      accountCurrency: mt5ConnectionTable.accountCurrency,
      accountBalance: mt5ConnectionTable.accountBalance,
      accountEquity: mt5ConnectionTable.accountEquity,
      margin: mt5ConnectionTable.margin,
      freeMargin: mt5ConnectionTable.freeMargin,
      accountSyncedAt: mt5ConnectionTable.accountSyncedAt,
      leverage: mt5ConnectionTable.leverage,
      mode: mt5ConnectionTable.mode,
      accountType: mt5ConnectionTable.accountType,
      capabilitiesReportedAt: mt5ConnectionTable.capabilitiesReportedAt,
    }).from(mt5ConnectionTable).where(and(
      eq(mt5ConnectionTable.id, connectionId),
      eq(mt5ConnectionTable.userId, userId),
    )).limit(1);
    return rows[0] ?? null;
  },

  async readOwnedInstruments(userId, connectionId) {
    return db.select({
      symbol: arxSymbolSpecsTable.symbol,
      brokerSymbol: arxSymbolSpecsTable.brokerSymbol,
      displaySymbol: arxSymbolSpecsTable.displaySymbol,
      tradeAllowed: arxSymbolSpecsTable.tradeAllowed,
      digits: arxSymbolSpecsTable.digits,
      point: arxSymbolSpecsTable.point,
      minVolume: arxSymbolSpecsTable.minVolume,
      maxVolume: arxSymbolSpecsTable.maxVolume,
      volumeStep: arxSymbolSpecsTable.volumeStep,
      snapshotAt: arxSymbolSpecsTable.snapshotAt,
      lastSeenAt: arxSymbolSpecsTable.lastSeenAt,
      reportedAt: arxSymbolSpecsTable.reportedAt,
    }).from(arxSymbolSpecsTable).where(and(
      eq(arxSymbolSpecsTable.userId, userId),
      eq(arxSymbolSpecsTable.bridgeConnectionId, connectionId),
    ));
  },

  async readLatestOwnedCandle(userId, connectionId) {
    const identity = await ownedHistory(userId, connectionId);
    if (!identity) return null;
    const series = await findSeries(db, { userId, historyIdentity: identity, bridgeConnectionIds: [connectionId] });
    const rows = (await readBars(db, series, { orderBy: "receivedAt", order: "desc", limit: 1 })).map(projectedCandle);
    return rows[0] ?? null;
  },

  async readOwnedCandles(userId, connectionId, exactBrokerSymbol, timeframe, limit) {
    const identity = await ownedHistory(userId, connectionId);
    if (!identity) return [];
    const series = await findSeries(db, { userId, historyIdentity: identity, bridgeConnectionIds: [connectionId],
      brokerSymbol: exactBrokerSymbol, timeframe });
    const rows = (await readBars(db, series, { order: "desc", limit })).map(projectedCandle);
    return rows.reverse();
  },
};