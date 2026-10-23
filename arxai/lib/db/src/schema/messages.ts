import { integer, pgTable, serial, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { arxAssistantConversationsTable } from "./conversations";

export const arxAssistantMessagesTable = pgTable(
  "arx_assistant_messages",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id").notNull()
      .references(() => arxAssistantConversationsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    intent: text("intent"),
    toolCalls: jsonb("tool_calls"),
    audioTranscript: text("audio_transcript"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byConv: index("arx_asst_msg_by_conv_idx").on(t.conversationId, t.createdAt),
    byUser: index("arx_asst_msg_by_user_idx").on(t.userId, t.createdAt),
  }),
);

export const insertArxAssistantMessageSchema = createInsertSchema(arxAssistantMessagesTable).omit({
  id: true,
  createdAt: true,
});

export type ArxAssistantMessage = typeof arxAssistantMessagesTable.$inferSelect;
export type InsertArxAssistantMessage = z.infer<typeof insertArxAssistantMessageSchema>;
