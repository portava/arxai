// Agent Ecosystem — Learning Camp records (Layer 2).
//
// SAFETY / SCOPE:
//   - OBSERVATION / CORRECTION ONLY. A camp record tracks an agent's retraining
//     through supervised stages. It NEVER places, modifies, or closes a trade
//     and never touches the 16-gate live pipeline. Learning Camp is correction,
//     not deletion (§7).
//
// Constrained text vocabularies (validated in app code, not DB enums):
//   stage        : FAILURE_REVIEW | PATTERN_CORRECTION | REPLAY_TRAINING
//                | SHADOW_MODE | SUPERVISED_RETURN | FULL_RETURN
//                | FURTHER_RESTRICTION
//   returnStatus : IN_PROGRESS | RETURNED_FULL | RETURNED_SUPERVISED
//                | FURTHER_RESTRICTED

import {
  pgTable, serial, integer, text, real, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentLearningCampRecordsTable = pgTable("agent_learning_camp_records", {
  id:               serial("id").primaryKey(),
  recordId:         text("record_id").notNull(),          // stable external id
  agentId:          integer("agent_id").notNull(),        // -> agents.id

  reason:           text("reason").notNull(),
  failurePatterns:  text("failure_patterns").notNull().default("[]"),   // JSON array as text
  correctionRules:  text("correction_rules").notNull().default("[]"),   // JSON array as text
  trainingExamples: text("training_examples").notNull().default("[]"),  // JSON array as text

  stage:            text("stage").notNull().default("FAILURE_REVIEW"),
  returnStatus:     text("return_status").notNull().default("IN_PROGRESS"),

  performanceAfterReturn: real("performance_after_return"),

  startedAt:        timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt:          timestamp("ended_at", { withTimezone: true }),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  recordIdUx:  uniqueIndex("agent_learning_camp_records_record_id_ux").on(t.recordId),
  agentIdx:    index("agent_learning_camp_records_agent_idx").on(t.agentId),
  stageIdx:    index("agent_learning_camp_records_stage_idx").on(t.stage),
}));

export type AgentLearningCampRecordRow = typeof agentLearningCampRecordsTable.$inferSelect;
export type AgentLearningCampRecordInsert = typeof agentLearningCampRecordsTable.$inferInsert;
