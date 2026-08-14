// Shared resolver for user-scoped trade keys ("lp_<id>" | "att_<id>").
// USER_OWNED_MT5 → live_positions; SHARED_MASTER_MT5 → shared_trade_attribution.
// Returns null when the trade does not exist or does not belong to userId.

import { db } from "@workspace/db";
import {
  livePositionsTable, sharedTradeAttributionTable, sharedMasterAccountsTable,
} from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

export type ResolvedTrade = {
  tradeKey: string;
  routingMode: "USER_OWNED_MT5" | "SHARED_MASTER_MT5";
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number | null;
  currentPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  unrealizedPnl: number | null;
  lotSize: number;
  openedAt: Date | null;
  brokerLabelMasked: string | null;
  pnlIsEstimate: boolean;
};

export async function resolveUserTrade(userId: number, tradeKey: string): Promise<ResolvedTrade | null> {
  if (tradeKey.startsWith("lp_")) {
    const id = Number(tradeKey.slice(3));
    if (!Number.isFinite(id) || id <= 0) return null;
    const [r] = await db.select().from(livePositionsTable)
      .where(and(eq(livePositionsTable.id, id), eq(livePositionsTable.userId, userId))).limit(1);
    if (!r) return null;
    return {
      tradeKey, routingMode: "USER_OWNED_MT5",
      symbol: r.symbol, side: r.direction as "BUY" | "SELL",
      entryPrice: r.entryPrice ?? null, currentPrice: r.currentPrice ?? null,
      stopLoss: r.stopLoss ?? null, takeProfit: r.takeProfit ?? null,
      unrealizedPnl: r.unrealizedProfitLoss ?? null, lotSize: r.lotSize,
      openedAt: r.openedAt ?? r.createdAt ?? null,
      brokerLabelMasked: null, pnlIsEstimate: false,
    };
  }
  if (tradeKey.startsWith("att_")) {
    const id = Number(tradeKey.slice(4));
    if (!Number.isFinite(id) || id <= 0) return null;
    const [r] = await db.select().from(sharedTradeAttributionTable)
      .where(and(eq(sharedTradeAttributionTable.id, id), eq(sharedTradeAttributionTable.userId, userId))).limit(1);
    if (!r) return null;
    let brokerLabelMasked: string | null = null;
    const [sm] = await db.select({
      broker: sharedMasterAccountsTable.brokerName,
      masked: sharedMasterAccountsTable.accountNumberMasked,
    }).from(sharedMasterAccountsTable)
      .where(eq(sharedMasterAccountsTable.id, r.sharedMasterAccountId)).limit(1);
    if (sm) brokerLabelMasked = `${sm.broker ?? "Master"} ${sm.masked ?? ""}`.trim();
    return {
      tradeKey, routingMode: "SHARED_MASTER_MT5",
      symbol: r.symbol, side: r.side as "BUY" | "SELL",
      entryPrice: r.entryPrice ?? null, currentPrice: null,
      stopLoss: r.stopLoss ?? null, takeProfit: r.takeProfit ?? null,
      unrealizedPnl: r.pnl ?? null, lotSize: r.lotSize,
      openedAt: r.openedAt ?? r.createdAt ?? null,
      brokerLabelMasked, pnlIsEstimate: true,
    };
  }
  return null;
}
