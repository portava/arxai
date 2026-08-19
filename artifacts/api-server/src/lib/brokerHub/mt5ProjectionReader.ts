import {
  arxSymbolSpecsTable,
  brokerCandlesTable,
  db,
  mt5ConnectionTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
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
    const rows = await db.select({
      brokerSymbol: brokerCandlesTable.brokerSymbol,
      timeframe: brokerCandlesTable.timeframe,
      openTimeUtc: brokerCandlesTable.openTimeUtc,
      closeTimeUtc: brokerCandlesTable.closeTimeUtc,
      open: brokerCandlesTable.open,
      high: brokerCandlesTable.high,
      low: brokerCandlesTable.low,
      close: brokerCandlesTable.close,
      tickVolume: brokerCandlesTable.tickVolume,
      realVolume: brokerCandlesTable.realVolume,
      source: brokerCandlesTable.source,
      terminalId: brokerCandlesTable.terminalId,
      isClosedBar: brokerCandlesTable.isClosedBar,
      receivedAt: brokerCandlesTable.receivedAt,
    }).from(brokerCandlesTable).where(and(
      eq(brokerCandlesTable.userId, userId),
      eq(brokerCandlesTable.bridgeConnectionId, connectionId),
    )).orderBy(desc(brokerCandlesTable.receivedAt)).limit(1);
    return rows[0] ?? null;
  },

  async readOwnedCandles(userId, connectionId, exactBrokerSymbol, timeframe, limit) {
    const rows = await db.select({
      brokerSymbol: brokerCandlesTable.brokerSymbol,
      timeframe: brokerCandlesTable.timeframe,
      openTimeUtc: brokerCandlesTable.openTimeUtc,
      closeTimeUtc: brokerCandlesTable.closeTimeUtc,
      open: brokerCandlesTable.open,
      high: brokerCandlesTable.high,
      low: brokerCandlesTable.low,
      close: brokerCandlesTable.close,
      tickVolume: brokerCandlesTable.tickVolume,
      realVolume: brokerCandlesTable.realVolume,
      source: brokerCandlesTable.source,
      terminalId: brokerCandlesTable.terminalId,
      isClosedBar: brokerCandlesTable.isClosedBar,
      receivedAt: brokerCandlesTable.receivedAt,
    }).from(brokerCandlesTable).where(and(
      eq(brokerCandlesTable.userId, userId),
      eq(brokerCandlesTable.bridgeConnectionId, connectionId),
      eq(brokerCandlesTable.brokerSymbol, exactBrokerSymbol),
      eq(brokerCandlesTable.timeframe, timeframe),
    )).orderBy(desc(brokerCandlesTable.openTimeUtc)).limit(limit);
    return rows.reverse();
  },
};