import { pgTable, uuid, integer, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** Append-only research evidence, NOT the legacy backtest money ledger.
 * Migration supplies CHECKs, immutable-row triggers and owner storage limits.
 * Do not use schema push as a substitute for that migration. */
export const researchExperimentsTable = pgTable("research_experiments_v1", {
  id: uuid("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  requestId: uuid("request_id").notNull(),
  datasetId: uuid("dataset_id").notNull(),
  manifestVersion: text("manifest_version").notNull(),
  engineVersion: text("engine_version").notNull(),
  strategyVersion: text("strategy_version").notNull(),
  inputHash: text("input_hash").notNull(),
  configurationHash: text("configuration_hash").notNull(),
  strategyHash: text("strategy_hash").notNull(),
  resultHash: text("result_hash").notNull(),
  payloadHash: text("payload_hash").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  inputBars: integer("input_bars").notNull(),
  payloadBytes: integer("payload_bytes").notNull(),
  // Text preserves the exact canonical serialization, including numeric bytes.
  canonicalPayload: text("canonical_payload").notNull(),
  canonicalManifest: text("canonical_manifest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, t => ({
  ownerRequest: uniqueIndex("research_experiments_v1_owner_request_uq").on(t.ownerId, t.requestId),
  ownerPage: index("research_experiments_v1_owner_page_idx").on(t.ownerId, t.createdAt.desc(), t.id.desc()),
}));
