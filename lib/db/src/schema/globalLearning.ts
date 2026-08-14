// Global Learning Layer — Anonymous, aggregated cross-user intelligence.
//
// PRIVACY RULES (enforced at the schema level):
//   - No user IDs in global_signal_edges. Ever.
//   - No account numbers, broker names, P&L amounts, or balance data.
//   - Minimum MIN_SAMPLE_SIZE contributors before a row is surfaced to users.
//   - Users must opt in before their anonymized data contributes.
//   - Raw trade data never leaves the user's own tables.
//   - Only aggregated statistics (win rate, avg R, sample count) are stored.
//
// Architecture:
//   Layer A — Private: user's own DNA profile (traderDnaProfiles table)
//   Layer B — Anonymous group: global_signal_edges (this file)
//   Layer C — System: Ruby reads global edges to adjust confidence scores
//
// SAFETY: Never affects live trading. Never bypasses gates. Advisory only.

import {
  pgTable, serial, integer, text, real, boolean,
  timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ── Minimum contributors before surfacing global insight ─────────────────────
export const MIN_SAMPLE_SIZE = 10; // require at least 10 distinct users

// ── 1. Per-user privacy/opt-in settings ──────────────────────────────────────
export const userPrivacySettingsTable = pgTable("user_privacy_settings", {
  id:     serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  // Contribute anonymized trade outcomes to global learning
  // Default OFF — users must explicitly opt in
  contributeToGlobalLearning: boolean("contribute_to_global_learning")
    .notNull().default(false),
  contributionOptedInAt:  timestamp("contribution_opted_in_at",  { withTimezone: true }),
  contributionOptedOutAt: timestamp("contribution_opted_out_at", { withTimezone: true }),

  // Receive global learning insights in Ruby responses
  // Default ON — users can turn off if they don't want platform-wide hints
  receiveGlobalInsights: boolean("receive_global_insights")
    .notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUdx: uniqueIndex("ups_user_udx").on(t.userId),
}));

export type UserPrivacySettingsRow = typeof userPrivacySettingsTable.$inferSelect;

// ── 2. Global signal edges (fully anonymous, aggregated) ─────────────────────
// One row per (symbol, session, setup_type, action) cohort.
// Updated by the background aggregation job from opted-in users.
// NO user IDs. NO account data. NO raw P&L.
export const globalSignalEdgesTable = pgTable("global_signal_edges", {
  id:           serial("id").primaryKey(),

  // ── Cohort key ─────────────────────────────────────────────────────────
  symbol:       text("symbol").notNull(),
  sessionLabel: text("session_label").notNull().default("any"),
  // asian | london | overlap | newyork | any
  setupType:    text("setup_type").notNull().default("any"),
  // breakout | pullback | reversal | continuation | any | etc.
  action:       text("action").notNull(),
  // BUY | SELL

  // ── Anonymous aggregated stats ─────────────────────────────────────────
  contributorCount: integer("contributor_count").notNull().default(0),
  // Number of DISTINCT users contributing to this cohort (enforces MIN_SAMPLE_SIZE)

  sampleCount:  integer("sample_count").notNull().default(0),   // total trades
  winCount:     integer("win_count").notNull().default(0),
  lossCount:    integer("loss_count").notNull().default(0),

  winRate:      real("win_rate").notNull().default(0),           // 0-100
  avgRMultiple: real("avg_r_multiple"),                          // average R achieved
  avgDuration:  real("avg_duration_seconds"),                    // avg trade duration

  // ── Insight quality ────────────────────────────────────────────────────
  // Only surfaced when contributorCount >= MIN_SAMPLE_SIZE
  isSurfaceable: boolean("is_surfaceable").notNull().default(false),

  // ── Confidence adjustment ──────────────────────────────────────────────
  // Applied to Ruby's confidence score when this cohort matches current setup.
  // Bounded to [-10, 10] — cannot override local signals.
  confidenceAdjustment: real("confidence_adjustment").notNull().default(0),

  lastAggregatedAt: timestamp("last_aggregated_at", { withTimezone: true }),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cohortUdx:    uniqueIndex("gse_cohort_udx").on(t.symbol, t.sessionLabel, t.setupType, t.action),
  symbolIdx:    index("gse_symbol_idx").on(t.symbol),
  surfaceIdx:   index("gse_surfaceable_idx").on(t.isSurfaceable),
}));

export type GlobalSignalEdgeRow = typeof globalSignalEdgesTable.$inferSelect;

// ── 3. Aggregation audit log ──────────────────────────────────────────────────
// Records each time the global aggregation job runs — never stores user data.
export const globalLearningRunsTable = pgTable("global_learning_runs", {
  id:              serial("id").primaryKey(),
  runId:           text("run_id").notNull(),
  status:          text("status").notNull(),    // RUNNING | COMPLETE | FAILED
  optedInUsers:    integer("opted_in_users").notNull().default(0),
  cohortsUpdated:  integer("cohorts_updated").notNull().default(0),
  cohortsCreated:  integer("cohorts_created").notNull().default(0),
  startedAt:       timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:     timestamp("completed_at", { withTimezone: true }),
  errorMessage:    text("error_message"),
});
