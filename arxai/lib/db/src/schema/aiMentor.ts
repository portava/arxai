import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";

// (Y) Build Y — AI Mentor Mode.
// Two tables. Mentor sessions are append-only daily/contextual briefings;
// action items are mutable status (PENDING → IN_PROGRESS → DONE/SKIPPED).
// Mentor NEVER promises profit and never bypasses execution safety.

export const aiMentorSessionsTable = pgTable("ai_mentor_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  // DAILY_BRIEFING | PRE_MARKET_GUIDANCE | POST_TRADE_GUIDANCE | WEEKLY_RESET
  // | RISK_WARNING | CONFIDENCE_REBUILD | DISCIPLINE_CHECK
  sessionType: text("session_type").notNull().default("DAILY_BRIEFING"),
  skillLevel:        text("skill_level").notNull().default("Beginner"),
  mainFocus:         text("main_focus").notNull().default(""),
  mentorMessage:     text("mentor_message").notNull().default(""),
  recommendedAction: text("recommended_action").notNull().default(""),
  relatedGoalId:     integer("related_goal_id"),
  relatedTradeId:    integer("related_trade_id"),
  relatedStrategyId: integer("related_strategy_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byType:    index("mentor_sessions_type_idx").on(t.sessionType),
  byCreated: index("mentor_sessions_created_idx").on(t.createdAt),
}));
export type AiMentorSession = typeof aiMentorSessionsTable.$inferSelect;

export const mentorActionItemsTable = pgTable("mentor_action_items", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  mentorSessionId:   integer("mentor_session_id").notNull(),
  actionTitle:       text("action_title").notNull(),
  actionDescription: text("action_description").notNull().default(""),
  // PENDING | IN_PROGRESS | DONE | SKIPPED
  status: text("status").notNull().default("PENDING"),
  dueDate: timestamp("due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  bySession: index("mentor_action_items_session_idx").on(t.mentorSessionId),
  byStatus:  index("mentor_action_items_status_idx").on(t.status),
}));
export type MentorActionItem = typeof mentorActionItemsTable.$inferSelect;
