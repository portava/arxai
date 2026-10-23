import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// AI learning observations — durable hints the brain should respect on future signals.
export const learningInsightsTable = pgTable("learning_insights", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  insightType: text("insight_type").notNull(), // STRENGTH | WEAKNESS | PATTERN | WARNING | OPPORTUNITY
  symbol: text("symbol"),
  marketType: text("market_type"),
  strategy: text("strategy"),
  session: text("session"),
  timeframe: text("timeframe"),
  volatilityState: text("volatility_state"),
  confidenceRange: text("confidence_range"), // e.g. "70-85"
  insightText: text("insight_text").notNull(),
  recommendation: text("recommendation"),
  strength: integer("strength").notNull().default(50), // 0-100 confidence in the insight
  sampleSize: integer("sample_size").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLearningInsightSchema = createInsertSchema(learningInsightsTable).omit({ id: true, createdAt: true });
export type InsertLearningInsight = z.infer<typeof insertLearningInsightSchema>;
export type LearningInsight = typeof learningInsightsTable.$inferSelect;
