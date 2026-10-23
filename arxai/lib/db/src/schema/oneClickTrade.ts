// One-Click Trade — per-user toggle (DEMO + LIVE scopes, both default OFF)
//
// Hard invariants enforced at the schema layer:
//
//   - Both `demo_one_click_enabled` and `live_one_click_enabled` DEFAULT
//     FALSE. New users are NEVER auto-opted-in.
//   - Enabling either scope requires a typed confirmation phrase
//     (`ENABLE ONE CLICK TRADING`) — the route layer rejects any PUT
//     that does not echo it; the row also stores the typed phrase for
//     audit replay.
//   - The LIVE scope additionally requires the per-user master-live
//     access gate to PASS at enable time AND at submit time. Toggle ON
//     is NOT a bypass of any live or master-bridge gate.
//
// Companion table `one_click_audit` is append-only.
import {
  pgTable, serial, integer, boolean, text, timestamp, doublePrecision,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const userOneClickSettingsTable = pgTable(
  "user_one_click_settings",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id),

    demoOneClickEnabled: boolean("demo_one_click_enabled").notNull().default(false),
    liveOneClickEnabled: boolean("live_one_click_enabled").notNull().default(false),

    // Provenance — when each scope was last enabled, by whom, and the
    // typed-confirmation phrase that was echoed.
    demoEnabledAt: timestamp("demo_enabled_at"),
    liveEnabledAt: timestamp("live_enabled_at"),
    demoTypedConfirmation: text("demo_typed_confirmation"),
    liveTypedConfirmation: text("live_typed_confirmation"),
    demoDisabledAt: timestamp("demo_disabled_at"),
    liveDisabledAt: timestamp("live_disabled_at"),

    // Per-submission caps — server enforces these EVEN IF one-click is ON.
    // Null = fall back to the master-live access row's `max_lot`.
    maxLotPerClick: doublePrecision("max_lot_per_click"),
    // Token-bucket refill rate for the per-user submit rate limiter
    // (clamped server-side to a safe ceiling).
    perUserSubmitsPerMinute: integer("per_user_submits_per_minute").notNull().default(20),

    // ── One-click fast-trade UX preferences ────────────────────────────
    // Operator-set defaults the BUY/SELL panel reads from. They never
    // bypass per-market max-lot or symbol-allowlist gates — those still
    // run server-side in createLiveDraft + the 16-gate evaluator.
    defaultSymbol: text("default_symbol").notNull().default("EURUSD"),
    defaultVolume: doublePrecision("default_volume").notNull().default(0.01),
    defaultOrderType: text("default_order_type").notNull().default("MARKET_BUY"),
    // Allow live one-click PLACE orders without a stop-loss attached.
    // OFF by default (safe). Even when ON: the user must already be
    // approvedForMasterLive AND have liveOneClickEnabled=true; the close
    // path always ignores SL (positions can be reduced regardless).
    allowOrdersWithoutStopLoss: boolean("allow_orders_without_stop_loss")
      .notNull().default(false),
    // Allow CLOSE / reduce-only ops to keep working when the kill
    // switch is active (so a user can always exit). ON by default.
    reduceOnlyCloseAllowed: boolean("reduce_only_close_allowed")
      .notNull().default(true),

    // ── Ruby AI command-execution settings ─────────────────────────────
    // OFF by default. When OFF, Ruby may still ANSWER analysis questions
    // but the instant-trade router refuses any source ∈ {ruby_text,
    // ruby_voice} request with `RUBY_TRADING_NOT_ENABLED`. Approved
    // operators may flip this on from the live-trading settings page.
    // The three allow* flags are AND-gated against this master toggle
    // and against the per-action source check at the route layer.
    aiInstantTradeCommandsEnabled: boolean("ai_instant_trade_commands_enabled")
      .notNull().default(false),
    defaultAiTradeSymbol: text("default_ai_trade_symbol"),
    defaultAiTradeVolume: doublePrecision("default_ai_trade_volume"),
    defaultAiOrderType: text("default_ai_order_type"),
    allowRubyOpenCommands: boolean("allow_ruby_open_commands")
      .notNull().default(false),
    allowRubyCloseCommands: boolean("allow_ruby_close_commands")
      .notNull().default(true),
    allowRubyModifyCommands: boolean("allow_ruby_modify_commands")
      .notNull().default(true),

    // ── Ruby execution-authority model (Task #319) ─────────────────────
    // The SOURCE OF TRUTH for whether Ruby may execute. Modes:
    //   OFF         — Ruby answers analysis only; the instant-trade router
    //                 refuses any ruby_text/ruby_voice source.
    //   ADVISE_ONLY — Ruby may propose a trade but never executes; the user
    //                 still confirms and submits manually.
    //   AI_ASSISTED — Ruby executes ALLOWED commands through the existing
    //                 instant-trade → 16-gate pipeline WITHOUT the extra
    //                 confirmation prompt (when rubyRequireExtraConfirmation
    //                 is false). It NEVER bypasses any backend gate.
    //   AI_AUTO     — reserved for autonomous find/open/manage/close. DEFINED
    //                 but NOT enabled in this build; the auth layer refuses
    //                 execution under AI_AUTO with RUBY_AI_AUTO_NOT_ENABLED.
    // Legacy `aiInstantTradeCommandsEnabled` is kept in sync (true iff
    // authority === 'AI_ASSISTED') so older readers stay consistent.
    rubyExecutionAuthority: text("ruby_execution_authority")
      .notNull().default("OFF"),
    // When true (default), Ruby surfaces a confirm step even in AI_ASSISTED.
    // Setting false is the user's explicit opt-in to one-gesture execution.
    rubyRequireExtraConfirmation: boolean("ruby_require_extra_confirmation")
      .notNull().default(true),

    // Per-action permissions (AND-gated against authority + the existing
    // open/close/modify allow flags). Risk-reducing actions default ON;
    // risk-adding actions default OFF.
    allowRubyBreakEven: boolean("allow_ruby_break_even").notNull().default(true),
    allowRubyPartialClose: boolean("allow_ruby_partial_close").notNull().default(true),
    allowRubyMonitor: boolean("allow_ruby_monitor").notNull().default(true),
    allowRubyWatchEnter: boolean("allow_ruby_watch_enter").notNull().default(false),
    allowRubyWatchClose: boolean("allow_ruby_watch_close").notNull().default(true),
    allowRubyScalpScanner: boolean("allow_ruby_scalp_scanner").notNull().default(false),

    // Per-Ruby caps — enforced IN ADDITION to (never instead of) the
    // per-market max-lot, master-live, and 16-gate limits. Null = no
    // Ruby-specific cap (account limits still apply).
    maxRubyLotPerTrade: doublePrecision("max_ruby_lot_per_trade"),
    maxRubyOpenPositions: integer("max_ruby_open_positions"),
    maxRubyDailyTrades: integer("max_ruby_daily_trades"),
    // JSON arrays. Null = inherit the account symbol allowlist / all asset
    // classes. Non-null = a stricter Ruby-only subset.
    allowedRubySymbols: text("allowed_ruby_symbols"),
    allowedRubyAssetClasses: text("allowed_ruby_asset_classes"),

    // Task #353 — Bridge-type-aware armed one-click trading.
    // oneClickArmed is the new bridge-type-aware armed state. When true,
    // ALL Buy/Sell surfaces skip confirmation and send immediately.
    //   - Shared-bridge users: requires admin `sharedBridgeOneClickPermitted`
    //     grant first; then user arms via the agreement modal.
    //   - Own-bridge users: can self-arm once their bridge is live/ready.
    // Both cases still run all 16 Phase B gates on every dispatch.
    oneClickArmed: boolean("one_click_armed").notNull().default(false),
    oneClickArmedAt: timestamp("one_click_armed_at"),
    oneClickDisarmedAt: timestamp("one_click_disarmed_at"),
    // "SHARED" | "OWN" — bridge type at arm time. Stored for audit; auto-
    // disarm fires if admin revokes shared-bridge one-click permission.
    oneClickBridgeType: text("one_click_bridge_type"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    userUq: uniqueIndex("user_one_click_settings_user_id_uq").on(t.userId),
  }),
);

