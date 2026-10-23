import {
  pgTable, bigserial, serial, text, jsonb, boolean, integer, real, timestamp,
  index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── Discovery pipeline — the anti-fabrication spine ────────────────────────
//
// WHY PRE-REGISTRATION IS THE WHOLE DESIGN
// ----------------------------------------
// The way a research process lies is almost never by falsifying a number. It is
// by deciding, after seeing the results, what it had been looking for all along:
// the horizon that happened to work, the parameter range that happened to
// contain the winner, the instrument that happened to cooperate. Nothing about
// that is detectable from the final report, because the final report is
// internally consistent.
//
// `prereg_hash` + `created_tx` make it detectable. A hypothesis and its full
// parameter set are inserted BEFORE any metric exists, hashed, and stamped with
// a monotonic `bigserial`. Every trial then references the hypothesis it came
// from. A hypothesis registered after its results therefore carries a higher
// `created_tx` than the trials that supposedly tested it, which is a
// contradiction visible in the table itself rather than a matter of trust.
//
// WHY THESE TABLES ARE APPEND-ONLY
// --------------------------------
// A rejected hypothesis is evidence. Deleting it is how a search of 200 ideas
// becomes a report about the 3 that worked, and the multiple-testing correction
// silently loses the denominator that makes it meaningful. Nothing here is ever
// deleted or updated in place; `status` transitions are new rows elsewhere.
//
// INERT BY CONSTRUCTION
// ---------------------
// The pipeline's terminal output is a CANDIDATE, never a promotion. It writes a
// `learning_model_versions` row at the DATA/WALK_FORWARD stage with
// `liveAllowed=false`, `shadowValidated=false`, `adminApproved=false` — the
// existing registry's own gates, unchanged and unweakened. Nothing in this
// pipeline can set any of them; reaching live still requires the human SHADOW
// and ADMIN stages, which are out of scope here. It builds ON
// `learningModelVersionsTable` rather than duplicating it.

/**
 * A pre-registered hypothesis. Inserted BEFORE any metric exists.
 *
 * `prereg_hash` is UNIQUE, so the same hypothesis cannot be quietly registered
 * twice with different wording once the results are known.
 */
export const discoveryHypothesesTable = pgTable("discovery_hypotheses", {
  id: serial("id").primaryKey(),
  /** Monotonic insertion order — the anti-backdating clock. */
  createdTx: bigserial("created_tx", { mode: "bigint" }).notNull(),
  /** sha256 over the canonical spec. UNIQUE: one registration per hypothesis. */
  preregHash: text("prereg_hash").notNull().unique(),
  /** The full pre-registered specification: instrument, rule, params, metric. */
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
  /** Label horizon in bars — pre-registered, so it cannot be tuned afterwards. */
  horizon: integer("horizon").notNull(),
  /** Groups trials into ONE FDR family. */
  familyKey: text("family_key").notNull(),
  /** REGISTERED | TESTED | REJECTED | CERTIFIED */
  status: text("status").notNull().default("REGISTERED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byFamily: index("discovery_hypotheses_family_idx").on(t.familyKey),
  byStatus: index("discovery_hypotheses_status_idx").on(t.status),
  byTx: index("discovery_hypotheses_tx_idx").on(t.createdTx),
}));

/**
 * One trial: a hypothesis at one parameter setting, with its metrics.
 *
 * `is_niche_selection` is the column that stops the most common understatement
 * of multiplicity. Choosing WHICH instrument, session, or regime to look at is
 * itself a search over alternatives, and it is almost never counted — a
 * researcher who tried twelve instruments and reports the parameter sweep on one
 * of them has performed twelve times as many tests as their correction assumes.
 * Niche-selection trials are recorded as trials and, per
 * `discovery_validation_reports.family_size`, are charged EXACTLY like parameter
 * trials.
 */
export const discoveryTrialsTable = pgTable("discovery_trials", {
  id: serial("id").primaryKey(),
  createdTx: bigserial("created_tx", { mode: "bigint" }).notNull(),
  hypothesisId: integer("hypothesis_id").notNull(),
  /** True when this trial was a choice of WHERE to look, not of a parameter. */
  isNicheSelection: boolean("is_niche_selection").notNull().default(false),
  params: jsonb("params").$type<Record<string, unknown>>().notNull(),
  /** In-sample metrics. */
  isMetrics: jsonb("is_metrics").$type<Record<string, unknown>>().notNull().default({}),
  /** Out-of-sample metrics, from purged combinatorial CV. */
  oosMetrics: jsonb("oos_metrics").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byHypothesis: index("discovery_trials_hypothesis_idx").on(t.hypothesisId),
  byNiche: index("discovery_trials_niche_idx").on(t.isNicheSelection),
  byTx: index("discovery_trials_tx_idx").on(t.createdTx),
}));

