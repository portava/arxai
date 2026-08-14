import { pgTable, serial, text, real, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

// MT5 command queue. Each command targets a specific user's MT5 connection.
// Phase 4A (May 2026) — added mt5_connection_id, trading_session_id,
// requested_by_user_id, claimed_at, failed_at, expires_at, result_payload,
// error_message, safety_mode. Existing columns preserved.
export const mt5CommandsTable = pgTable("mt5_commands", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),                                // owner of the command (target user)
  mt5ConnectionId: integer("mt5_connection_id"),             // target MT5 connection (Phase 4A)
  tradingSessionId: integer("trading_session_id"),           // optional session link
  requestedByUserId: integer("requested_by_user_id"),        // who created it (= userId for self-issued)
  action: text("action").notNull(),                          // OPEN, CLOSE, MODIFY, CLOSE_ALL, PING, HEARTBEAT_TEST, ACCOUNT_SNAPSHOT_REQUEST, POSITIONS_SNAPSHOT_REQUEST, PAPER_ORDER_TEST, PLACE_PENDING_ORDER, MODIFY_POSITION_PROTECTION, MODIFY_PENDING_ORDER, CANCEL_PENDING_ORDER (Phase TV — forward-wired; still gated by queueMt5CommandWithGate, which forces BLOCKED under the system paper-only lock)
  symbol: text("symbol"),
  side: text("side"),                                        // BUY, SELL
  lot: real("lot"),
  sl: real("sl"),
  tp: real("tp"),
  ticket: integer("ticket"),
  payload: jsonb("payload"),                                 // structured params (Phase 4A)
  status: text("status").notNull().default("PENDING"),       // PENDING|DELIVERED|claimed|sent|completed|failed|expired|cancelled (legacy: executed/failed/blocked_demo_mode/rejected)
  detail: text("detail"),                                    // legacy free-form
  resultPayload: jsonb("result_payload"),
  errorMessage: text("error_message"),
  // Phase UX9 — structured execution result snapshot. Mirrors fields the
  // reconciler also writes to trade_action_requests for fast UI reads
  // without joining resultPayload jsonb.
  fillPrice: real("fill_price"),
  slippage: real("slippage"),
  brokerMessage: text("broker_message"),
  errorCode: text("error_code"),
  // T033 Phase 8 — the raw MT5 trade-server return code (e.g. 10009 =
  // TRADE_RETCODE_DONE). Stored as a first-class column so the UI/admin can
  // read + categorize it without parsing resultPayload jsonb. Null when the
  // command never reached the broker (rejected pre-dispatch by a server gate).
  mt5Retcode: integer("mt5_retcode"),
  filledLotSize: real("filled_lot_size"),
  mt5OrderTicket: text("mt5_order_ticket"),
  mt5PositionTicket: text("mt5_position_ticket"),
  staleAt: timestamp("stale_at"),
  safetyMode: text("safety_mode").notNull().default("paper_only"), // paper_only|read_only|live_locked
  createdAt: timestamp("created_at").defaultNow(),
  deliveredAt: timestamp("delivered_at"),
  claimedAt: timestamp("claimed_at"),
  completedAt: timestamp("completed_at"),
  failedAt: timestamp("failed_at"),
  expiresAt: timestamp("expires_at"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
  userIdx: index("mt5_commands_user_id_idx").on(t.userId),
  connIdx: index("mt5_commands_mt5_connection_id_idx").on(t.mt5ConnectionId),
  statusIdx: index("mt5_commands_status_idx").on(t.status),
}));

export const mt5StateTable = pgTable("mt5_state", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"), // Phase-2 ownership column.
  account: text("account"),
  broker: text("broker"),
  server: text("server"),
  balance: real("balance"),
  equity: real("equity"),
  margin: real("margin"),
  freeMargin: real("free_margin"),
  marginLevel: real("margin_level"),
  currency: text("currency"),
  liveAllowed: integer("live_allowed").default(0),
  positions: jsonb("positions"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  lastSyncAt: timestamp("last_sync_at"),
}, (t) => ({
  userIdx: index("mt5_state_user_id_idx").on(t.userId),
}));

export type Mt5Command = typeof mt5CommandsTable.$inferSelect;
export type Mt5State = typeof mt5StateTable.$inferSelect;
