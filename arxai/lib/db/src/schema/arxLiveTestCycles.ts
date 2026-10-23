// Live Test Cycle — OWNER-only single-shot live verification.
//
// SAFETY (inviolable):
// - This table is ADDITIVE. It does not bypass arx_live_commands; it
//   references the real commandId values written by the standard
//   dispatch pipeline. Every state transition in this table is driven by
//   the underlying arx_live_commands + arx_live_positions truth.
// - One open cycle per user — enforced by partial unique index on
//   (user_id) where status is non-terminal.
// - Auto-close: when the OPEN command fills, the cycle service queues a
//   CLOSE command through the SAME createLiveOpsDraft → confirm →
//   dispatch path. If the close dispatch is blocked, the cycle locks in
//   CLOSE_FAILED_MANUAL_REQUIRED — no retries.

import {
  pgTable, serial, integer, text, timestamp, jsonb, doublePrecision,
  index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const ARX_LIVE_TEST_CYCLE_STATUSES = [
  "PENDING_PRECHECK",
  "DRY_RUN_BLOCKED",
  "OPEN_DISPATCHED",
  "OPEN_REJECTED",
  "OPEN_FILLED",
  "CLOSE_DISPATCHED",
  "CLOSE_FAILED_MANUAL_REQUIRED",
  "COMPLETED",
] as const;
export type ArxLiveTestCycleStatus = (typeof ARX_LIVE_TEST_CYCLE_STATUSES)[number];

export const ARX_LIVE_TEST_CYCLE_TERMINAL: ReadonlyArray<ArxLiveTestCycleStatus> = [
  "DRY_RUN_BLOCKED",
  "OPEN_REJECTED",
  "CLOSE_FAILED_MANUAL_REQUIRED",
  "COMPLETED",
];

export const arxLiveTestCyclesTable = pgTable("arx_live_test_cycles", {
  id: serial("id").primaryKey(),
  cycleId: text("cycle_id").notNull(),
  userId: integer("user_id").notNull(),

  status: text("status").notNull().default("PENDING_PRECHECK"),

  // Pinned inputs (server enforces these — EURUSD 0.01 market).
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),                   // BUY | SELL
  requestedVolume: doublePrecision("requested_volume").notNull(),
  stopLoss: doublePrecision("stop_loss").notNull(),
  takeProfit: doublePrecision("take_profit"),

  // OPEN leg — references arx_live_commands.commandId
  openCommandId: text("open_command_id"),
  openBrokerTicket: text("open_broker_ticket"),
  openFillPrice: doublePrecision("open_fill_price"),
  openMt5Retcode: integer("open_mt5_retcode"),
  openRejectionReason: text("open_rejection_reason"),

  // CLOSE leg
  closeCommandId: text("close_command_id"),
  closeFillPrice: doublePrecision("close_fill_price"),
  closeMt5Retcode: integer("close_mt5_retcode"),
  closeRejectionReason: text("close_rejection_reason"),

  realizedPlUsd: doublePrecision("realized_pl_usd"),
  // P/L data-quality flags. `pnlStatus` is one of:
  //   - "PENDING"  — cycle has not yet completed close leg
  //   - "COMPUTED" — close fill price was valid (finite, > 0) and P/L was computed
  //   - "UNKNOWN"  — close fill price was missing/invalid; P/L cannot be trusted
  // `dataQualityFlag` carries a machine-readable tag (e.g. MISSING_CLOSE_FILL_PRICE)
  // when the close-result payload was malformed. ANY downstream ledger /
  // aggregate / learning input MUST skip rows with pnlStatus !== "COMPUTED".
  pnlStatus: text("pnl_status").notNull().default("PENDING"),
  dataQualityFlag: text("data_quality_flag"),
  // EA version reported by the bridge that closed the cycle, captured at
  // completion. Used by the UI to nudge an upgrade when the close fill
  // price was missing because a pre-v1.28 EA cannot report it. Null for
  // legacy rows and cycles that never completed a close leg.
  reportedEaVersion: text("reported_ea_version"),

  // 10 latency stages (UTC timestamps).
  preflightStartedAt: timestamp("preflight_started_at", { withTimezone: true }),
  openQueuedAt: timestamp("open_queued_at", { withTimezone: true }),
  eaPickedOpenAt: timestamp("ea_picked_open_at", { withTimezone: true }),
  brokerOpenAt: timestamp("broker_open_at", { withTimezone: true }),
  positionDetectedAt: timestamp("position_detected_at", { withTimezone: true }),
  closeQueuedAt: timestamp("close_queued_at", { withTimezone: true }),
  eaPickedCloseAt: timestamp("ea_picked_close_at", { withTimezone: true }),
  brokerCloseAt: timestamp("broker_close_at", { withTimezone: true }),
  positionRemovedAt: timestamp("position_removed_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),

  blockGate: text("block_gate"),
  blockReason: text("block_reason"),
  manualResolveNote: text("manual_resolve_note"),
  manualResolvedAt: timestamp("manual_resolved_at", { withTimezone: true }),

  dispatchGateSnapshot: jsonb("dispatch_gate_snapshot").notNull().default({}),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cycleUq: uniqueIndex("arx_live_test_cycles_cycle_id_uq").on(t.cycleId),
  userIdx: index("arx_live_test_cycles_user_idx").on(t.userId),
  // Single-flight: one non-terminal cycle per user.
  singleFlightUq: uniqueIndex("arx_live_test_cycles_single_flight_uq")
    .on(t.userId)
    .where(sql`status in ('PENDING_PRECHECK','OPEN_DISPATCHED','OPEN_FILLED','CLOSE_DISPATCHED')`),
}));

export type ArxLiveTestCycle = typeof arxLiveTestCyclesTable.$inferSelect;
export type NewArxLiveTestCycle = typeof arxLiveTestCyclesTable.$inferInsert;
