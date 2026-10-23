// Build KK — Data Import + Broker Read-Only Connector schema.
//
// SAFETY: All tables additive. NO live execution columns. broker_readonly_*
// rows always carry liveTradingAllowed=false and canPlaceLiveTrade=false.
// Imported candles are stored separately and labelled IMPORTED — never
// labelled as live data.

import { pgTable, serial, text, integer, real, jsonb, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const dataImportsTable = pgTable("data_imports", {
  id: serial("id").primaryKey(),
  importId: text("import_id").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  source: text("source").notNull(), // CSV | JSON | MANUAL | DEMO
  status: text("status").notNull(), // VALIDATED | IMPORTED | REJECTED | PARTIAL
  candlesReceived: integer("candles_received").notNull().default(0),
  candlesValid: integer("candles_valid").notNull().default(0),
  candlesRejected: integer("candles_rejected").notNull().default(0),
  startTime: timestamp("start_time", { withTimezone: true }),
  endTime: timestamp("end_time", { withTimezone: true }),
  dataQuality: jsonb("data_quality").notNull().default({}),
  warnings: jsonb("warnings").notNull().default([]),
  errors: jsonb("errors").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ importIdIdx: uniqueIndex("data_imports_import_id_idx").on(t.importId) }));

export const importedCandlesTable = pgTable("imported_candles", {
  id: serial("id").primaryKey(),
  candleId: text("candle_id").notNull(),
  importId: text("import_id").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  time: timestamp("time", { withTimezone: true }).notNull(),
  open: real("open").notNull(),
  high: real("high").notNull(),
  low: real("low").notNull(),
  close: real("close").notNull(),
  volume: real("volume"),
  source: text("source").notNull(), // mirror of dataImports.source for fast lookup; always non-live
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ candleIdIdx: uniqueIndex("imported_candles_candle_id_idx").on(t.candleId) }));

export const brokerReadonlySnapshotsTable = pgTable("broker_readonly_snapshots", {
  id: serial("id").primaryKey(),
  // Nullable only for pre-ownership legacy rows. New writes MUST provide an
  // authenticated owner; ownerless rows are never returned to user surfaces.
  userId: integer("user_id"),
  snapshotId: text("snapshot_id").notNull(),
  provider: text("provider").notNull(),
  mode: text("mode").notNull(), // always "READ_ONLY"
  connected: boolean("connected").notNull().default(false),
  accountMasked: jsonb("account_masked").notNull().default({}),
  symbols: jsonb("symbols").notNull().default([]),
  openPositions: jsonb("open_positions").notNull().default([]),
  latestQuotes: jsonb("latest_quotes").notNull().default([]),
  dataQuality: jsonb("data_quality").notNull().default({}),
  liveTradingAllowed: boolean("live_trading_allowed").notNull().default(false),
  canPlaceLiveTrade: boolean("can_place_live_trade").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  snapshotIdIdx: uniqueIndex("broker_readonly_snapshots_snapshot_id_idx").on(t.snapshotId),
  userCreatedAtIdx: index("broker_readonly_snapshots_user_created_at_idx").on(t.userId, t.createdAt),
}));

export const brokerReadonlyLogsTable = pgTable("broker_readonly_logs", {
  id: serial("id").primaryKey(),
  // See brokerReadonlySnapshotsTable.userId. Legacy ownerless rows are
  // intentionally fail-closed from all authenticated user reads.
  userId: integer("user_id"),
  connectorId: text("connector_id").notNull(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull(), // INFO | WARN | ERROR | CRITICAL
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userCreatedAtIdx: index("broker_readonly_logs_user_created_at_idx").on(t.userId, t.createdAt),
}));

export const dataImportLogsTable = pgTable("data_import_logs", {
  id: serial("id").primaryKey(),
  importId: text("import_id").notNull(),
  eventType: text("event_type").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
