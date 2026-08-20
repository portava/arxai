import { pgTable, serial, integer, text, timestamp, jsonb, index, uniqueIndex, doublePrecision, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Phase 28-MT5-DEMO-ARMING (May 2026) — per-user execution-mode state.
//
// Records whether a user has explicitly ARMED MT5_DEMO_EXECUTION mode.
export const mt5UserExecutionModeTable = pgTable("mt5_user_execution_mode", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  mode: text("mode").notNull().default("MT5_DEMO_READ_ONLY"),
  armedAt: timestamp("armed_at"),
  armedByUserId: integer("armed_by_user_id"),
  disarmedAt: timestamp("disarmed_at"),
  disarmedReason: text("disarmed_reason"),
  lastArmGateSnapshot: jsonb("last_arm_gate_snapshot"),
  lastSafetyGateSnapshot: jsonb("last_safety_gate_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userIdx: uniqueIndex("mt5_user_execution_mode_user_id_uq").on(t.userId),
}));

export const insertMt5UserExecutionModeSchema = createInsertSchema(mt5UserExecutionModeTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMt5UserExecutionMode = z.infer<typeof insertMt5UserExecutionModeSchema>;
export type Mt5UserExecutionMode = typeof mt5UserExecutionModeTable.$inferSelect;

// Phase 28-MT5-DEMO-ARMING (May 2026) — per-user demo command queue.
// Sub-phase 3B extends with dispatch + broker-result columns.
export const mt5DemoCommandsTable = pgTable("mt5_demo_commands", {
  id: serial("id").primaryKey(),
  commandId: text("command_id").notNull(),
  userId: integer("user_id").notNull(),
  bridgeConnectionId: integer("bridge_connection_id").notNull(),
  accountLogin: text("account_login"),
  commandType: text("command_type").notNull(),
  payload: jsonb("payload").notNull(),
  // DemoCommandStatus (lib/domain/src/safety-contracts/executionMode.ts):
  // DRAFT | USER_CONFIRMATION_REQUIRED | DEMO_APPROVED | SENT_TO_MT5_DEMO |
  // FILLED_DEMO | REJECTED | BLOCKED | FAILED.
  // R2 S5 (audit G2) — DEMO_PARTIALLY_FILLED is RESERVED as the demo path's
  // non-terminal partial-fill literal: the canonical read layer
  // (lib/domain/src/execution-state/canonicalState.ts) already maps it to
  // partially_filled; adopting it in the DemoCommandStatus writer vocabulary
  // + DEMO_COMMAND_TRANSITIONS is a follow-up outside this slice. Free-text
  // column — no migration needed when it lands.
  status: text("status").notNull().default("DRAFT"),
  reason: text("reason"),
  safetyGateSnapshot: jsonb("safety_gate_snapshot").notNull(),
  tradeId: text("trade_id"),
  orderId: text("order_id"),
  // Sub-phase 3B: fingerprint enforced unique while non-terminal so the
  // database refuses double-dispatch even under race.
  fingerprint: text("fingerprint"),
  // Sub-phase 3B: EA-reported version at the moment of dispatch.
  eaVersionAtDispatch: text("ea_version_at_dispatch"),
  // Sub-phase 3B: broker result write-back columns.
  brokerOrderId: text("broker_order_id"),
  brokerTicket: text("broker_ticket"),
  fillPrice: doublePrecision("fill_price"),
  fillVolume: doublePrecision("fill_volume"),
  brokerRawResult: jsonb("broker_raw_result"),
  // ── Centralized Master MT5 Bridge (Slice 1+2, May 2026) ────────────
  // Source attribution: which page/signal originated the command.
  sourcePage: text("source_page"),
  sourceSignalId: text("source_signal_id"),
  // True when this command was routed through the SHARED_MASTER_MT5
  // bridge rather than the user's own MT5 bridge.
  routedViaMaster: boolean("routed_via_master").notNull().default(false),
  // When routedViaMaster=true: the shared_master_accounts.id, the
  // virtual_trading_accounts.id (per-user ledger row), and the back-link
  // to the shared_trade_attribution.id row created at dispatch.
  sharedMasterAccountId: integer("shared_master_account_id"),
  virtualAccountId: integer("virtual_account_id"),
  sharedAttributionId: integer("shared_attribution_id"),
  // Lifecycle timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  confirmedAt: timestamp("confirmed_at"),
  approvedAt: timestamp("approved_at"),
  sentAt: timestamp("sent_at"),
  filledAt: timestamp("filled_at"),
  terminalAt: timestamp("terminal_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  cmdIdUq: uniqueIndex("mt5_demo_commands_command_id_uq").on(t.commandId),
  userIdx: index("mt5_demo_commands_user_id_idx").on(t.userId),
  statusIdx: index("mt5_demo_commands_status_idx").on(t.status),
  bridgeIdx: index("mt5_demo_commands_bridge_id_idx").on(t.bridgeConnectionId),
  // Composite indexes for the per-user demo-command read paths: status
  // filters (active/terminal) and the "recent demo commands" feed.
  userStatusIdx: index("mt5_demo_commands_user_status_idx").on(t.userId, t.status),
  userCreatedIdx: index("mt5_demo_commands_user_created_at_idx").on(t.userId, t.createdAt),
  // Partial unique: prevents two non-terminal rows for the same user with
  // the same fingerprint (DEMO_APPROVED or SENT_TO_MT5_DEMO). DB-level
  // belt to the application-level duplicate scan.
  activeFingerprintUq: uniqueIndex("mt5_demo_commands_active_fingerprint_uq")
    .on(t.userId, t.fingerprint)
    .where(sql`status IN ('DEMO_APPROVED','SENT_TO_MT5_DEMO') AND fingerprint IS NOT NULL`),
}));

export const insertMt5DemoCommandSchema = createInsertSchema(mt5DemoCommandsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMt5DemoCommand = z.infer<typeof insertMt5DemoCommandSchema>;
export type Mt5DemoCommand = typeof mt5DemoCommandsTable.$inferSelect;
