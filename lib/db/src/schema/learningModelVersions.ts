// Learning Model Version Tracking
//
// Every update to ARX global learning, signal edges, Ruby confidence
// calibration, or scanner scoring must be versioned before it can
// influence live recommendations.
//
// Gate flow (must pass all before liveAllowed = true):
//   1. DATA_VALIDATED    — input data quality > threshold
//   2. WALK_FORWARD_PASS — out-of-sample test passed
//   3. SHADOW_VALIDATED  — shadow mode accuracy acceptable
//   4. ADMIN_APPROVED    — operator has reviewed and approved
//
// SAFETY:
//   - liveAllowed defaults to FALSE — never auto-approved
//   - Rollback marks a version superseded, reverts recommendation layer
//   - No trade execution gates modified here — advisory/scoring only

import {
  pgTable, serial, integer, text, real, boolean,
  timestamp, jsonb, index,
} from "drizzle-orm/pg-core";

export const learningModelVersionsTable = pgTable("learning_model_versions", {
  id:          serial("id").primaryKey(),
  versionId:   text("version_id").notNull(),        // e.g. "glv_20240315_001"

  // ── What changed ─────────────────────────────────────────────────────
  versionName: text("version_name").notNull(),       // human-readable e.g. "Global edge update Mar 2024"
  changeType:  text("change_type").notNull(),
  // global_signal_edges | confidence_calibration | scanner_scoring |
  // dna_weights | ruby_behavior | risk_thresholds
  changeSummary: text("change_summary").notNull(),   // plain language description
  dataSources:   jsonb("data_sources").notNull().default([]), // string[] — which sources fed this update

  // ── Validation results ───────────────────────────────────────────────
  dataQualityScore:   real("data_quality_score"),    // 0-100 from import scoring
  walkForwardScore:   real("walk_forward_score"),    // 0-100 out-of-sample accuracy
  shadowAccuracy:     real("shadow_accuracy"),       // 0-100 shadow mode win rate
  shadowSampleSize:   integer("shadow_sample_size"), // number of shadow predictions used

  dataValidated:      boolean("data_validated").notNull().default(false),
  walkForwardPassed:  boolean("walk_forward_passed").notNull().default(false),
  shadowValidated:    boolean("shadow_validated").notNull().default(false),
  adminApproved:      boolean("admin_approved").notNull().default(false),

  // ── Live gate ────────────────────────────────────────────────────────
  liveAllowed:        boolean("live_allowed").notNull().default(false),
  // Only true when all 4 gates above pass

  // ── Rollback ─────────────────────────────────────────────────────────
  isActive:           boolean("is_active").notNull().default(false),
  rolledBack:         boolean("rolled_back").notNull().default(false),
  rolledBackAt:       timestamp("rolled_back_at", { withTimezone: true }),
  rolledBackReason:   text("rolled_back_reason"),
  supersededBy:       text("superseded_by"),         // versionId of replacement

  // ── Performance tracking (filled after deployment) ───────────────────
  deployedAt:         timestamp("deployed_at", { withTimezone: true }),
  postDeployWinRateDelta: real("post_deploy_win_rate_delta"), // improvement vs prior version
  postDeploySampleSize:   integer("post_deploy_sample_size"),

  // ── Admin ────────────────────────────────────────────────────────────
  approvedByAdminId:  integer("approved_by_admin_id"),
  approvedAt:         timestamp("approved_at", { withTimezone: true }),
  adminNotes:         text("admin_notes"),
  relatedRunId:       text("related_run_id"),        // globalLearningRuns.runId

  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionIdIdx: index("lmv_version_id_idx").on(t.versionId),
  activeIdx:    index("lmv_active_idx").on(t.isActive),
  liveIdx:      index("lmv_live_allowed_idx").on(t.liveAllowed),
}));

export type LearningModelVersionRow = typeof learningModelVersionsTable.$inferSelect;

// ── Minimum thresholds for gate passage ──────────────────────────────────────
export const VERSION_GATES = {
  MIN_DATA_QUALITY:      60,   // data quality score must be >= 60
  MIN_WALK_FORWARD:      52,   // out-of-sample win rate must be >= 52%
  MIN_SHADOW_ACCURACY:   50,   // shadow mode win rate >= 50% (better than random)
  MIN_SHADOW_SAMPLE:     20,   // need at least 20 shadow predictions to validate
} as const;
