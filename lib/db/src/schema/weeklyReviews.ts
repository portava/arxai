import { pgTable, serial, integer, text, real, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Build J — Weekly Performance Review & AI Improvement Plan.
// Distinct from Build I's `trade_review_sessions`: this is the *full*
// performance review (P/L, win rate, R:R, score trends, best/worst trade,
// best/worst strategy, best/worst session) plus 1–3 actionable goals.
//
// Idempotency: unique on (user_id, week_start). The POST generate route
// upserts so re-running for the same week refreshes — never duplicates.

export const weeklyPerformanceReviewsTable = pgTable("weekly_performance_reviews", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  weekStart: timestamp("week_start").notNull(),
  weekEnd: timestamp("week_end").notNull(),
  totalTrades: integer("total_trades").notNull().default(0),
  winningTrades: integer("winning_trades").notNull().default(0),
  losingTrades: integer("losing_trades").notNull().default(0),
  netProfitLoss: real("net_profit_loss").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  averageRr: real("average_rr").notNull().default(0),
  bestTradeId: integer("best_trade_id"),
  worstTradeId: integer("worst_trade_id"),
  bestStrategy: text("best_strategy"),
  worstStrategy: text("worst_strategy"),
  bestSession: text("best_session"),                // ASIA | LONDON | NY
  worstSession: text("worst_session"),
  strongestScoreArea: text("strongest_score_area"), // discipline | execution | emotionalControl | consistency
  weakestScoreArea: text("weakest_score_area"),
  biggestMistakePattern: text("biggest_mistake_pattern"),
  biggestStrengthPattern: text("biggest_strength_pattern"),
  scoreTrends: jsonb("score_trends").$type<{
    discipline: number; execution: number; emotionalControl: number; consistency: number;
  } | null>(),
  aiSummary: text("ai_summary"),
  nextWeekFocus: text("next_week_focus"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // Composite unique for the multi-user future. PostgreSQL treats NULLs as
  // distinct, so this index does NOT enforce uniqueness when user_id IS NULL —
  // hence the partial index below for the current single-tenant install.
  weekStartUserUq: uniqueIndex("weekly_perf_reviews_user_week_uq").on(t.userId, t.weekStart),
  // Single-tenant guarantee: at most one weekly review per week_start when
  // user_id is NULL. Drives the ON CONFLICT upsert in the generate route.
  weekStartSingleTenantUq: uniqueIndex("weekly_perf_reviews_week_singletenant_uq")
    .on(t.weekStart)
    .where(sql`${t.userId} IS NULL`),
}));

export const weeklyImprovementGoalsTable = pgTable("weekly_improvement_goals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  weeklyReviewId: integer("weekly_review_id").notNull(),
  goalTitle: text("goal_title").notNull(),
  goalDescription: text("goal_description"),
  targetMetric: text("target_metric"),              // e.g. "WIN_RATE", "TRADES_PER_DAY", "MISTAKE_TAG_COUNT"
  startingValue: real("starting_value"),
  targetValue: real("target_value"),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | COMPLETED | MISSED | DROPPED
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type WeeklyPerformanceReview = typeof weeklyPerformanceReviewsTable.$inferSelect;
export type WeeklyImprovementGoal = typeof weeklyImprovementGoalsTable.$inferSelect;
