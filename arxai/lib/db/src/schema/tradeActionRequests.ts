import {
  pgTable, serial, integer, text, real, boolean, timestamp, jsonb,
  index,
} from "drizzle-orm/pg-core";

// Phase UX8 — Trade Action Center.
//
// SAFETY:
//   * Every row is user-scoped (user_id NOT NULL). Reads MUST filter by
//     req.authUser.id. Trade ownership is re-checked via resolveUserTrade
//     before any state transition that touches a real trade.
//   * A row is a request, not an execution. status moves forward through
//     a tight state machine; only `confirm` triggers the guard chain and
//     can lead to queueing an mt5_commands row. ARX never auto-confirms.
//   * The AI can only create rows in status="ai_suggested". Moving to
//     "confirmed" REQUIRES an authenticated POST from the owning user.
//   * Live mode REQUIRES `confirmed_by_user=true` in addition to a typed
//     UI confirmation; the guard chain re-enforces this.
//   * Secrets (mt5 tokens, bridge tokens, hashes) are NEVER written here.

// Action types the Action Center can review.
//   OPEN          — open a new position (review only; never auto-opens)
//   CLOSE         — full close of an existing position
//   PARTIAL_CLOSE — close a portion of an existing position
//   MOVE_STOP     — move SL (also covers move-to-breakeven)
//   TRAIL_STOP    — trail SL by a rule (review-only suggestion)
//   MODIFY_TP_SL  — modify TP and/or SL together
//   CANCEL_ORDER  — cancel a pending limit/stop order
//
// Status lifecycle (forward-only except cancelled/expired which are terminal):
//   ai_suggested
//     → user_reviewing
//        → awaiting_confirmation
//           → confirmed            (user pressed confirm)
//              → guard_checking
//                 → queued         (guards pass → mt5_commands row inserted)
//                    → sent_to_mt5 (EA claimed the command)
//                       → partially_filled (EA reported a partial fill —
//                             NON-terminal; remaining quantity still working.
//                             R2 S5, audit G2: previously coerced to executed,
//                             silently dropping the unfilled remainder. Written
//                             by executionReconciler.mapActionStatus; adoption
//                             in tradeAction/types.ts ACTION_STATUSES +
//                             statusMachine.ts is a follow-up outside R2 S5.)
//                          → executed / failed (full fill or explicit close)
//                       → executed (EA reported success)
//                       → failed   (EA reported failure)
//                 → rejected       (a guard failed; never queues)
//     → cancelled                  (user cancelled before confirm)
//     → expired                    (timer elapsed before confirm)
//
// Indexes: (user_id, status, created_at desc) for the Action Center list,
// (user_id, trade_key) for per-trade panels.

export const tradeActionRequestsTable = pgTable("trade_action_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  // Linkage (nullable because OPEN has no trade yet).
  tradeKey: text("trade_key"),
  tradeCommandId: integer("trade_command_id"), // FK to mt5_commands.id once queued
  aiDecisionId: integer("ai_decision_id"),     // FK to trade_decisions.id (best-effort)

  actionType: text("action_type").notNull(),

  // Mode + routing context captured at draft time. Re-validated at confirm.
  requestedMode: text("requested_mode").notNull(),         // SIMULATED | DEMO | LIVE
  accountType: text("account_type").notNull().default("unknown"),     // demo | live | unknown
  routingMode: text("routing_mode").notNull().default("UNRESOLVED"),  // USER_OWNED_MT5 | SHARED_MASTER_MT5 | INTERNAL | UNRESOLVED

  symbol: text("symbol").notNull(),
  side: text("side"),                          // BUY | SELL (nullable for CANCEL)
  lotSize: real("lot_size"),                   // float; nullable for MOVE_STOP-only changes
  requestedPrice: real("requested_price"),     // for MARKET = current market at request; for pending = entry/limit price
  stopLoss: real("stop_loss"),
  takeProfit: real("take_profit"),

  // Phase TT (Trade Ticket Slice) — pending order draft fields.
  // orderType normalises the 8 supported order kinds. Null for legacy market rows.
  //   BUY_MARKET | SELL_MARKET | BUY_LIMIT | SELL_LIMIT |
  //   BUY_STOP   | SELL_STOP   | BUY_STOP_LIMIT | SELL_STOP_LIMIT
  // stopTriggerPrice / stopLimitPrice only populated for *_STOP_LIMIT.
  // expiration is OPTIONAL pending-order expiry (UTC).
  // pendingStatus tracks the draft lifecycle BEFORE the EA can execute pending
  // orders. Today the EA only supports market execution, so pending drafts are
  // created with pendingStatus = "EA_UPGRADE_REQUIRED" and never queued to MT5.
  //   EA_UPGRADE_REQUIRED — saved as a validated draft, awaiting EA upgrade
  //   READY_TO_EXECUTE    — reserved for when EA pending-order support ships
  //   CANCELLED           — user cancelled the draft
  orderType: text("order_type"),
  stopTriggerPrice: real("stop_trigger_price"),
  stopLimitPrice: real("stop_limit_price"),
  expiration: timestamp("expiration"),
  pendingStatus: text("pending_status"),

  reason: text("reason"),                      // human-readable why
  source: text("source").notNull().default("user_initiated"), // ai_suggested | user_initiated | decision_engine

  status: text("status").notNull().default("ai_suggested"),
  confirmationRequired: boolean("confirmation_required").notNull().default(true),
  confirmedByUser: boolean("confirmed_by_user").notNull().default(false),
  confirmedAt: timestamp("confirmed_at"),

  // Guard chain output (preserved for audit + AI explanation).
  guardResult: jsonb("guard_result"),          // { passed: boolean, checks: [...] }
  rejectionReason: text("rejection_reason"),

  mt5Ticket: text("mt5_ticket"),               // legacy single-ticket field (kept for UX8 compat)

  // Phase UX9 — broker execution result fields. Populated by reconciler
  // after EA posts /api/mt5/execution-result. Never written from UI.
  mt5OrderTicket: text("mt5_order_ticket"),
  mt5PositionTicket: text("mt5_position_ticket"),
  fillPrice: real("fill_price"),
  slippage: real("slippage"),
  filledLotSize: real("filled_lot_size"),
  brokerMessage: text("broker_message"),
  errorCode: text("error_code"),
  executedAt: timestamp("executed_at"),
  staleAt: timestamp("stale_at"),              // watchdog marker

  expiresAt: timestamp("expires_at"),          // default 30 min after creation
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  userListIdx: index("trade_action_requests_user_status_idx").on(t.userId, t.status, t.createdAt),
  userTradeIdx: index("trade_action_requests_user_trade_idx").on(t.userId, t.tradeKey),
}));

export type TradeActionRequestRow = typeof tradeActionRequestsTable.$inferSelect;
export type NewTradeActionRequest = typeof tradeActionRequestsTable.$inferInsert;
