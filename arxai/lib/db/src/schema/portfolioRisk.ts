import { pgTable, serial, integer, text, real, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// (O) Build O — Portfolio & Exposure Risk Engine.
// Snapshots are computed on demand from live_positions + mt5_connection +
// risk_settings, persisted as an append-only history (per-user nullable for
// MVP single-tenant). Correlation reports group exposures by currency / asset
// family and persist a per-group risk read.

export const portfolioRiskSnapshotsTable = pgTable("portfolio_risk_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  accountBalance: real("account_balance").notNull().default(0),
  accountEquity: real("account_equity").notNull().default(0),
  openPositionsCount: integer("open_positions_count").notNull().default(0),
  totalOpenLotSize: real("total_open_lot_size").notNull().default(0),
  totalUnrealizedPnl: real("total_unrealized_profit_loss").notNull().default(0),
  totalRiskAmount: real("total_risk_amount").notNull().default(0),
  totalRiskPercent: real("total_risk_percent").notNull().default(0),
  correlatedExposureScore: real("correlated_exposure_score").notNull().default(0),
  // (O) Spec risk levels: LOW, MODERATE, HIGH, CRITICAL.
  portfolioRiskLevel: text("portfolio_risk_level").notNull(),
  reasons: text("reasons").array().notNull().default([] as string[]),
  warnings: text("warnings").array().notNull().default([] as string[]),
  blockers: text("blockers").array().notNull().default([] as string[]),
  inputsSnapshot: jsonb("inputs_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCreated: index("portfolio_risk_created_idx").on(t.createdAt),
  byLevel:   index("portfolio_risk_level_idx").on(t.portfolioRiskLevel),
}));

export type PortfolioRiskSnapshot = typeof portfolioRiskSnapshotsTable.$inferSelect;

export const correlationRiskReportsTable = pgTable("correlation_risk_reports", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  // (O-fix) batch_id groups all rows produced by a single generate call so
  // /correlation-risk/latest can return exactly one consistent batch.
  batchId: text("batch_id").notNull(),
  symbolGroup: text("symbol_group").notNull(),                   // e.g. "USD", "EQUITY_INDEX_US"
  positionsInGroup: integer("positions_in_group").notNull(),
  symbols: text("symbols").array().notNull().default([] as string[]),
  totalExposure: real("total_exposure").notNull(),               // sum of lot sizes
  directionBias: text("direction_bias").notNull(),               // BUY | SELL | MIXED
  correlationWarning: text("correlation_warning"),
  // (O) Spec risk levels.
  riskLevel: text("risk_level").notNull(),
  aiSummary: text("ai_summary").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byCreated: index("corr_risk_created_idx").on(t.createdAt),
  byGroup:   index("corr_risk_group_idx").on(t.symbolGroup),
  byBatch:   index("corr_risk_batch_idx").on(t.batchId),
}));

export type CorrelationRiskReport = typeof correlationRiskReportsTable.$inferSelect;
