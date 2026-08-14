// AACI Learning, Trust & Drift — persistence (Task #232, Phase 6).
//
// Three append-friendly tables backing the adaptive learning layer:
//   1. aaci_trust_scores    — per-entity Bayesian trust (alpha/beta, 0.50 prior)
//                             + confidence-quarantine state + version.
//   2. aaci_learning_audit  — append-only log of EVERY learning change with
//                             old/new value, reason, evidence, confidence,
//                             permission level, status, and rollback metadata.
//   3. aaci_adaptive_weights — clamped learned weights with version/rollback.
//
// SAFETY / honesty:
// - ADVISORY ONLY. None of this is an execution gate; it shapes the AACI
//   learnedTrust (L) and drift (D) sub-scores and queues recommendations.
// - Learning is bounded: weights clamped [W_MIN, W_MAX]; the safety penalty λ
//   exceeds the learning rate η (enforced in lib/domain/aaci/learning.ts).
// - Major behavior changes are persisted RECOMMEND_ONLY and require admin
//   approval before they apply — learning never auto-loosens a limit.
// - Trust updates only on REAL reconciled evidence; the audit's sourceRef makes
//   ingestion idempotent. Rows are evidence and are never auto-deleted.

import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Entities whose trust AACI tracks (module/agent/signal/strategy/symbol/…).
export const AACI_TRUST_ENTITY_TYPES = [
  "module",
  "agent",
  "signal",
  "strategy",
  "symbol",
  "session",
  "timeframe",
] as const;
export type AaciTrustEntityType = (typeof AACI_TRUST_ENTITY_TYPES)[number];

