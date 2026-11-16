import { desc, eq, isNull } from "drizzle-orm";
import { db } from "../index";
import { mt5ConnectionTable, type Mt5Connection, type InsertMt5Connection } from "../schema/mt5Connection";

export const mt5ConnectionRepo = {
  async getForUser(userId: number | null): Promise<Mt5Connection | undefined> {
    const where = userId === null ? isNull(mt5ConnectionTable.userId) : eq(mt5ConnectionTable.userId, userId);
    const rows = await db.select().from(mt5ConnectionTable).where(where).orderBy(desc(mt5ConnectionTable.updatedAt)).limit(1);
    return rows[0];
  },
  async upsertForUser(userId: number | null, patch: Partial<InsertMt5Connection>): Promise<Mt5Connection> {
    const existing = await this.getForUser(userId);
    if (existing) {
      const [row] = await db.update(mt5ConnectionTable)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(mt5ConnectionTable.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(mt5ConnectionTable).values({ userId, ...patch }).returning();
    return row;
  },
};