export type UserOneClickSettings = typeof userOneClickSettingsTable.$inferSelect;

export const ONE_CLICK_AUDIT_ACTIONS = [
  "ENABLE_DEMO", "DISABLE_DEMO",
  "ENABLE_LIVE", "DISABLE_LIVE",
  "LIMITS_UPDATED",
  "SUBMIT_DEMO_ONE_CLICK", "SUBMIT_LIVE_ONE_CLICK",
  // Phase: global instant-trade router (BUY/SELL/CLOSE/CLOSE_ALL/MODIFY)
  // surfaces from anywhere in the app (trade page, scanner, chart,
  // watchlist, position card, dashboard, alert, ruby_text, ruby_voice).
  "INSTANT_EXECUTE_ACCEPTED", "INSTANT_EXECUTE_REJECTED",
  "INSTANT_CLOSE_ACCEPTED", "INSTANT_CLOSE_REJECTED",
  "INSTANT_CLOSE_ALL_ACCEPTED", "INSTANT_CLOSE_ALL_REJECTED",
  "INSTANT_VALIDATE",
  "RUBY_TRADE_COMMAND_PARSED", "RUBY_TRADE_COMMAND_VAGUE_REJECTED",
  "AI_INSTANT_TRADE_ENABLED", "AI_INSTANT_TRADE_DISABLED",
  // Task #319 — Ruby execution-authority model + bounded executor.
  "RUBY_AUTHORITY_UPDATED",
  "RUBY_COMMAND_RECORDED", "RUBY_COMMAND_BLOCKED", "RUBY_COMMAND_DUPLICATE",
  "RUBY_COMMAND_DISPATCHED", "RUBY_COMMAND_FAILED", "RUBY_COMMAND_CANCELLED",
  "RUBY_WATCH_ARMED", "RUBY_WATCH_FIRED", "RUBY_WATCH_CANCELLED",
  "RUBY_WATCH_SKIPPED",
  // Task #353 — Bridge-type-aware armed one-click trading.
  "ONE_CLICK_ARMED", "ONE_CLICK_DISARMED", "ONE_CLICK_AUTO_DISARMED",
] as const;
export type OneClickAuditAction = (typeof ONE_CLICK_AUDIT_ACTIONS)[number];

