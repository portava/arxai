// Ruby AI-Assisted execution — command ledger + watch/monitor lifecycle.
//
// Task #319 — Ruby is upgraded from a read-only assistant into a
// PERMISSION-BOUNDED AI-Assisted LIVE executor. These tables are the
// persistence + idempotency + admin-visibility backbone for that capability.
//
// HARD INVARIANTS enforced here and by the routes that write these rows:
//
//   - There is NO second execution path. Every Ruby trade action still
//     flows through the existing instant-trade router → live command
//     pipeline → 16-gate Phase B dispatch. These rows are a LEDGER and an
//     IDEMPOTENCY guard layered ON TOP of that path — never a bypass of it.
//   - `ruby_commands` is append-mostly: a row is INSERTed PENDING, then its
//     status/result columns are updated in place as the single live command
//     resolves. Rows are evidence and are never auto-deleted.
//   - Accidental repeats are refused: a partial unique index on
//     (user_id, fingerprint) WHILE a matching command is still in flight
//     (PENDING/EXECUTING) makes a duplicate INSERT fail, so the route can
//     answer "A matching Ruby command is already pending." instead of
//     dispatching twice.
//   - `ruby_watch_instructions` rows fire EXACTLY ONCE: the ACTIVE→FIRED
//     transition is a compare-and-set (UPDATE … WHERE status='ACTIVE') and
//     only the winning update is allowed to dispatch.
import {
  pgTable, serial, integer, boolean, text, timestamp, doublePrecision,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// Command kinds Ruby can be asked to perform. Trade-affecting kinds route
// through the existing instant-trade router; STATUS_CHECK / CANCEL are
// bookkeeping and never touch the broker.
export const RUBY_COMMAND_KINDS = [
  "OPEN_TRADE",
  "CLOSE_TRADE",
  "CLOSE_ALL",
  "MODIFY_SL_TP",
  "MOVE_SL_TO_BREAKEVEN",
  "PARTIAL_CLOSE",
  "MONITOR_TRADE",
  "WATCH_AND_ENTER",
  "WATCH_AND_CLOSE",
  "SCALP_BEST_SETUP",
  "CANCEL_PENDING_RUBY_ACTION",
  "STATUS_CHECK",
] as const;
export type RubyCommandKind = (typeof RUBY_COMMAND_KINDS)[number];

// Lifecycle of a single Ruby command row.
//   PENDING            — recorded, not yet dispatched
//   EXECUTING          — handed to the instant-trade router
//   COMPLETED          — router accepted + dispatched (sent to bridge)
//   BLOCKED            — refused by a gate (Ruby auth, 16-gate, handshake)
//   FAILED             — router/pipeline error
//   DUPLICATE_PREVENTED— a matching command was already in flight
//   CANCELLED          — user/operator cancelled before fire
export const RUBY_COMMAND_STATUSES = [
  "PENDING", "EXECUTING", "COMPLETED", "BLOCKED", "FAILED",
  "DUPLICATE_PREVENTED", "CANCELLED",
] as const;
export type RubyCommandStatus = (typeof RUBY_COMMAND_STATUSES)[number];

export const rubyCommandsTable = pgTable(
  "ruby_commands",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id),

    // "live" today; demo allowed for completeness. Never "paper".
    accountMode: text("account_mode").notNull().default("live"),
    // ruby_text | ruby_voice — the reserved instant-trade source seam.
    source: text("source").notNull(),

    commandKind: text("command_kind").notNull(),
    symbol: text("symbol"),
    action: text("action"),
    // JSON blob of parsed params (volume, SL/TP, ticket, fractions, …).
    params: text("params"),
    rawUserCommand: text("raw_user_command"),

    // Dedupe fingerprint (kind|symbol|action|key-params). The partial
    // unique index below refuses a second in-flight row with the same
    // fingerprint for the same user.
    fingerprint: text("fingerprint").notNull(),
    // Idempotency key forwarded into the live pipeline so the broker
    // dispatch itself is also exactly-once.
    idempotencyKey: text("idempotency_key").notNull(),

    status: text("status").notNull().default("PENDING"),

    // Result linkage — populated as the single live command resolves.
    liveCommandId: text("live_command_id"),
    brokerTicket: text("broker_ticket"),
    retcode: integer("retcode"),
    handshakeStatus: text("handshake_status"),
    resultDetail: text("result_detail"),
    blockReason: text("block_reason"),
    errorReason: text("error_reason"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // One in-flight command per (user, fingerprint). Accidental repeats of
    // the same command while the first is still PENDING/EXECUTING are
    // refused at the DB layer.
    inFlightUq: uniqueIndex("ruby_commands_user_fingerprint_inflight_uq")
      .on(t.userId, t.fingerprint)
      .where(sql`status in ('PENDING','EXECUTING')`),
  }),
);

export type RubyCommand = typeof rubyCommandsTable.$inferSelect;

// ── Watch / monitor lifecycle ────────────────────────────────────────────
//
// WATCH_AND_ENTER  — arm an entry when price reaches a level (one-shot OPEN)
// WATCH_AND_CLOSE  — arm a close of an existing position at a level
// MONITOR_TRADE    — advisory monitoring of an open position; may arm a
//                    protective close (break-even / exit) on the user's behalf
//
// Single-fire: the ACTIVE→FIRED transition is a CAS; only the winning
// update dispatches the underlying instant-trade command.
export const RUBY_WATCH_KINDS = [
  "WATCH_AND_ENTER", "WATCH_AND_CLOSE", "MONITOR_TRADE",
] as const;
export type RubyWatchKind = (typeof RUBY_WATCH_KINDS)[number];

export const RUBY_WATCH_STATUSES = [
  "ACTIVE", "FIRED", "EXPIRED", "CANCELLED", "SKIPPED",
] as const;
export type RubyWatchStatus = (typeof RUBY_WATCH_STATUSES)[number];

export const rubyWatchInstructionsTable = pgTable(
  "ruby_watch_instructions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id),

    kind: text("kind").notNull(),
    accountMode: text("account_mode").notNull().default("live"),
    source: text("source").notNull(),

    symbol: text("symbol"),
    side: text("side"),
    lot: doublePrecision("lot"),
    // For WATCH_AND_CLOSE / MONITOR_TRADE — the position this watch manages.
    positionTicket: text("position_ticket"),

    // JSON conditions. triggerCondition: {op:">="|"<=", price:number}.
    // invalidationCondition / riskParams (SL/TP) optional JSON blobs.
    triggerCondition: text("trigger_condition"),
    invalidationCondition: text("invalidation_condition"),
    riskParams: text("risk_params"),
    rawUserCommand: text("raw_user_command"),

    status: text("status").notNull().default("ACTIVE"),
    firedAt: timestamp("fired_at"),
    firedCommandId: text("fired_command_id"),
    skipReason: text("skip_reason"),
    expiresAt: timestamp("expires_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    // Bounded set of ACTIVE watches per user is enforced in the route; this
    // index keeps lookups of a user's active watches fast.
    userActiveIdx: uniqueIndex("ruby_watch_user_active_idx")
      .on(t.userId, t.id),
  }),
);

export type RubyWatchInstruction = typeof rubyWatchInstructionsTable.$inferSelect;
