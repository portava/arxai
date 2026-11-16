import { pgTable, serial, integer, text, real, jsonb, timestamp, index } from "drizzle-orm/pg-core";

// (M) Multi-Timeframe Analysis Engine — persisted reports per symbol so the
// Trade Plan Builder + AI Coach can consume the latest alignment without
// recomputing. Append-only: each generate produces a new row; history is the
// time-series of reports.
export const multiTimeframeReportsTable = pgTable("multi_timeframe_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),                       // single-tenant MVP, nullable
  symbol: text("symbol").notNull(),
  lowerTimeframe:  text("lower_timeframe").notNull(),
  middleTimeframe: text("middle_timeframe").notNull(),
  higherTimeframe: text("higher_timeframe").notNull(),
  // Per-timeframe trend snapshots: { trend: "UP"|"DOWN"|"SIDEWAYS", strength: 0..100, slope: number }
  lowerTrend:  jsonb("lower_trend").notNull(),
  middleTrend: jsonb("middle_trend").notNull(),
  higherTrend: jsonb("higher_trend").notNull(),
  alignmentScore: real("alignment_score").notNull(),         // 0..100, weighted toward HTF
  alignmentLabel: text("alignment_label").notNull(),         // see ALIGNMENT_LABELS
  conflictWarning: text("conflict_warning"),                 // human-readable warning, nullable
  bestBias: text("best_bias").notNull(),                     // BUY | SELL | NEUTRAL
  aiSummary: text("ai_summary").notNull(),
  candlesPerTimeframe: integer("candles_per_timeframe").notNull().default(120),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  bySymbolCreatedAt: index("mtf_reports_symbol_created_idx").on(t.symbol, t.createdAt),
  byCreatedAt:       index("mtf_reports_created_idx").on(t.createdAt),
}));

export type MultiTimeframeReport = typeof multiTimeframeReportsTable.$inferSelect;
