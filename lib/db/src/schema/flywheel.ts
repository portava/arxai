// THE LEARNING FLYWHEEL (Master Build Plan B0–B7) — SHADOW-ONLY machinery.
//
// WHAT THESE TABLES ARE: the flywheel's evidence spine. Case files (B0) tie a
// trade's before/during/after records together with provenance stamps; rewards
// (B1) are broker-reconciled net log-returns derived ONLY from the economic
// postings ledger; posteriors (B2) are per-cohort Bayesian summaries of those
// rewards; the allocation journal (B3) records the bandit's SHADOW allocation
// intentions; OPE reports (B6) are advisory counterfactual records over
// declined drafts; cohort outcomes (B7) are the anonymized cross-tenant
// aggregate ledger.
//
// WHAT THESE TABLES ARE NOT (inviolable — the FLYWHEEL INVARIANT):
//   Nothing in this file, and nothing that writes or reads these tables, is
//   consulted by any gate, floor, stop, sizing, or dispatch path. Learning may
//   only influence ALLOCATION, and while no edge is owner-promoted the
//   allocation weights journaled here are records, not instructions —
//   kellyCapGovernor already holds size at EXACTLY 0 without a measured
//   edge_OOS, and no apply path exists (pinned by
//   scripts/src/ci/check-flywheel-isolation.test.ts).
//
// APPEND-ONLY: flywheel_allocation_journal and flywheel_ope_reports are
// journals — no UPDATE/DELETE anywhere (enforced by check-vault-mutations.ts,
// same discipline as economic_postings). Case files, rewards, posteriors and
// cohort outcomes are recomputable assemblies keyed by natural ids.
//
// PRIVACY (B7, same rules as globalLearning.ts): flywheel_cohort_outcomes
// carries NO user identity — not a userId column, not one inside jsonb. Only
// dimensionless aggregated statistics (net log-returns, counts) are stored,
// only from opted-in users (user_privacy_settings.contribute_to_global_learning),
// and stats are NULLED below the k-anonymity floor, not merely flagged.

