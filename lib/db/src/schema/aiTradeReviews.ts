// Phase 6A — Per-user AI trade reviews. Additive table. Reviews are
// deterministic (rule-based scoring) and can never trigger live execution.
import { pgTable, serial, integer, text, real, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const aiTradeReviewsTable = pgTable("ai_trade_reviews", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  paperTradeId: integer("paper_trade_id").notNull(),
  tradingSessionId: integer("trading_session_id"),
  reviewStatus: text("review_status").notNull().default("pending"), // pending|completed|failed
  setupGrade: text("setup_grade"),
  entryGrade: text("entry_grade"),
  exitGrade: text("exit_grade"),
  riskGrade: text("risk_grade"),
  disciplineGrade: text("discipline_grade"),
  overallGrade: text("overall_grade"),
  overallScore: real("overall_score"),                 // 0..100
  aiConfidence: real("ai_confidence"),                 // 0..100
  strengths: jsonb("strengths").$type<string[]>().default([]),
  weaknesses: jsonb("weaknesses").$type<string[]>().default([]),
  mistakeTags: jsonb("mistake_tags").$type<string[]>().default([]),
  riskNotes: text("risk_notes"),
  entryNotes: text("entry_notes"),
  exitNotes: text("exit_notes"),
  disciplineNotes: text("discipline_notes"),
  improvementPlan: jsonb("improvement_plan").$type<string[]>().default([]),
  nextTradeFocus: text("next_trade_focus"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: index("ai_trade_reviews_user_id_idx").on(t.userId),
  tradeIdx: index("ai_trade_reviews_trade_idx").on(t.paperTradeId),
  uniqPerTrade: uniqueIndex("ai_trade_reviews_unique_per_trade").on(t.userId, t.paperTradeId),
}));

export type AiTradeReview = typeof aiTradeReviewsTable.$inferSelect;
export type InsertAiTradeReview = typeof aiTradeReviewsTable.$inferInsert;
