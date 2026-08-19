import { desc, eq } from "drizzle-orm";
import { db } from "../index";
import { entrySniperResultsTable, type EntrySniperResult, type InsertEntrySniperResult } from "../schema/entrySniperResults";

export const entrySniperRepo = {
  recent(limit = 50): Promise<EntrySniperResult[]> {
    return db.select().from(entrySniperResultsTable).orderBy(desc(entrySniperResultsTable.createdAt)).limit(limit);
  },
  bySymbol(symbol: string): Promise<EntrySniperResult[]> {
    return db.select().from(entrySniperResultsTable)
      .where(eq(entrySniperResultsTable.symbol, symbol))
      .orderBy(desc(entrySniperResultsTable.createdAt));
  },
  async append(input: InsertEntrySniperResult): Promise<EntrySniperResult> {
    const [row] = await db.insert(entrySniperResultsTable).values(input).returning();
    return row;
  },
};