import {
  pgTable, serial, integer, bigint, text, boolean, doublePrecision,
  timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ── B0 — Case files: per-trade before/during/after evidence records ─────────
export const flywheelCaseFilesTable = pgTable("flywheel_case_files", {
  id: serial("id").primaryKey(),
  /** Stable external id — cf_<draftId>; one case file per mission trade draft. */
  caseId: text("case_id").notNull(),
  userId: integer("user_id").notNull(),
  missionId: integer("mission_id"),
  /** Strategy attribution (the draft's agentKey). */
  strategyId: text("strategy_id").notNull(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(),
  /** Honest regime label at draft time; "UNKNOWN" when nothing recorded one. */
  regimeLabel: text("regime_label").notNull().default("UNKNOWN"),
  /** Assembly high-water mark: DRAFTED | DISPATCHED | CLOSED | RECONCILED. */
  phase: text("phase").notNull().default("DRAFTED"),
  /** BEFORE: the draft's own plan (entry/stop/target/risk), verbatim. */
  beforeJson: jsonb("before_json").notNull().default({}),
  /** DURING: dispatch/fill evidence (commandId, brokerTicket, status). */
  duringJson: jsonb("during_json").notNull().default({}),
  /** AFTER: exit record + economic-posting journal ids. */
  afterJson: jsonb("after_json").notNull().default({}),
  /** Per-section provenance stamps: {section: {source, recordedAt}}. */
  provenanceJson: jsonb("provenance_json").notNull().default({}),
  /** FULL when every section has evidence; PARTIAL otherwise. */
  completeness: text("completeness").notNull().default("PARTIAL"),
  /** Honest list of evidence the assembler could NOT find (never fabricated). */
  missingJson: jsonb("missing_json").notNull().default([]),
  commandId: text("command_id"),
  brokerTicket: text("broker_ticket"),
  /** LIVE | DEMO | null when the ledger partition is not yet known. */
  ledger: text("ledger"),
  assembledAt: timestamp("assembled_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseUx: uniqueIndex("flywheel_case_files_case_ux").on(t.caseId),
  userIdx: index("flywheel_case_files_user_idx").on(t.userId),
  phaseIdx: index("flywheel_case_files_phase_idx").on(t.phase),
  strategyIdx: index("flywheel_case_files_strategy_idx").on(t.strategyId),
}));

export type FlywheelCaseFileRow = typeof flywheelCaseFilesTable.$inferSelect;
export type NewFlywheelCaseFile = typeof flywheelCaseFilesTable.$inferInsert;

// ── B1 — Rewards: broker-reconciled net log-returns (or honest UNRECONCILED) ─
export const flywheelRewardsTable = pgTable("flywheel_rewards", {
  id: serial("id").primaryKey(),
  /** rw_<caseId> — recomputable (a posting correction re-derives the reward). */
  rewardId: text("reward_id").notNull(),
  caseId: text("case_id").notNull(),
  userId: integer("user_id").notNull(),
  ledger: text("ledger").notNull(),
  strategyId: text("strategy_id").notNull(),
  regimeLabel: text("regime_label").notNull().default("UNKNOWN"),
  instrument: text("instrument").notNull(),
  /** RECONCILED | UNRECONCILED — UNRECONCILED rewards are EXCLUDED downstream. */
  status: text("status").notNull(),
  /** ln(1 + netPnl/equityBase); null exactly when status=UNRECONCILED. */
  netLogReturn: doublePrecision("net_log_return"),
  /** Net P&L (pnl − fees − funding) in minor units, from postings only. */
  netPnlMinor: bigint("net_pnl_minor", { mode: "bigint" }),
  /** Denominator: broker-reconciled equity base at the trade's close. */
  equityBaseMinor: bigint("equity_base_minor", { mode: "bigint" }),
  currency: text("currency"),
  scale: integer("scale"),
  /** The exact economic-posting journal ids this reward derives from. */
  journalIdsJson: jsonb("journal_ids_json").notNull().default([]),
  /** Machine reasons (UNKNOWN_FEES, NO_EQUITY_BASE, …) — the honesty trail. */
  reasonsJson: jsonb("reasons_json").notNull().default([]),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  rewardUx: uniqueIndex("flywheel_rewards_reward_ux").on(t.rewardId),
  cohortIdx: index("flywheel_rewards_cohort_idx").on(t.strategyId, t.regimeLabel, t.instrument),
  statusIdx: index("flywheel_rewards_status_idx").on(t.status),
  userIdx: index("flywheel_rewards_user_idx").on(t.userId),
}));

export type FlywheelRewardRow = typeof flywheelRewardsTable.$inferSelect;
export type NewFlywheelReward = typeof flywheelRewardsTable.$inferInsert;

// ── B2 — Cohort posteriors: Normal-Inverse-Gamma per strategy×regime×instrument ─
export const flywheelPosteriorsTable = pgTable("flywheel_posteriors", {
  id: serial("id").primaryKey(),
  /** `${strategyId}|${regimeLabel}|${instrument}`. */
  cohortKey: text("cohort_key").notNull(),
  strategyId: text("strategy_id").notNull(),
  regimeLabel: text("regime_label").notNull(),
  instrument: text("instrument").notNull(),
  /** NIG parameters (mu, kappa, alpha, beta) after the conjugate update. */
  mu: doublePrecision("mu").notNull(),
  kappa: doublePrecision("kappa").notNull(),
  alpha: doublePrecision("alpha").notNull(),
  beta: doublePrecision("beta").notNull(),
  /** RECONCILED rewards folded in (UNRECONCILED are never counted). */
  sampleCount: integer("sample_count").notNull().default(0),
  /** OK | INSUFFICIENT_SAMPLE — below the floor the posterior grants nothing. */
  status: text("status").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cohortUx: uniqueIndex("flywheel_posteriors_cohort_ux").on(t.cohortKey),
  strategyIdx: index("flywheel_posteriors_strategy_idx").on(t.strategyId),
}));

export type FlywheelPosteriorRow = typeof flywheelPosteriorsTable.$inferSelect;
export type NewFlywheelPosterior = typeof flywheelPosteriorsTable.$inferInsert;

