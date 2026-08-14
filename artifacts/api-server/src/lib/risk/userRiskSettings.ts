import { db, riskSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function getOrCreateUserRiskSettings(userId: number) {
  const rows = await db.select().from(riskSettingsTable)
    .where(eq(riskSettingsTable.userId, userId)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(riskSettingsTable).values({ userId }).returning();
  return inserted[0]!;
}
