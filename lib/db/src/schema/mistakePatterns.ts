import { pgTable, serial, integer, text, real, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// (CC) Build CC — Mistake pattern memory.
// Counts recurring mistake_tags per (tag, symbol, action) cohort so
// Build AA can surface a "knownMistakeWarnings" list when the next
// decision matches a previously-costly pattern.

export const mistakePatternsTable = pgTable("mistake_patterns", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  tag: text("tag").notNull(),                                  // e.g., OVERRODE_HOLD_RECOMMENDATION
  symbol: text("symbol").notNull().default(""),                // empty = global
  action: text("action").notNull().default(""),                // BUY | SELL | HOLD | "" = any
  count: integer("count").notNull().default(0),
  lastTradeId: integer("last_trade_id"),
  // 0..100 — escalates with frequency (capped). Used to throttle AA confidence.
  severityScore: real("severity_score").notNull().default(0),
  recommendedGuardrail: text("recommended_guardrail").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // One row per (tag, symbol, action) cohort.
  byCohort:  uniqueIndex("mistake_patterns_cohort_uq").on(t.tag, t.symbol, t.action),
  byTag:     index("mistake_patterns_tag_idx").on(t.tag),
  bySymbol:  index("mistake_patterns_symbol_idx").on(t.symbol),
  byUpdated: index("mistake_patterns_updated_idx").on(t.updatedAt),
}));
export type MistakePattern = typeof mistakePatternsTable.$inferSelect;
