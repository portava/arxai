// Task #32 — EA update manager (manifest + approval workflow + self-update audit).
//
// ARX tracks every published EA build so the EA can self-update without a manual
// reinstall. A build is published as a MANIFEST row that moves through an
// approval workflow (draft → staged → approved → revoked). The EA only ever
// downloads an `approved` manifest for its own channel, verifies the sha256
// checksum BEFORE applying, and reports the outcome.
//
// SAFETY:
// - Only a manifest in `approved` status is ever served to an EA. draft/staged
//   are operator-only; revoked is never served.
// - The checksum is mandatory; the EA refuses to apply a downloaded package
//   whose sha256 does not match. No update path can skip checksum verification.
// - Updating is BLOCKED (server gate + EA gate) while a live trade is open, a
//   command is pending, the heartbeat is unstable, the channel is disallowed,
//   the kill switch is engaged, or maintenance policy blocks it. This table
//   carries the data those gates read; the gate itself is the pure
//   `lib/domain/.../eaUpdateGate.ts`.
// - `isUpdaterCapable` marks a package that itself contains the self-update
//   bootstrap. If the installed EA cannot self-update, ARX surfaces "Manual
//   bootstrap EA install required" and offers the nearest updater-capable
//   package to download.

import {
  pgTable, serial, integer, text, timestamp, jsonb, boolean,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";

export const EA_UPDATE_CHANNELS = ["stable", "beta", "emergency"] as const;
export type EaUpdateChannel = (typeof EA_UPDATE_CHANNELS)[number];

export const EA_RELEASE_STATUSES = [
  "draft",
  "staged",
  "approved",
  "revoked",
] as const;
export type EaReleaseStatus = (typeof EA_RELEASE_STATUSES)[number];

export const eaUpdateManifestTable = pgTable("ea_update_manifest", {
  id: serial("id").primaryKey(),

  version: text("version").notNull(),                 // e.g. "1.29"
  channel: text("channel").notNull().default("stable"), // stable | beta | emergency
  // Minimum EA version that may upgrade to this build. An EA below this still
  // sees the update but the gate flags it as a required bootstrap step.
  minimumVersion: text("minimum_version"),

  manifestJson: jsonb("manifest_json").notNull().default({}),
  changelog: text("changelog"),

  // Integrity — mandatory checksum, optional signature.
  sha256Checksum: text("sha256_checksum").notNull(),
  signature: text("signature"),
  downloadUrl: text("download_url").notNull(),
  // Version the EA should roll back to if applying this build fails.
  rollbackVersion: text("rollback_version"),

  // Does THIS package contain the self-update bootstrap? Drives the
  // "Manual bootstrap EA install required" surface for EAs that cannot
  // self-update yet.
  isUpdaterCapable: boolean("is_updater_capable").notNull().default(false),

  // Approval workflow.
  releaseStatus: text("release_status").notNull().default("draft"),
  createdByAdminId: integer("created_by_admin_id"),
  stagedByAdminId: integer("staged_by_admin_id"),
  stagedAt: timestamp("staged_at", { withTimezone: true }),
  approvedByAdminId: integer("approved_by_admin_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  revokedByAdminId: integer("revoked_by_admin_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
  notes: text("notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // At most one manifest per (channel, version).
  channelVersionUq: uniqueIndex("ea_update_manifest_channel_version_uq")
    .on(t.channel, t.version),
  statusIdx: index("ea_update_manifest_status_idx").on(t.releaseStatus),
  channelStatusIdx: index("ea_update_manifest_channel_status_idx")
    .on(t.channel, t.releaseStatus),
}));

// EA self-update lifecycle audit. Every check/download/verify/apply/rollback the
// EA performs is reported here so operators can prove the update path end to end.
export const EA_UPDATE_REPORT_PHASES = [
  "CHECK",
  "DOWNLOAD",
  "VERIFY",
  "APPLY",
  "ROLLBACK",
  "REATTACH_REQUESTED",
  "MANUAL_BOOTSTRAP_REQUIRED",
] as const;
export type EaUpdateReportPhase = (typeof EA_UPDATE_REPORT_PHASES)[number];

export const EA_UPDATE_REPORT_OUTCOMES = ["OK", "FAILED", "BLOCKED"] as const;
export type EaUpdateReportOutcome = (typeof EA_UPDATE_REPORT_OUTCOMES)[number];

export const eaUpdateReportTable = pgTable("ea_update_report", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  bridgeConnectionId: integer("bridge_connection_id"),
  manifestId: integer("manifest_id"),

  fromVersion: text("from_version"),
  toVersion: text("to_version"),
  channel: text("channel"),

  phase: text("phase").notNull(),       // EA_UPDATE_REPORT_PHASES
  outcome: text("outcome").notNull(),   // EA_UPDATE_REPORT_OUTCOMES
  checksumVerified: boolean("checksum_verified").notNull().default(false),
  blockReason: text("block_reason"),
  detail: text("detail"),

  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("ea_update_report_user_idx").on(t.userId),
  manifestIdx: index("ea_update_report_manifest_idx").on(t.manifestId),
}));

export type EaUpdateManifest = typeof eaUpdateManifestTable.$inferSelect;
export type NewEaUpdateManifest = typeof eaUpdateManifestTable.$inferInsert;
export type EaUpdateReport = typeof eaUpdateReportTable.$inferSelect;
export type NewEaUpdateReport = typeof eaUpdateReportTable.$inferInsert;
