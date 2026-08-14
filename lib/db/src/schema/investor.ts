// Investor Portal (Task #72) — view-only investor data model.
//
// SAFETY / DESIGN:
// - Investors are view-only. These tables hold an investor's funds ledger,
//   intent-only allocation preferences (NEVER wired into live trade sizing),
//   admin-configured strategy profiles + a max-aggressive cap, and statements.
// - Every per-investor table is keyed by userId and MUST be read scoped to the
//   caller's own id. No row from investor A is ever returned to investor B.
// - All admin mutations against these tables reuse the existing
//   admin_action_audit_log table (append-only, fail-closed) — no separate
//   audit infrastructure is introduced.
// - Allocation preferences are approved intent only. They do not change any
//   live execution path, lot sizing, or the 16-gate live pipeline.

import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── 1. Investor profile ─────────────────────────────────────────────────────
// One row per investor account (users.role = 'INVESTOR'). Holds display
// metadata, the active risk-profile label (mirrored from the ACTIVE allocation
// preference for fast reads), and the per-investor allocation pause state.
export const investorProfilesTable = pgTable("investor_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  displayName: text("display_name"),
  baseCurrency: text("base_currency").notNull().default("USD"),
  // active | paused — when paused the investor cannot submit allocation
  // requests and the portal shows a paused notice.
  status: text("status").notNull().default("active"),
  // Mirror of the ACTIVE allocation preference's profileKey for cheap reads.
  currentRiskProfile: text("current_risk_profile"),
  pausedReason: text("paused_reason"),
  pausedByAdminId: integer("paused_by_admin_id"),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  linkedByAdminId: integer("linked_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  userUidx: uniqueIndex("investor_profiles_user_uidx").on(t.userId),
  statusIdx: index("investor_profiles_status_idx").on(t.status),
}));
export const insertInvestorProfileSchema = createInsertSchema(investorProfilesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInvestorProfile = z.infer<typeof insertInvestorProfileSchema>;
export type InvestorProfile = typeof investorProfilesTable.$inferSelect;

// ── 2. Investor ledger entries (append-only) ────────────────────────────────
// Deposits, withdrawals, adjustments, and recorded performance. The sign for
// value math is derived from entryType (DEPOSIT/+, WITHDRAWAL/-, ADJUSTMENT and
// PERFORMANCE keep their signed amount). PERFORMANCE rows are real, dated,
// admin-attributed gain/loss figures (e.g. a monthly return credited to the
// investor) — they move the recorded account value and feed realized P/L and
// the headline return %, but are NOT counted as contributions. Append-only:
// rows are never edited or deleted (corrections are new ADJUSTMENT rows).
export const investorLedgerEntriesTable = pgTable("investor_ledger_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // DEPOSIT | WITHDRAWAL | ADJUSTMENT | PERFORMANCE
  entryType: text("entry_type").notNull(),
  // Signed amount in baseCurrency. DEPOSIT > 0, WITHDRAWAL < 0, ADJUSTMENT and
  // PERFORMANCE keep the caller's sign (a loss is negative).
  signedAmount: doublePrecision("signed_amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  reason: text("reason").notNull(),
  createdByAdminId: integer("created_by_admin_id").notNull(),
  // Stable id of the bulk-performance batch this row belongs to (Task #107).
  // NULL for single-row entries posted via the per-investor ledger endpoint.
  // Both the originally-posted PERFORMANCE rows and the offsetting rows written
  // by a reversal carry their batch id, so a batch can be listed and reversed as
  // one unit. The append-only ledger is never hard-deleted — a reversal writes
  // new, individually-attributed offsetting PERFORMANCE rows.
  batchId: text("batch_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("investor_ledger_user_idx").on(t.userId),
  createdIdx: index("investor_ledger_created_idx").on(t.createdAt),
  batchIdx: index("investor_ledger_batch_idx").on(t.batchId),
}));
export const insertInvestorLedgerEntrySchema = createInsertSchema(investorLedgerEntriesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertInvestorLedgerEntry = z.infer<typeof insertInvestorLedgerEntrySchema>;
export type InvestorLedgerEntry = typeof investorLedgerEntriesTable.$inferSelect;

// ── 3. Investor allocation preferences (lifecycle) ──────────────────────────
// Intent-only allocation requests. Lifecycle:
//   DRAFT → PENDING_APPROVAL → APPROVED → ACTIVE → SUPERSEDED
//                            ↘ REJECTED
// The split is across three strategy sleeves and MUST sum to 100. The current
// ACTIVE preference stays ACTIVE until a newer one is approved (then it is
// SUPERSEDED). NEVER wired into live trade sizing.
export const investorAllocationPreferencesTable = pgTable("investor_allocation_preferences", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  // CONSERVATIVE | BALANCED | AGGRESSIVE | CUSTOM
  profileKey: text("profile_key").notNull(),
  conservativePct: integer("conservative_pct").notNull().default(0),
  balancedPct: integer("balanced_pct").notNull().default(0),
  aggressivePct: integer("aggressive_pct").notNull().default(0),
  // DRAFT | PENDING_APPROVAL | APPROVED | REJECTED | ACTIVE | SUPERSEDED
  status: text("status").notNull().default("DRAFT"),
  riskDisclosureVersion: text("risk_disclosure_version"),
  riskDisclosureAcceptedAt: timestamp("risk_disclosure_accepted_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  reviewedByAdminId: integer("reviewed_by_admin_id"),
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  userIdx: index("investor_alloc_pref_user_idx").on(t.userId),
  statusIdx: index("investor_alloc_pref_status_idx").on(t.status),
}));
export const insertInvestorAllocationPreferenceSchema = createInsertSchema(
  investorAllocationPreferencesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInvestorAllocationPreference = z.infer<
  typeof insertInvestorAllocationPreferenceSchema
>;
export type InvestorAllocationPreference =
  typeof investorAllocationPreferencesTable.$inferSelect;

// ── 4. Admin-configured strategy profiles ───────────────────────────────────
// Global presets (one row per profileKey) that define the default sleeve split
// for CONSERVATIVE / BALANCED / AGGRESSIVE. Admin-editable; investors pick a
// preset (server fills the split) or CUSTOM (investor supplies the split).
export const investorStrategyProfilesTable = pgTable("investor_strategy_profiles", {
  id: serial("id").primaryKey(),
  // CONSERVATIVE | BALANCED | AGGRESSIVE
  profileKey: text("profile_key").notNull(),
  label: text("label").notNull(),
  description: text("description"),
  conservativePct: integer("conservative_pct").notNull().default(0),
  balancedPct: integer("balanced_pct").notNull().default(0),
  aggressivePct: integer("aggressive_pct").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  updatedByAdminId: integer("updated_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (t) => ({
  keyUidx: uniqueIndex("investor_strategy_profiles_key_uidx").on(t.profileKey),
}));
export const insertInvestorStrategyProfileSchema = createInsertSchema(
  investorStrategyProfilesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInvestorStrategyProfile = z.infer<
  typeof insertInvestorStrategyProfileSchema
>;
export type InvestorStrategyProfile = typeof investorStrategyProfilesTable.$inferSelect;

// ── 5. Investor allocation settings (singleton) ─────────────────────────────
// Single-row global config for the max-aggressive cap and the current
// risk-disclosure version investors must acknowledge on submit.
export const investorAllocationSettingsTable = pgTable("investor_allocation_settings", {
  id: serial("id").primaryKey(),
  maxAggressivePct: integer("max_aggressive_pct").notNull().default(50),
  riskDisclosureVersion: text("risk_disclosure_version").notNull().default("v1"),
  updatedByAdminId: integer("updated_by_admin_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
export type InvestorAllocationSettings =
  typeof investorAllocationSettingsTable.$inferSelect;

// ── 6. Investor statements / documents ──────────────────────────────────────
// Statements and documents made available to an investor. Read-only to the
// investor; rows are created by admins/system. No file blobs here — a
// reference/summary only.
export const investorStatementsTable = pgTable("investor_statements", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  title: text("title").notNull(),
  periodLabel: text("period_label"),
  // STATEMENT | AGREEMENT | TAX | OTHER
  statementType: text("statement_type").notNull().default("STATEMENT"),
  summary: text("summary"),
  // Optional external reference to a file or link (e.g. an object-storage URL
  // or a shared document URL). No file blobs are stored here.
  fileUrl: text("file_url"),
  // Lifecycle status (Task #101 — statement-change transparency). A statement is
  // NEVER silently changed or hard-deleted; every status change is reasoned,
  // audited, and surfaced to the investor.
  //   ACTIVE | CORRECTED | REPLACED | REMOVED | SUPERSEDED | DRAFT | PENDING_REVIEW
  // ACTIVE/CORRECTED are current + downloadable. REMOVED disables download.
  // REPLACED/SUPERSEDED are no longer current (a newer version exists).
  // DRAFT/PENDING_REVIEW are internal work-in-progress (hidden from investors).
  status: text("status").notNull().default("ACTIVE"),
  // Plain-English reason captured on the LAST status change (mirrored from the
  // matching investor_statement_events row for fast reads).
  statusReason: text("status_reason"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
  statusChangedByAdminId: integer("status_changed_by_admin_id"),
  // For REPLACED/SUPERSEDED: the id of the newer statement that replaces this
  // one (always belongs to the SAME investor).
  replacementStatementId: integer("replacement_statement_id"),
  createdByAdminId: integer("created_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Set only when an admin edits this statement's CONTENT (title / period /
  // summary / file) via the edit path — distinct from createdAt (the original
  // publish date) and from statusChangedAt (lifecycle changes). NULL means the
  // statement has never been edited since publish. Surfaced to the investor as
  // an honest "Updated <date>" label so a content change is never silent.
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  userIdx: index("investor_statements_user_idx").on(t.userId),
  createdIdx: index("investor_statements_created_idx").on(t.createdAt),
  statusIdx: index("investor_statements_status_idx").on(t.status),
}));
export const insertInvestorStatementSchema = createInsertSchema(investorStatementsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInvestorStatement = z.infer<typeof insertInvestorStatementSchema>;
export type InvestorStatement = typeof investorStatementsTable.$inferSelect;

// ── 7. Investor statement change events (append-only) ───────────────────────
// Investor-readable transparency record of every statement status change. Unlike
// admin_action_audit_log (admin-only security record), this table is scoped by
// userId and IS surfaced to the investor (Documents notes + Activity feed) so a
// financial record is never changed silently. Append-only: one row per change.
//   action: CORRECT | REPLACE | REMOVE | RESTORE | SUPERSEDE
export const investorStatementEventsTable = pgTable("investor_statement_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  statementId: integer("statement_id").notNull(),
  action: text("action").notNull(),
  previousStatus: text("previous_status"),
  newStatus: text("new_status").notNull(),
  reason: text("reason").notNull(),
  replacementStatementId: integer("replacement_statement_id"),
  createdByAdminId: integer("created_by_admin_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("investor_statement_events_user_idx").on(t.userId),
  statementIdx: index("investor_statement_events_statement_idx").on(t.statementId),
  createdIdx: index("investor_statement_events_created_idx").on(t.createdAt),
}));
export const insertInvestorStatementEventSchema = createInsertSchema(
  investorStatementEventsTable,
).omit({ id: true, createdAt: true });
export type InsertInvestorStatementEvent = z.infer<typeof insertInvestorStatementEventSchema>;
export type InvestorStatementEvent = typeof investorStatementEventsTable.$inferSelect;

// ── 8. Investor bulk-performance batches (Task #107) ────────────────────────
// One row per bulk PERFORMANCE post. A bulk post (Task #86) writes one
// PERFORMANCE ledger row per investor; this table groups those rows under a
// stable `batchId` so admins can list "what was posted in this batch" (period
// label, mode, figure, who/when, posted/skipped/failed counts) and reverse the
// whole batch in one action. A reversal NEVER hard-deletes the append-only
// ledger: it writes new, individually-attributed offsetting PERFORMANCE rows
// (each carrying the reversal batch's id) and is recorded here as its own
// `isReversal` batch, while the original batch is flipped to REVERSED.
export const investorPerformanceBatchesTable = pgTable("investor_performance_batches", {
  id: serial("id").primaryKey(),
  // Stable, externally-referenced id (uuid). Unique so a reversal can be claimed
  // exactly-once against the original.
  batchId: text("batch_id").notNull(),
  periodLabel: text("period_label").notNull(),
  // FIXED | PRO_RATA
  mode: text("mode").notNull(),
  // The figure (FIXED) or percent (PRO_RATA) the admin entered for the post.
  value: doublePrecision("value").notNull(),
  // Currency override requested for the post (NULL = each investor's base ccy).
  currency: text("currency"),
  // The admin's plain reason (un-folded; the per-row ledger reason folds in the
  // period label).
  reason: text("reason").notNull(),
  postedCount: integer("posted_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  // ACTIVE | REVERSED. A reversal batch stays ACTIVE (it cannot itself be
  // reversed — guarded by isReversal).
  status: text("status").notNull().default("ACTIVE"),
  // True for the batch that offsets another batch.
  isReversal: boolean("is_reversal").notNull().default(false),
  // For a reversal batch: the original batchId it offsets.
  reversesBatchId: text("reverses_batch_id"),
  // For an original batch once reversed: the reversal batchId, who, and when.
  reversedByBatchId: text("reversed_by_batch_id"),
  reversedByAdminId: integer("reversed_by_admin_id"),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  createdByAdminId: integer("created_by_admin_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  batchUidx: uniqueIndex("investor_perf_batches_batch_uidx").on(t.batchId),
  createdIdx: index("investor_perf_batches_created_idx").on(t.createdAt),
  statusIdx: index("investor_perf_batches_status_idx").on(t.status),
}));
export const insertInvestorPerformanceBatchSchema = createInsertSchema(
  investorPerformanceBatchesTable,
).omit({ id: true, createdAt: true });
export type InsertInvestorPerformanceBatch = z.infer<
  typeof insertInvestorPerformanceBatchSchema
>;
export type InvestorPerformanceBatch = typeof investorPerformanceBatchesTable.$inferSelect;
