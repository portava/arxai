import { pgTable, serial, integer, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const arxAssistantConversationsTable = pgTable(
  "arx_assistant_conversations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    voiceMode: text("voice_mode").notNull().default("off"),
    lastIntent: text("last_intent"),
    // Phase 22K — current unresolved promise/action for this conversation.
    // Shape: { type, status, userIntent, createdAt, updatedAt, lastAssistantPromise, requiredData?, blockingIssue?, toolResult?, failureReason? }
    pendingAction: jsonb("pending_action"),
    // Phase 22K — soft-archive flag (set by Clear current chat).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byUser: index("arx_asst_conv_by_user_idx").on(t.userId, t.updatedAt),
  }),
);

export const insertArxAssistantConversationSchema = createInsertSchema(arxAssistantConversationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ArxAssistantConversation = typeof arxAssistantConversationsTable.$inferSelect;
export type InsertArxAssistantConversation = z.infer<typeof insertArxAssistantConversationSchema>;

export const arxAssistantToolCallsTable = pgTable(
  "arx_assistant_tool_calls",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id").notNull()
      .references(() => arxAssistantConversationsTable.id, { onDelete: "cascade" }),
    messageId: integer("message_id"),
    toolName: text("tool_name").notNull(),
    args: jsonb("args"),
    result: jsonb("result"),
    status: text("status").notNull().default("ok"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byConv: index("arx_asst_tool_by_conv_idx").on(t.conversationId, t.createdAt),
    byUser: index("arx_asst_tool_by_user_idx").on(t.userId, t.createdAt),
  }),
);

export const insertArxAssistantToolCallSchema = createInsertSchema(arxAssistantToolCallsTable).omit({
  id: true,
  createdAt: true,
});

export type ArxAssistantToolCall = typeof arxAssistantToolCallsTable.$inferSelect;
export type InsertArxAssistantToolCall = z.infer<typeof insertArxAssistantToolCallSchema>;