export const oneClickAuditTable = pgTable("one_click_audit", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id),
  action: text("action").notNull(),
  typedPhrase: text("typed_phrase"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type OneClickAudit = typeof oneClickAuditTable.$inferSelect;

// ── Atomic exposure reservations ─────────────────────────────────────
//
// Even with the existing `checkMasterExposure()` aggregation, two
// simultaneous SHARED_MASTER_MT5 submissions could both see
// `currentOpenLots + addingLot <= cap` and both proceed. To make the
// check truly atomic we hold an advisory lock on
// `(shared_master_account_id)` while INSERTING a RESERVED row here;
// downstream code then includes RESERVED rows in the exposure sum, so
// the second submission sees the first reservation and refuses with
// `MASTER_ACCOUNT_EXPOSURE_LIMIT_REACHED`.
//
// Lifecycle:
//   RESERVED   — taken before EA dispatch
//   FULFILLED  — broker confirmed fill; reservation kept until
//                shared_trade_attribution row is closed (then the
//                aggregation source switches and we can drop)
//   RELEASED   — dispatch rejected/cancelled; reservation removed
//
// PARTIAL UNIQUE INDEX on (command_id) WHERE status = 'RESERVED'
// guarantees one live reservation per command.
export const ARX_DISPATCH_RESERVATION_STATUSES = [
  "RESERVED", "FULFILLED", "RELEASED",
] as const;
export type ArxDispatchReservationStatus =
  (typeof ARX_DISPATCH_RESERVATION_STATUSES)[number];

export const arxDispatchExposureReservationsTable = pgTable(
  "arx_dispatch_exposure_reservations",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id),
    commandId: text("command_id").notNull(),
    sharedMasterAccountId: integer("shared_master_account_id"),
    symbol: text("symbol").notNull(),
    lotSize: doublePrecision("lot_size").notNull(),
    status: text("status").notNull().default("RESERVED"),
    // R3 slice 3 — optional TTL for a future stuck-RESERVED sweeper. NULL =
    // no expiry (every legacy row, and every row until the writer starts
    // stamping it). MIGRATION IMPLICATION: additive nullable column — needs
    // `db push` (owner-run) before ANY code writes it; the INSERT in
    // lib/concurrency/exposureReservation.ts deliberately does NOT name this
    // column yet, because a raw INSERT against a not-yet-migrated production
    // table would fail-closed every SHARED_MASTER_MT5 dispatch.
    // SWEEP CONSIDERATION (for the future sweeper, recorded here with the
    // column): an expired RESERVED row may be released ONLY when its linked
    // arx_live_commands row rests in a reservation-RELEASING terminal state
    // (settleReservationForStatus === "RELEASE") or provably never
    // dispatched. NEVER sweep a reservation whose command is epistemic
    // (LIVE_UNKNOWN / LIVE_RECONCILIATION_REQUIRED) — those HOLD by the G1b
    // matrix; releasing them under-counts the pool and can over-expose the
    // master account.
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    commandReservedUq: uniqueIndex("arx_disp_reserv_cmd_reserved_uq")
      .on(t.commandId).where(sql`status = 'RESERVED'`),
  }),
);

export type ArxDispatchExposureReservation =
  typeof arxDispatchExposureReservationsTable.$inferSelect;
