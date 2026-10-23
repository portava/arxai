// Phase 22K — long-term per-user assistant memory.
// One row per user. Stores rolling summary + trading style + preferences +
// unresolved actions list. Strictly user-scoped (FK + cascade). No secrets,
// no other users' data, no raw audio. Capped sizes enforced at write-time
// in memoryStore.ts.

import { pgTable, serial, integer, text, timestamp, index, jsonb, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const arxAssistantMemoryTable = pgTable(
  "arx_assistant_memory",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Compact long-term narrative the assistant wrote about this user.
    // Capped to ~4000 chars in memoryStore.upsertMemory.
    rollingSummary: text("rolling_summary"),
    // Inferred trading style facts: { preferredSymbols, timeframes, riskAppetite, ... }
    tradingStyle: jsonb("trading_style"),
    // User preferences: { voiceSpeakback, defaultMode, notifications, ... }
    preferences: jsonb("preferences"),
    // Open tasks across conversations: [{type,status,userIntent,createdAt,...}]
    unresolvedActions: jsonb("unresolved_actions"),
    // User-controlled long-term memory toggle. When false, the rolling
    // summarizer stops updating and history is not injected into the
    // model context. Past messages remain queryable / exportable.
    memoryEnabled: boolean("memory_enabled").notNull().default(true),
    // Bookkeeping for the summarizer trigger.
    summarizedThroughMessageId: integer("summarized_through_message_id"),
    summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byUserUq: uniqueIndex("arx_asst_memory_by_user_uq").on(t.userId),
    byUpdated: index("arx_asst_memory_by_updated_idx").on(t.updatedAt),
  }),
);

export const insertArxAssistantMemorySchema = createInsertSchema(arxAssistantMemoryTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ArxAssistantMemory = typeof arxAssistantMemoryTable.$inferSelect;
export type InsertArxAssistantMemory = z.infer<typeof insertArxAssistantMemorySchema>;
