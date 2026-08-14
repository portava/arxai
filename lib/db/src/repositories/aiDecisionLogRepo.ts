import { desc, eq, and, gte } from "drizzle-orm";
import { db } from "../index";
import { aiDecisionLogTable, type AiDecisionLog, type InsertAiDecisionLog } from "../schema/aiDecisionLog";

export const aiDecisionLogRepo = {
  recent(limit = 100): Promise<AiDecisionLog[]> {
    return db.select().from(aiDecisionLogTable).orderBy(desc(aiDecisionLogTable.timestamp)).limit(limit);
  },
  bySymbol(symbol: string, limit = 50): Promise<AiDecisionLog[]> {
    return db.select().from(aiDecisionLogTable)
      .where(eq(aiDecisionLogTable.symbol, symbol))
      .orderBy(desc(aiDecisionLogTable.timestamp))
      .limit(limit);
  },
  byTrade(tradeId: number): Promise<AiDecisionLog[]> {
    return db.select().from(aiDecisionLogTable)
      .where(eq(aiDecisionLogTable.tradeId, tradeId))
      .orderBy(desc(aiDecisionLogTable.timestamp));
  },
  since(date: Date, limit = 200): Promise<AiDecisionLog[]> {
    return db.select().from(aiDecisionLogTable)
      .where(gte(aiDecisionLogTable.timestamp, date))
      .orderBy(desc(aiDecisionLogTable.timestamp))
      .limit(limit);
  },
  byEventType(eventType: string, limit = 100): Promise<AiDecisionLog[]> {
    return db.select().from(aiDecisionLogTable)
      .where(eq(aiDecisionLogTable.eventType, eventType))
      .orderBy(desc(aiDecisionLogTable.timestamp))
      .limit(limit);
  },
  bySymbolAndType(symbol: string, eventType: string, limit = 50): Promise<AiDecisionLog[]> {
    return db.select().from(aiDecisionLogTable)
      .where(and(eq(aiDecisionLogTable.symbol, symbol), eq(aiDecisionLogTable.eventType, eventType)))
      .orderBy(desc(aiDecisionLogTable.timestamp))
      .limit(limit);
  },
  async append(input: InsertAiDecisionLog): Promise<AiDecisionLog> {
    const [row] = await db.insert(aiDecisionLogTable).values(input).returning();
    return row;
  },
};
