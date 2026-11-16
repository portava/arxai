// Imported Trades — MT5 trade history import schema.
//
// SAFETY:
//   - This table is READ-ONLY intelligence data. It NEVER triggers trade
//     execution, never modifies canPlaceTrades, never touches the MT5
//     bridge command pipeline.
//   - Imported rows are always labelled with source and trust level.
//   - Live vs demo is preserved from the source data where detectable.
//   - No broker credentials stored here — only masked account identifiers.
//
// Sources supported:
//   MT5_CSV        — standard MT5 "Deals" or "Orders" CSV export
//   MT5_HTML       — MT5 HTML account statement report
//   MT5_EXCEL      — MT5 Excel export or manually formatted XLSX
//   DERIV_API      — synced directly from Deriv profit table
//   BROKER_API     — synced via broker read-only connector
//   MANUAL         — user-entered trades
//
// Trust levels:
//   HIGH    — verified broker API / Deriv API / direct MT5 bridge sync
//   MEDIUM  — CSV or Excel upload (self-reported, hard to fake but unverified)
//   LOW     — HTML or manual entry (more error-prone)

import {
  pgTable, serial, integer, text, real, boolean,
  timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── 1. Import batch ─────────────────────────────────────────────────────────
// One row per import session (one file upload or one sync run).
export const tradeHistoryImportsTable = pgTable("trade_history_imports", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => usersTable.id),
  importId:     text("import_id").notNull(),        // uuid, client-facing
  source:       text("source").notNull(),            // MT5_CSV|MT5_HTML|MT5_EXCEL|DERIV_API|BROKER_API|MANUAL
  trustLevel:   text("trust_level").notNull(),       // HIGH|MEDIUM|LOW
  accountLabel: text("account_label"),               // masked broker/account hint e.g. "MT5-****1234"
  brokerHint:   text("broker_hint"),                 // e.g. "ICMarkets", "Deriv"
  isLive:       boolean("is_live"),                  // true=live account, false=demo, null=unknown
  fileName:     text("file_name"),
  status:       text("status").notNull().default("PENDING"), // PENDING|PARSING|COMPLETE|FAILED|PARTIAL
  tradesFound:  integer("trades_found").notNull().default(0),
  tradesImported: integer("trades_imported").notNull().default(0),
  tradesRejected: integer("trades_rejected").notNull().default(0),
  dataQuality:  jsonb("data_quality").notNull().default({}), // DataQualityScore object
  warnings:     jsonb("warnings").notNull().default([]),
  errors:       jsonb("errors").notNull().default([]),
  dateRangeFrom: timestamp("date_range_from", { withTimezone: true }),
  dateRangeTo:   timestamp("date_range_to", { withTimezone: true }),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  importIdIdx: uniqueIndex("thi_import_id_idx").on(t.importId),
  userIdx:     index("thi_user_idx").on(t.userId),
}));

export type TradeHistoryImportRow = typeof tradeHistoryImportsTable.$inferSelect;

// ── 2. Individual imported trades ───────────────────────────────────────────
export const importedTradesTable = pgTable("imported_trades", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => usersTable.id),
  importId:     text("import_id").notNull(),         // FK → trade_history_imports.import_id
  trustLevel:   text("trust_level").notNull(),        // HIGH|MEDIUM|LOW (inherited from import)

  // ── Identity ──────────────────────────────────────────────────────────────
  brokerDealId:    text("broker_deal_id"),            // MT5 Deal ID or order ticket
  brokerOrderId:   text("broker_order_id"),
  magicNumber:     text("magic_number"),              // EA magic number if present
  comment:         text("comment"),                   // MT5 comment field

  // ── Instrument ────────────────────────────────────────────────────────────
  symbol:       text("symbol").notNull(),
  assetClass:   text("asset_class"),                 // forex|crypto|synthetic|indices|commodities|stocks

  // ── Direction & Size ──────────────────────────────────────────────────────
  side:         text("side").notNull(),              // BUY|SELL
  orderType:    text("order_type"),                  // market|limit|stop|stop_limit
  lotSize:      real("lot_size").notNull(),

  // ── Prices ────────────────────────────────────────────────────────────────
  entryPrice:   real("entry_price"),
  exitPrice:    real("exit_price"),
  stopLoss:     real("stop_loss"),
  takeProfit:   real("take_profit"),
  openingPrice: real("opening_price"),               // for pending orders

  // ── Times ─────────────────────────────────────────────────────────────────
  openedAt:     timestamp("opened_at", { withTimezone: true }),
  closedAt:     timestamp("closed_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),

  // ── P&L ───────────────────────────────────────────────────────────────────
  grossPnl:     real("gross_pnl"),                   // before fees
  commission:   real("commission"),
  swap:         real("swap"),
  netPnl:       real("net_pnl"),                     // gross - commission - swap
  balanceAfter: real("balance_after"),               // account balance after this trade
  equityAfter:  real("equity_after"),

  // ── Close type (detected where possible) ─────────────────────────────────
  closeType:    text("close_type"),                  // tp_hit|sl_hit|manual|partial|timeout|unknown

  // ── Account context ───────────────────────────────────────────────────────
  isLive:       boolean("is_live"),                  // true=live, false=demo, null=unknown
  accountLabel: text("account_label"),               // masked account ref

  // ── Data quality flags ────────────────────────────────────────────────────
  isFlagged:    boolean("is_flagged").notNull().default(false),
  flagReasons:  jsonb("flag_reasons").notNull().default([]), // string[]

  // ── Intelligence enrichment (filled async after import) ──────────────────
  setupTag:     text("setup_tag"),                   // breakout|pullback|reversal|...
  sessionLabel: text("session_label"),               // asian|london|newyork|overlap
  rMultiple:    real("r_multiple"),                  // actual R achieved
  wasPlanned:   boolean("was_planned"),              // linked to a trade plan?

  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx:      index("it_user_idx").on(t.userId),
  importIdx:    index("it_import_idx").on(t.importId),
  symbolIdx:    index("it_symbol_idx").on(t.symbol),
  openedAtIdx:  index("it_opened_at_idx").on(t.openedAt),
  // Dedup: same user + broker deal ID should be unique per import source
  dealUdx:      uniqueIndex("it_user_deal_idx").on(t.userId, t.brokerDealId, t.importId),
}));

export type ImportedTradeRow = typeof importedTradesTable.$inferSelect;

// ── 3. Data quality score shape (stored as JSONB) ──────────────────────────
export interface TradeImportDataQuality {
  status: "GOOD" | "ACCEPTABLE" | "DEGRADED" | "POOR";
  score: number;                // 0-100
  totalRows: number;
  validRows: number;
  duplicates: number;
  missingSL: number;
  missingTP: number;
  missingTimestamps: number;
  missingExitPrice: number;
  suspiciousResults: number;    // unrealistic P/L
  brokerTimezoneIssue: boolean;
  tooFewTrades: boolean;        // < 10 trades
  demoOnly: boolean;
  warnings: string[];
  errors: string[];
}
