import { pgTable, serial, text, real, boolean, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Build F — Live Execution Safety Layer.
// One row per pre-trade confirmation attempt. Created when the user opens
// the Pre-Trade Checklist, transitioned through CONFIRMED / CANCELLED /
// EXECUTED / REJECTED, and audited via vault_events on every change.
//
// Inviolable: this table records *intent + decision*. Actual order placement
// remains gated by safetyCore.tradeGate in routes/trades.ts. While
// canPlaceTrades:false (MVP freeze), no row will ever transition to LIVE
// execution; PAPER / SIMULATED only.

export const EXECUTION_CONFIRMATION_STATUSES = [
  "PENDING",       // created, awaiting user confirmation
  "CONFIRMED",     // user clicked Confirm — eligible for execute-trade
  "CANCELLED",     // user clicked Cancel — terminal
  "EXECUTED",      // execute-trade ran (PAPER, SIMULATED, or LIVE) — terminal
  "REJECTED",      // safetyCore HARD_BLOCKed at execute time — terminal
  "EXPIRED",       // confirmation token aged out before execute — terminal
] as const;
export type ExecutionConfirmationStatus = (typeof EXECUTION_CONFIRMATION_STATUSES)[number];

export const ENTRY_TYPES = ["MARKET", "LIMIT", "STOP"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const executionConfirmationsTable = pgTable("execution_confirmations", {
  id: serial("id").primaryKey(),

  // user_id is nullable for the singleton-user MVP; reserved for future multi-user.
  userId: text("user_id"),

  // Order intent
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),           // BUY | SELL
  lotSize: real("lot_size").notNull(),
  entryType: text("entry_type").notNull().default("MARKET"),
  entryPrice: real("entry_price").notNull(),
  stopLoss: real("stop_loss").notNull(),
  takeProfit: real("take_profit").notNull(),

  // Computed risk profile
  estimatedRisk: real("estimated_risk").notNull(),       // dollars at risk
  rewardToRisk: real("reward_to_risk").notNull(),        // tp_distance / sl_distance

  // Snapshot of contextual gates at create-time (frozen for audit)
  marketCondition: text("market_condition").notNull(),   // TRENDING | RANGING | NO_TRADE | UNKNOWN
  permissionStatus: text("permission_status").notNull(), // CLEAR | CAUTION | LOCKED | LIVE_TRADING_DISABLED
  brokerConnected: boolean("broker_connected").notNull().default(false),
  practiceMode: boolean("practice_mode").notNull().default(true),

  // AI signals
  aiConfidence: real("ai_confidence"),
  fitScore: real("fit_score"),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  blockers: jsonb("blockers").$type<string[]>().notNull().default([]),

  // Lifecycle
  status: text("status").notNull().default("PENDING"),
  userConfirmed: boolean("user_confirmed").notNull().default(false),
  executed: boolean("executed").notNull().default(false),
  executionResult: text("execution_result"),             // free-form summary
  executedTradeId: integer("executed_trade_id"),         // FK soft-link → trades.id

  confirmedAt: timestamp("confirmed_at"),
  cancelledAt: timestamp("cancelled_at"),
  executedAt: timestamp("executed_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  byStatus:    index("exec_conf_status_idx").on(t.status),
  bySymbol:    index("exec_conf_symbol_idx").on(t.symbol),
  byCreated:   index("exec_conf_created_idx").on(t.createdAt),
  byExpires:   index("exec_conf_expires_idx").on(t.expiresAt),
}));

export const insertExecutionConfirmationSchema = createInsertSchema(executionConfirmationsTable).omit({ id: true });
export type InsertExecutionConfirmation = z.infer<typeof insertExecutionConfirmationSchema>;
export type ExecutionConfirmationRow = typeof executionConfirmationsTable.$inferSelect;
