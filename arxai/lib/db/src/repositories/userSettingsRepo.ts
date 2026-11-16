import { eq, isNull, or } from "drizzle-orm";
import { db } from "../index";
import { userSettingsTable, type UserSettings, type InsertUserSettings } from "../schema/userSettings";

// Until auth lands we treat userId === null as the "default" record.
export const userSettingsRepo = {
  async getForUser(userId: number | null): Promise<UserSettings | undefined> {
    const where = userId === null ? isNull(userSettingsTable.userId) : eq(userSettingsTable.userId, userId);
    const rows = await db.select().from(userSettingsTable).where(where).limit(1);
    return rows[0];
  },
  async upsertForUser(userId: number | null, patch: Partial<InsertUserSettings>): Promise<UserSettings> {
    const existing = await this.getForUser(userId);
    if (existing) {
      const [row] = await db.update(userSettingsTable)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(userSettingsTable.id, existing.id))
        .returning();
      return row;
    }
    const [row] = await db.insert(userSettingsTable)
      .values({ userId, ...patch })
      .returning();
    return row;
  },
};

// re-export commonly used helpers
export { eq, isNull, or };
