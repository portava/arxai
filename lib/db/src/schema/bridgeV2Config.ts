// ── ARX Bridge v2 — remote-config manifest (Task #397) ──────────────────────
//
// Per-user versioned manifest the v2 EA pulls from `GET /api/bridge/v2/config`.
// The EA applies a manifest ONLY when its `configVersion` is strictly newer than
// the one it already holds, then ACKs the applied version back via a CONFIG_ACK
// telemetry message (recorded by the pure ingest path in `bridge_v2_events`).
//
// SAFETY (inviolable):
// - `executionAllowed` here is ONE participant in enabling — it can NEVER
//   override the EA's LOCAL ARM inputs (ReadOnlyMode / AllowOrderExecution) and
//   it does NOT, by itself, let any trade through. The served value is always
//   ANDed with the server master switch resolution (env AND db) so the EA can
//   never see `true` while the environment master switch is off. Default false.
// - `maxLiveLot` is ADVISORY and tighten-only: the EA applies it as a LOWER cap
//   (min with its own compiled MaxLiveLot input); it can never raise a limit.
// - This table drives NO execution. It is a pull-manifest only; whitelisted live
//   commands still flow exclusively through arx_live_commands → the 16-gate
//   Phase B pipeline.
// - Per-user isolation: one row per user; every read scopes by user_id.

import {
  pgTable, serial, integer, text, timestamp, jsonb, boolean,
  doublePrecision, uniqueIndex,
} from "drizzle-orm/pg-core";

// One row per user. Absence of a row = EA-safe defaults (version 1, execution
// NOT allowed, no advisory lot cap).
export const bridgeV2ConfigTable = pgTable("bridge_v2_config", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  // Monotonic version bumped on every admin write so the EA can detect a
  // changed manifest without diffing every field.
  configVersion: integer("config_version").notNull().default(1),

  // Admin-controlled v2 remote-execution participation flag. The value SERVED to
  // the EA is `executionAllowed AND resolveLiveBrokerExecutionEnabledAsync()`.
  // Default false; never overrides the EA's local ARM inputs.
  executionAllowed: boolean("execution_allowed").notNull().default(false),

  // Advisory remote lot ceiling (0 = unset). Tighten-only at the EA.
  maxLiveLot: doublePrecision("max_live_lot").notNull().default(0),

  // Future allow-listed operational tunables (cadences, thresholds). Reserved;
  // the kernel does not consume these yet.
  tunables: jsonb("tunables").notNull().default({}),

  // Audit / authorship.
  updatedByAdminId: integer("updated_by_admin_id"),
  updateReason: text("update_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUq: uniqueIndex("bridge_v2_config_user_uq").on(t.userId),
}));

export type BridgeV2Config = typeof bridgeV2ConfigTable.$inferSelect;
export type NewBridgeV2Config = typeof bridgeV2ConfigTable.$inferInsert;