/**
 * The family-level validation record.
 *
 * `family_size` is `m` in Benjamini–Hochberg and MUST include niche-selection
 * trials. It is stored rather than recomputed so the correction that was
 * actually applied is on the record — a later recount cannot quietly shrink the
 * denominator.
 */
export const discoveryValidationReportsTable = pgTable("discovery_validation_reports", {
  id: serial("id").primaryKey(),
  createdTx: bigserial("created_tx", { mode: "bigint" }).notNull(),
  familyKey: text("family_key").notNull(),
  /** m — the FULL trial count, niche-selection trials INCLUDED. */
  familySize: integer("family_size").notNull(),
  /** The FDR level the family was controlled at. */
  qLevel: real("q_level").notNull(),
  /** How many hypotheses BH rejected (i.e. certified as discoveries). */
  rejections: integer("rejections").notNull(),
  /** The BH threshold p-value; null when nothing was rejected. */
  bhThreshold: real("bh_threshold"),
  /** Per-trial p-values and verdicts, for audit. */
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  /** Chains the report into the Black Box. */
  reportHash: text("report_hash").notNull(),
  prevHash: text("prev_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byFamily: index("discovery_validation_reports_family_idx").on(t.familyKey),
  byHash: uniqueIndex("discovery_validation_reports_hash_idx").on(t.reportHash),
}));

/**
 * An edge CANDIDATE. Never a promotion.
 *
 * `verdict` is PASS or REJECT and is written only by deterministic code. The
 * model never authors a promotion: there is no code path from a model output to
 * a row here, and no column here that can set `live_allowed` on the model
 * registry.
 */
export const edgeCandidatesTable = pgTable("edge_candidates", {
  id: serial("id").primaryKey(),
  createdTx: bigserial("created_tx", { mode: "bigint" }).notNull(),
  hypothesisId: integer("hypothesis_id").notNull(),
  familyKey: text("family_key").notNull(),
  oosDsr: real("oos_dsr"),
  pbo: real("pbo"),
  oosSharpe: real("oos_sharpe"),
  /** Observations accrued in UNRISKED, logged-only shadow. */
  shadowN: integer("shadow_n").notNull().default(0),
  /** The nonzero, unrisked shadow size this candidate accrues evidence at. */
  shadowSize: real("shadow_size").notNull().default(0),
  /** PASS | REJECT */
  verdict: text("verdict").notNull(),
  /** Every veto that fired. Empty only for a PASS. */
  vetoes: jsonb("vetoes").$type<string[]>().notNull().default([]),
  /** `learning_model_versions.version_id` of the INERT candidate row. */
  modelVersionId: text("model_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byHypothesis: index("edge_candidates_hypothesis_idx").on(t.hypothesisId),
  byFamily: index("edge_candidates_family_idx").on(t.familyKey),
  byVerdict: index("edge_candidates_verdict_idx").on(t.verdict),
}));

export const insertDiscoveryHypothesisSchema = createInsertSchema(discoveryHypothesesTable)
  .omit({ id: true, createdTx: true, createdAt: true });
export const insertDiscoveryTrialSchema = createInsertSchema(discoveryTrialsTable)
  .omit({ id: true, createdTx: true, createdAt: true });
export const insertDiscoveryValidationReportSchema =
  createInsertSchema(discoveryValidationReportsTable).omit({ id: true, createdTx: true, createdAt: true });
export const insertEdgeCandidateSchema = createInsertSchema(edgeCandidatesTable)
  .omit({ id: true, createdTx: true, createdAt: true });

export type InsertDiscoveryHypothesis = z.infer<typeof insertDiscoveryHypothesisSchema>;
export type InsertDiscoveryTrial = z.infer<typeof insertDiscoveryTrialSchema>;
export type InsertDiscoveryValidationReport = z.infer<typeof insertDiscoveryValidationReportSchema>;
export type InsertEdgeCandidate = z.infer<typeof insertEdgeCandidateSchema>;

export type DiscoveryHypothesisRow = typeof discoveryHypothesesTable.$inferSelect;
export type DiscoveryTrialRow = typeof discoveryTrialsTable.$inferSelect;
export type DiscoveryValidationReportRow = typeof discoveryValidationReportsTable.$inferSelect;
export type EdgeCandidateRow = typeof edgeCandidatesTable.$inferSelect;

export const HYPOTHESIS_STATUSES = ["REGISTERED", "TESTED", "REJECTED", "CERTIFIED"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
