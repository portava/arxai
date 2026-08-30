// Capability #28 — the independent protection watchdog's dead-man's-switch row.
//
// WHY THE APP OWNS THIS TABLE AND NOT THE WATCHDOG
// The watchdog process runs on a FORCED READ-ONLY database session — it must
// never hold a write path (pinned by the source-guard test). So it cannot
// record its own heartbeat. Instead it POSTs each pass to
// `POST /api/watchdog/alerts`, and the API SERVER — which already has write
// access — upserts this row. One row per watchdog instance.
//
// The consequence is honest and deliberate: if the app is down, this row goes
// stale. That staleness means "the app, the watchdog, or the link between
// them is broken" — it does NOT distinguish which. The watchdog's own
// /healthz port is the surface that answers "is the watcher alive"; this
// table answers "is the watcher still reaching us".
//
// Additive only. No trade columns, no authority flags, no secrets — the
// shared ingest token is NEVER stored here.

import { pgTable, serial, text, integer, boolean, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

export const watchdogHeartbeatsTable = pgTable("watchdog_heartbeats", {
  id: serial("id").primaryKey(),
  /** Self-reported instance identity; one row per deployed watchdog. */
  instanceId: text("instance_id").notNull(),
  /** Self-reported topology claim: same_host | second_repl | external_host | unknown. */
  topology: text("topology").notNull().default("unknown"),
  /** VERIFIED_HEALTHY | FINDINGS | CANNOT_VERIFY — never inferred, always as sent. */
  lastVerdict: text("last_verdict").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  findingsTotal: integer("findings_total").notNull().default(0),
  criticalCount: integer("critical_count").notNull().default(0),
  cannotVerifyCount: integer("cannot_verify_count").notNull().default(0),
  /** Finding keys active on the last pass — keys only, no evidence payload. */
  activeFindingKeys: jsonb("active_finding_keys").notNull().default([]),
  watchdogUptimeSeconds: integer("watchdog_uptime_seconds").notNull().default(0),
  /** How many notifications the ingest actually raised for the last pass. */
  notificationsRaised: integer("notifications_raised").notNull().default(0),
  /** True when the ingest could not raise a notification it should have. */
  ingestDegraded: boolean("ingest_degraded").notNull().default(false),
  ingestDegradedReason: text("ingest_degraded_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  instanceIdx: uniqueIndex("watchdog_heartbeats_instance_id_idx").on(t.instanceId),
  lastSeenIdx: index("watchdog_heartbeats_last_seen_at_idx").on(t.lastSeenAt),
}));

export type WatchdogHeartbeat = typeof watchdogHeartbeatsTable.$inferSelect;
