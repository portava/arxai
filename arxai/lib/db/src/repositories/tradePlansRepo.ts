import { desc, eq } from "drizzle-orm";
import { db } from "../index";
import { tradePlansTable, type TradePlan, type InsertTradePlan } from "../schema/tradePlans";

export const tradePlansRepo = {
  list(limit = 50): Promise<TradePlan[]> {
    return db.select().from(tradePlansTable).orderBy(desc(tradePlansTable.createdAt)).limit(limit);
  },
  async get(id: number): Promise<TradePlan | undefined> {
    const rows = await db.select().from(tradePlansTable).where(eq(tradePlansTable.id, id)).limit(1);
    return rows[0];
  },
  async create(input: InsertTradePlan): Promise<TradePlan> {
    const [row] = await db.insert(tradePlansTable).values(input).returning();
    return row;
  },
};
