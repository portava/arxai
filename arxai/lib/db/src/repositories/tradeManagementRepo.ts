import { desc, eq } from "drizzle-orm";
import { db } from "../index";
import { tradeManagementEventsTable, type TradeManagementEvent, type InsertTradeManagementEvent } from "../schema/tradeManagementEvents";

export const tradeManagementRepo = {
  byTrade(tradeId: number): Promise<TradeManagementEvent[]> {
    return db.select().from(tradeManagementEventsTable)
      .where(eq(tradeManagementEventsTable.tradeId, tradeId))
      .orderBy(desc(tradeManagementEventsTable.createdAt));
  },
  async append(input: InsertTradeManagementEvent): Promise<TradeManagementEvent> {
    const [row] = await db.insert(tradeManagementEventsTable).values(input).returning();
    return row;
  },
};
