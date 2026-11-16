// Task #32 — Remote EA configuration (per-user, audited delivery).
//
// ARX can push SAFE, allow-listed operational tunables to the EA without a
// manual reinstall. The EA polls `/api/mt5/remote-config` and applies ONLY the
// fields stored here.
//
// SAFETY (inviolable):
// - This table can ONLY ever carry allow-listed operational tunables (poll /
//   heartbeat / snapshot cadences, diagnostics verbosity, spread / deviation /
//   quote-freshness thresholds, retry/backoff, default command TTL, maintenance
//   mode, an ADVISORY max-live-lot ceiling, and the allowed command-type list).
// - It CANNOT carry, and the EA must NEVER let it override, any protected field:
//   MT5 AlgoTrading permission, broker connection status, the EA's LOCAL
//   ReadOnlyMode, the EA's LOCAL EnableLiveExecution, the ARX kill switch, the
//   16-gate evaluator, or the liveTrading chokepoint. The protected-field guard
//   lives in `lib/domain/.../eaRemoteConfigContract.ts` and is enforced on
//   write AND on delivery.
// - The advisory `maxLiveLotCeiling` can only ever be applied by the EA as an
//   additional LOWER ceiling (min with the EA's own MaxLiveLot input); it can
//   never raise a local limit.
// - Every mutation is audited (updatedByAdminId + reason + monotonic version).

import {
  pgTable, serial, integer, text, timestamp, jsonb, boolean,
  doublePrecision, uniqueIndex,
} from "drizzle-orm/pg-core";

export const EA_REMOTE_CONFIG_COMMAND_TYPES = [
  "PLACE_LIVE_MARKET_ORDER",
  "PLACE_LIVE_PENDING_ORDER",
  "CLOSE_LIVE_POSITION",
  "MODIFY_LIVE_SLTP",
] as const;

// One row per user. Absence of a row = EA uses its own compiled defaults.
export const eaRemoteConfigTable = pgTable("ea_remote_config", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // Optional pin to a specific bridge connection. Null = applies to the user's
  // active bridge regardless of connection id.
  bridgeConnectionId: integer("bridge_connection_id"),

  // ── Allow-listed operational tunables (cadences, in seconds) ──────────────
  heartbeatPeriodSeconds: integer("heartbeat_period_seconds"),
  pollIntervalSeconds: integer("poll_interval_seconds"),
  snapshotPeriodSeconds: integer("snapshot_period_seconds"),
  dealHistorySyncSeconds: integer("deal_history_sync_seconds"),
  symbolSpecPeriodSeconds: integer("symbol_spec_period_seconds"),

  // Diagnostics + thresholds.
  verboseDiagnostics: boolean("verbose_diagnostics"),
  maxSpreadPoints: integer("max_spread_points"),
  maxDeviationPoints: integer("max_deviation_points"),
  quoteFreshnessSeconds: integer("quote_freshness_seconds"),
  defaultCommandTtlSeconds: integer("default_command_ttl_seconds"),

  // Retry / backoff for transient EA->server failures.
  retryMaxAttempts: integer("retry_max_attempts"),
  retryBackoffMs: integer("retry_backoff_ms"),

  // Advisory ceilings + behaviour flags. maxLiveLotCeiling is ADVISORY: the EA
  // applies it only as a LOWER bound (min with its compiled MaxLiveLot input).
  maxLiveLotCeiling: doublePrecision("max_live_lot_ceiling"),
  closeCommandSupportEnabled: boolean("close_command_support_enabled"),
  // {EA pauses all NEW command execution while true; positions are untouched.}
  maintenanceMode: boolean("maintenance_mode").notNull().default(false),
  // Allow-listed command types the EA may execute. Subset of
  // EA_REMOTE_CONFIG_COMMAND_TYPES. Empty/absent = EA uses its own default set.
  allowedCommandTypes: jsonb("allowed_command_types").notNull().default([]),

  // ── Audit / versioning ────────────────────────────────────────────────────
  // Monotonic version bumped on every write so the EA can detect a changed
  // config without diffing every field.
  configVersion: integer("config_version").notNull().default(1),
  updateReason: text("update_reason"),
  updatedByAdminId: integer("updated_by_admin_id"),
  lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUq: uniqueIndex("ea_remote_config_user_uq").on(t.userId),
}));

export type EaRemoteConfig = typeof eaRemoteConfigTable.$inferSelect;
export type NewEaRemoteConfig = typeof eaRemoteConfigTable.$inferInsert;