// ── 1. Trust scores ─────────────────────────────────────────────────────────
export const aaciTrustScoresTable = pgTable(
  "aaci_trust_scores",
  {
    id: serial("id").primaryKey(),
    entityType: text("entity_type").notNull(), // AaciTrustEntityType
    entityKey: text("entity_key").notNull(), // e.g. "flame_scalp" | "EURUSD" | "agent:7"
    // Owning scope. 0 = global/system trust; a positive id = per-user trust.
    // NOT NULL with a 0 sentinel so the unique index below is deterministic
    // (Postgres treats NULL as distinct, which would allow duplicate globals).
    userId: integer("user_id").notNull().default(0),

    // Bayesian Beta(alpha, beta). Neutral prior alpha = beta = 1 → mean 0.5.
    alpha: doublePrecision("alpha").notNull().default(1),
    beta: doublePrecision("beta").notNull().default(1),
    // Effective observations folded in (priors removed) — minimum-evidence rule.
    evidenceCount: integer("evidence_count").notNull().default(0),

    // Confidence quarantine — an unreliable module excluded from decision trust.
    quarantined: boolean("quarantined").notNull().default(false),
    quarantineReason: text("quarantine_reason"),

    // Most recent drift verdict for this entity (advisory).
    driftSeverity: text("drift_severity"), // NONE | MINOR | MAJOR | SEVERE
    driftScore: doublePrecision("drift_score"), // 0..100, high = stable

    // Regime tag the current evidence was learned under (for regime reset).
    regimeTag: text("regime_tag"),

    version: integer("version").notNull().default(1),
    lastOutcomeAt: timestamp("last_outcome_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("aaci_trust_entity_scope_uq").on(t.entityType, t.entityKey, t.userId),
    index("aaci_trust_entity_idx").on(t.entityType, t.entityKey),
    index("aaci_trust_quarantined_idx").on(t.quarantined),
  ],
);

// ── 2. Learning audit (append-only) ─────────────────────────────────────────
export const AACI_LEARNING_CHANGE_TYPES = [
  // minor (may auto-apply, clamped, with evidence)
  "TRUST_UPDATE",
  "REDUCE_TRUST",
  "RAISE_THRESHOLD",
  "REDUCE_LOT",
  "TIGHTEN_COOLDOWN",
  "TIGHTEN_LOSS_LIMIT",
  "QUARANTINE",
  "UNQUARANTINE",
  "REGIME_RESET",
  "WATCH_MODE",
  "WEIGHT_UPDATE",
  // major (recommend-only — admin approval required)
  "RAISE_ALLOCATION",
  "RAISE_LOT",
  "ADD_SYMBOL",
  "RAISE_TRADE_CAP",
  "ENABLE_NEWS_TRADING",
  "PROMOTE_AUTONOMY",
  "LOOSEN_LOSS_LIMIT",
  "LOOSEN_COOLDOWN",
  // lifecycle
  "DRIFT_RECOMMENDATION",
  "ROLLBACK",
] as const;
export type AaciLearningChangeType = (typeof AACI_LEARNING_CHANGE_TYPES)[number];

export const AACI_LEARNING_STATUSES = [
  "APPLIED",
  "RECOMMENDED",
  "APPROVED",
  "REJECTED",
  "ROLLED_BACK",
] as const;
export type AaciLearningStatus = (typeof AACI_LEARNING_STATUSES)[number];

export const aaciLearningAuditTable = pgTable(
  "aaci_learning_audit",
  {
    id: serial("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityKey: text("entity_key").notNull(),
    userId: integer("user_id").notNull().default(0), // 0 = global/system scope

    changeType: text("change_type").notNull(), // AaciLearningChangeType
    permissionLevel: text("permission_level").notNull(), // AUTO | RECOMMEND_ONLY
    status: text("status").notNull(), // AaciLearningStatus

    oldValue: jsonb("old_value").notNull().default({}),
    newValue: jsonb("new_value").notNull().default({}),
    reason: text("reason").notNull(),

    evidenceCount: integer("evidence_count").notNull().default(0),
    confidence: doublePrecision("confidence").notNull().default(0), // 0..1

    // Idempotency: the real-evidence source that produced this change
    // (e.g. "exec:1234"). Unique while present so re-ingestion is a no-op.
    sourceRef: text("source_ref"),

    // Rollback graph: a ROLLBACK row points at the audit row it reverts.
    rollbackOfId: integer("rollback_of_id"),

    actorUserId: integer("actor_user_id"),
    actorRole: text("actor_role"),
    approvedByUserId: integer("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("aaci_learning_audit_entity_idx").on(t.entityType, t.entityKey),
    index("aaci_learning_audit_status_idx").on(t.status),
    index("aaci_learning_audit_created_idx").on(t.createdAt),
    // Idempotent ingestion: at most one change row per (entity, scope) per
    // real-evidence source, so re-running outcome ingestion is a no-op while a
    // single execution can still update several entity dimensions.
    uniqueIndex("aaci_learning_audit_source_uq")
      .on(t.entityType, t.entityKey, t.userId, t.sourceRef)
      .where(sql`source_ref is not null`),
  ],
);

// ── 3. Adaptive weights ─────────────────────────────────────────────────────
export const aaciAdaptiveWeightsTable = pgTable(
  "aaci_adaptive_weights",
  {
    id: serial("id").primaryKey(),
    weightKey: text("weight_key").notNull(), // e.g. component "L" or "agent:7:flame_scalp"
    userId: integer("user_id").notNull().default(0), // 0 = global/system scope

    // Clamped to [W_MIN, W_MAX] by the domain math. Neutral base = 1.0.
    value: doublePrecision("value").notNull().default(1),
    baseValue: doublePrecision("base_value").notNull().default(1),

    version: integer("version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    supersededBy: integer("superseded_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("aaci_weight_key_scope_uq").on(t.weightKey, t.userId),
    index("aaci_weight_active_idx").on(t.isActive),
  ],
);

// ── Types ───────────────────────────────────────────────────────────────────
export type AaciTrustScoreRow = typeof aaciTrustScoresTable.$inferSelect;
export type NewAaciTrustScoreRow = typeof aaciTrustScoresTable.$inferInsert;
export type AaciLearningAuditRow = typeof aaciLearningAuditTable.$inferSelect;
export type NewAaciLearningAuditRow = typeof aaciLearningAuditTable.$inferInsert;
export type AaciAdaptiveWeightRow = typeof aaciAdaptiveWeightsTable.$inferSelect;
export type NewAaciAdaptiveWeightRow = typeof aaciAdaptiveWeightsTable.$inferInsert;
