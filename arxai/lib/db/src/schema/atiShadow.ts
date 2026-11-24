import { bigint, doublePrecision, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const atiDerivQuoteFramesTable = pgTable("ati_deriv_quote_frames", {
  streamId: uuid("stream_id").notNull(),
  symbol: text("symbol").notNull(),
  epoch: bigint("epoch", { mode: "number" }).notNull(),
  receivedAt: bigint("received_at_ms", { mode: "number" }).notNull(),
  releasedAt: bigint("released_at_ms", { mode: "number" }).notNull(),
  bid: doublePrecision("bid"),
  ask: doublePrecision("ask"),
}, (t) => ({
  frameId: primaryKey({ columns: [t.streamId, t.symbol, t.epoch] }),
  symbolEpoch: index("ati_deriv_quote_frames_symbol_epoch_idx").on(t.symbol, t.epoch),
}));

export const atiShadowRunsTable = pgTable("ati_shadow_runs", {
  id: uuid("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  agentId: integer("agent_id").notNull(),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  setup: text("setup").notNull(),
  baselineVersion: text("baseline_version").notNull(),
  challengerVersion: text("challenger_version").notNull(),
  assumedCosts: jsonb("assumed_costs"),
  measuredCostProfile: jsonb("measured_cost_profile"),
  researchSource: text("research_source").$type<"deriv_public" | "mt5_broker">(),
  researchMode: text("research_mode").$type<"DEMO" | "LIVE">(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
}, (t) => ({
  ownerAgent: index("ati_shadow_runs_owner_agent_idx").on(t.ownerId, t.agentId),
}));

export const atiShadowObservationsTable = pgTable("ati_shadow_observations", {
  runId: uuid("run_id").notNull().references(() => atiShadowRunsTable.id, { onDelete: "cascade" }),
  observationKey: text("observation_key").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).default(sql`clock_timestamp()`),
  sourceIdentity: text("source_identity"),
  coverage: text("coverage").notNull(),
  setup: text("setup").notNull(),
  baselineOutcome: text("baseline_outcome").notNull(),
  challengerOutcome: text("challenger_outcome").notNull(),
  evidence: jsonb("evidence").notNull(),
}, (t) => ({
  observationId: primaryKey({ columns: [t.runId, t.observationKey] }),
}));

export const atiShadowOutcomesTable = pgTable("ati_shadow_outcomes", {
  runId: uuid("run_id").notNull(),
  observationKey: text("observation_key").notNull(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).default(sql`clock_timestamp()`),
  gradeVersion: text("grade_version").notNull(),
  evidence: jsonb("evidence").notNull(),
}, (t) => ({
  outcomeId: primaryKey({ columns: [t.runId, t.observationKey] }),
  observation: foreignKey({
    columns: [t.runId, t.observationKey],
    foreignColumns: [atiShadowObservationsTable.runId, atiShadowObservationsTable.observationKey],
  }).onDelete("cascade"),
}));

export const atiResearchStudiesTable = pgTable("ati_research_studies", {
  runId: uuid("run_id").primaryKey().references(() => atiShadowRunsTable.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id").notNull(),
  agentId: integer("agent_id").notNull(),
  requestId: uuid("request_id").notNull(),
  registration: text("registration").notNull(),
  registrationHash: text("registration_hash").notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
}, (t) => ({
  ownerRequest: unique("ati_research_owner_request").on(t.ownerId, t.agentId, t.requestId),
}));

export const atiResearchSealsTable = pgTable("ati_research_seals", {
  runId: uuid("run_id").primaryKey().references(() => atiResearchStudiesTable.runId, { onDelete: "cascade" }),
  dataset: text("dataset").notNull(),
  datasetHash: text("dataset_hash").notNull(),
  resultHash: text("result_hash").notNull(),
  verdict: text("verdict").$type<"INSUFFICIENT_EVIDENCE" | "REJECTED" | "FORWARD_REVIEW_REQUIRED">().notNull(),
  sealedAt: timestamp("sealed_at", { withTimezone: true }).notNull(),
});
