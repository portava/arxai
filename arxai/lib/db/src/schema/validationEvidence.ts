import { pgTable, uuid, integer, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

/** Append-only real-data validation evidence (scripts/src/research/realDataValidation.ts).
 * lib/db/migrations/2026-11-09_validation_evidence_v1.sql supplies the CHECKs
 * (hash re-derivation, live_allowed = false, ceiling = SHADOW) and the
 * immutable-row triggers. Schema push alone does NOT create those; the
 * migration is idempotent and re-attaches them over a pushed table. */
export const validationEvidenceTable = pgTable("validation_evidence_v1", {
  id: uuid("id").primaryKey(),
  runKind: text("run_kind").notNull(),
  runnerVersion: text("runner_version").notNull(),
  datasetSource: text("dataset_source").notNull(),
  datasetHash: text("dataset_hash").notNull(),
  paramsHash: text("params_hash").notNull(),
  resultHash: text("result_hash").notNull(),
  codeCommit: text("code_commit").notNull(),
  codeDirty: boolean("code_dirty").notNull(),
  trials: integer("trials").notNull(),
  survivors: integer("survivors").notNull(),
  promotionCeiling: text("promotion_ceiling").notNull(),
  liveAllowed: boolean("live_allowed").notNull().default(false),
  payloadHash: text("payload_hash").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  payloadBytes: integer("payload_bytes").notNull(),
  canonicalPayload: text("canonical_payload").notNull(),
  canonicalManifest: text("canonical_manifest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, t => ({
  identity: uniqueIndex("validation_evidence_v1_identity_uq").on(t.datasetHash, t.paramsHash, t.resultHash, t.codeCommit, t.codeDirty),
  page: index("validation_evidence_v1_page_idx").on(t.createdAt.desc(), t.id.desc()),
}));
