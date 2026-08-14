// Server-side resolver for the per-user AI assistant display name.
// Reads the caller's user_settings.assistant_display_name and falls back to the
// app default (Eleanor) via the shared pure helper. Personalization only —
// never affects AI logic, safety, or execution. Never throws.

import { eq, and, isNotNull } from "drizzle-orm";
import { db, userSettingsTable } from "@workspace/db";
import { resolveAssistantName } from "@workspace/domain/assistant-name";

export async function getAssistantDisplayName(userId: number): Promise<string> {
  try {
    const rows = await db
      .select({ name: userSettingsTable.assistantDisplayName })
      .from(userSettingsTable)
      .where(and(eq(userSettingsTable.userId, userId), isNotNull(userSettingsTable.userId)))
      .orderBy(userSettingsTable.id)
      .limit(1);
    return resolveAssistantName(rows[0]?.name ?? null);
  } catch {
    return resolveAssistantName(null);
  }
}
