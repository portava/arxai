import { pgTable, serial, integer, text, real, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// (Z) Build Z — Institutional Analytics & Command Center.
// Snapshots are append-only; heatmaps are recomputed and re-inserted, never mutated.
// READ-ONLY everywhere except own two tables + vault audit.

export const analyticsSnapshotsTable = pgTable("analytics_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  // Performance
  totalTrades:    integer("total_trades").notNull().default(0),
  netProfitLoss:  real("net_profit_loss").notNull().default(0),
  winRate:        real("win_rate").notNull().default(0),         // 0..1
  averageRr:      real("average_rr").notNull().default(0),
  expectancy:     real("expectancy").notNull().default(0),       // per-trade $
  profitFactor:   real("profit_factor").notNull().default(0),
  maxDrawdown:    real("max_drawdown").notNull().default(0),     // peak-to-trough $
  // Behavior averages (from trader skill profile and debriefs)
  disciplineScoreAvg: real("discipline_score_avg").notNull().default(0),
  executionScoreAvg:  real("execution_score_avg").notNull().default(0),
  emotionalScoreAvg:  real("emotional_score_avg").notNull().default(0),
  consistencyScoreAvg:real("consistency_score_avg").notNull().default(0),
  // Best/worst dimensions
  strongestStrategy:        text("strongest_strategy"),
  weakestStrategy:          text("weakest_strategy"),
  strongestMarketCondition: text("strongest_market_condition"),
  weakestMarketCondition:   text("weakest_market_condition"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCreated: index("analytics_snapshots_created_idx").on(t.createdAt),
}));
export type AnalyticsSnapshot = typeof analyticsSnapshotsTable.$inferSelect;

export const analyticsHeatmapsTable = pgTable("analytics_heatmaps", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  // SESSION_PNL | MARKET_CONDITION | ENTRY_TIMING | EMOTIONAL | DAY_OF_WEEK
  heatmapType: text("heatmap_type").notNull(),
  // Free-form jsonb — typed per heatmapType in the route layer.
  dataset: jsonb("dataset").notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byType:    index("analytics_heatmaps_type_idx").on(t.heatmapType),
  byCreated: index("analytics_heatmaps_created_idx").on(t.createdAt),
}));
export type AnalyticsHeatmap = typeof analyticsHeatmapsTable.$inferSelect;
