import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// Build I — Trade Journal & Review Center.
// `trade_journal_entries` is the rich per-trade learning record (one journal
// entry per closed trade). The legacy minimal `trade_journal` table is kept
// for back-compat with the simple quick-log UI; new flows write here.
//
// `trade_review_sessions` is the periodic (weekly/monthly/custom) review
// rollup with AI summary + action plan.

export const tradeJournalEntriesTable = pgTable("trade_journal_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  tradeId: integer("trade_id"),                    // FK → trades.id (loose, optional)
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),          // BUY | SELL
  strategyUsed: text("strategy_used"),
  setupType: text("setup_type"),                   // e.g. BOS_CONTINUATION, LIQUIDITY_SWEEP
  setupTag: text("setup_tag"),                     // Phase Playbook — canonical setup tag (breakout|pullback|reversal|liquidity_sweep|range|continuation|countertrend|news_risk|high_spread|revenge|chase|unknown)
  setupQualityScore: integer("setup_quality_score"), // Phase Playbook — 0..100 from playbookEngine.evaluatePreTradeCheck at entry; null if data insufficient
  setupQualityLabel: text("setup_quality_label"),  // Phase Playbook — "A+"|"A"|"B"|"C"|"low"|"avoid"|"insufficient"
  matchedPlaybookId: integer("matched_playbook_id"), // FK (loose) → user_playbooks.id; null when no user playbook matched
  setupQualitySource: text("setup_quality_source"),// "pre_trade_check"|"derived_from_trade"|"unavailable"
  emotionalStateBefore: text("emotional_state_before"), // CALM | FOMO | FEAR | GREED | REVENGE | DISCIPLINED | UNCERTAIN
  emotionalStateAfter: text("emotional_state_after"),
  confidenceLevel: integer("confidence_level"),    // 0..100
  mistakeTags: jsonb("mistake_tags").$type<string[]>().default([]),
  strengthTags: jsonb("strength_tags").$type<string[]>().default([]),
  screenshots: jsonb("screenshots").$type<string[]>().default([]), // URLs
  userNotes: text("user_notes"),
  aiReview: jsonb("ai_review").$type<{
    summary: string;
    discipline: string;
    execution: string;
    emotional: string;
    suggestedFocus: string[];
    generatedAtIso: string;
  } | null>(),
  lessonLearned: text("lesson_learned"),
  followUpGoal: text("follow_up_goal"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const tradeReviewSessionsTable = pgTable("trade_review_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  reviewType: text("review_type").notNull(),       // WEEKLY | MONTHLY | CUSTOM
  dateRangeStart: timestamp("date_range_start").notNull(),
  dateRangeEnd: timestamp("date_range_end").notNull(),
  totalTradesReviewed: integer("total_trades_reviewed").notNull().default(0),
  biggestStrength: text("biggest_strength"),
  biggestWeakness: text("biggest_weakness"),
  aiSummary: text("ai_summary"),
  actionPlan: jsonb("action_plan").$type<string[]>().default([]),
  metrics: jsonb("metrics").$type<{
    winRate: number;
    avgConfidence: number;
    topMistakes: Array<{ tag: string; count: number }>;
    topStrengths: Array<{ tag: string; count: number }>;
  } | null>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type TradeJournalEntry = typeof tradeJournalEntriesTable.$inferSelect;
export type TradeReviewSession = typeof tradeReviewSessionsTable.$inferSelect;