// ── B3 — SHADOW allocation journal (APPEND-ONLY; records, never instructions) ─
export const flywheelAllocationJournalTable = pgTable("flywheel_allocation_journal", {
  id: serial("id").primaryKey(),
  passId: text("pass_id").notNull(),
  /** Always "SHADOW" — there is deliberately no other value and no apply path. */
  mode: text("mode").notNull().default("SHADOW"),
  /** Always "NONE" — same honesty stamp as draftCounterfactual. */
  authority: text("authority").notNull().default("NONE"),
  /** Per-arm records: weight, hypotheticalWeight, sampledMean, reasons. */
  weightsJson: jsonb("weights_json").notNull(),
  /** Clamp provenance (gate #20/#21 semantics applied, caps, normalization). */
  clampJson: jsonb("clamp_json").notNull().default({}),
  /** Decay events observed this pass (B4/B5). */
  decayJson: jsonb("decay_json").notNull().default([]),
  posteriorsUsed: integer("posteriors_used").notNull().default(0),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  passIdx: index("flywheel_allocation_journal_pass_idx").on(t.passId),
  computedIdx: index("flywheel_allocation_journal_computed_idx").on(t.computedAt),
}));

export type FlywheelAllocationJournalRow = typeof flywheelAllocationJournalTable.$inferSelect;
export type NewFlywheelAllocationJournal = typeof flywheelAllocationJournalTable.$inferInsert;

// ── B6 — OPE reports over declined/rejected drafts (APPEND-ONLY, advisory) ───
export const flywheelOpeReportsTable = pgTable("flywheel_ope_reports", {
  id: serial("id").primaryKey(),
  reportId: text("report_id").notNull(),
  passId: text("pass_id").notNull(),
  /** What was evaluated (e.g. "declined_drafts"). */
  scope: text("scope").notNull(),
  advisory: boolean("advisory").notNull().default(true),
  /** Aggregate estimate + honest resolution accounting. */
  estimateJson: jsonb("estimate_json").notNull(),
  /** Per-record advisory rows (bounded counterfactuals, cost-netted). */
  recordsJson: jsonb("records_json").notNull().default([]),
  reasonsJson: jsonb("reasons_json").notNull().default([]),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reportUx: uniqueIndex("flywheel_ope_reports_report_ux").on(t.reportId),
  passIdx: index("flywheel_ope_reports_pass_idx").on(t.passId),
}));

export type FlywheelOpeReportRow = typeof flywheelOpeReportsTable.$inferSelect;
export type NewFlywheelOpeReport = typeof flywheelOpeReportsTable.$inferInsert;

// ── B7 — Cross-tenant cohort outcome ledger (anonymized aggregates ONLY) ─────
export const flywheelCohortOutcomesTable = pgTable("flywheel_cohort_outcomes", {
  id: serial("id").primaryKey(),
  cohortKey: text("cohort_key").notNull(),
  strategyId: text("strategy_id").notNull(),
  regimeLabel: text("regime_label").notNull(),
  instrument: text("instrument").notNull(),
  /** DISTINCT opted-in contributors (counted, never named). */
  contributorCount: integer("contributor_count").notNull().default(0),
  sampleCount: integer("sample_count").notNull().default(0),
  /** NULL below the k-anonymity floor — stats are withheld, not just flagged. */
  meanNetLogReturn: doublePrecision("mean_net_log_return"),
  varNetLogReturn: doublePrecision("var_net_log_return"),
  isSurfaceable: boolean("is_surfaceable").notNull().default(false),
  lastAggregatedAt: timestamp("last_aggregated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cohortUx: uniqueIndex("flywheel_cohort_outcomes_cohort_ux").on(t.cohortKey),
  surfaceIdx: index("flywheel_cohort_outcomes_surface_idx").on(t.isSurfaceable),
}));

export type FlywheelCohortOutcomeRow = typeof flywheelCohortOutcomesTable.$inferSelect;
export type NewFlywheelCohortOutcome = typeof flywheelCohortOutcomesTable.$inferInsert;
