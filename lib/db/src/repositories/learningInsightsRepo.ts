import { desc, eq, and } from "drizzle-orm";
import { db } from "../index";
import { learningInsightsTable, type LearningInsight, type InsertLearningInsight } from "../schema/learningInsights";

export const learningInsightsRepo = {
  recent(limit = 50): Promise<LearningInsight[]> {
    return db.select().from(learningInsightsTable).orderBy(desc(learningInsightsTable.createdAt)).limit(limit);
  },
  forSymbol(symbol: string): Promise<LearningInsight[]> {
    return db.select().from(learningInsightsTable)
      .where(eq(learningInsightsTable.symbol, symbol))
      .orderBy(desc(learningInsightsTable.createdAt));
  },
  forSymbolAndStrategy(symbol: string, strategy: string): Promise<LearningInsight[]> {
    return db.select().from(learningInsightsTable)
      .where(and(eq(learningInsightsTable.symbol, symbol), eq(learningInsightsTable.strategy, strategy)))
      .orderBy(desc(learningInsightsTable.createdAt));
  },
  async append(input: InsertLearningInsight): Promise<LearningInsight> {
    const [row] = await db.insert(learningInsightsTable).values(input).returning();
    return row;
  },
};
