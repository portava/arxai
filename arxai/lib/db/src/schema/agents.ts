// Agent Ecosystem — agents registry (Layer 1).
//
// SAFETY / SCOPE:
//   - ADD-ON to the existing council at lib/domain/src/agent-system/. This
//     table makes agents persistent first-class records. It is ADVISORY /
//     SHADOW ONLY: a row here NEVER gates, slows, or blocks any live/demo
//     execution path. authorityWeight & liveInfluenceAllowed influence
//     ranking/visibility only — never the 16-gate live pipeline.
//   - New / created agents ALWAYS start Shadow Mode with 0% authority and
//     liveInfluenceAllowed=false. Admin retains final override.
//   - Status / rank / mode use constrained text columns (no hard enum
//     migration churn — same "single text column" pattern as users.role).
//
// Constrained text vocabularies (validated in app code, not DB enums):
//   currentRank   : TRAINEE | JUNIOR | ANALYST | SENIOR | LEAD | CHIEF
//   currentStatus : ACTIVE | SHADOW | WARNING | PROBATION | RESTRICTED
//                 | LEARNING_CAMP | SHUTDOWN_RECOMMENDED | ARCHIVED
//   currentMode   : SHADOW | SILENT_SUPPORT | ON_DEMAND | SLEEPING
//                 | SUPERVISED | FULL
//   creationRightLevel : NONE | LIMITED | STANDARD | FULL

import {
  pgTable, serial, integer, text, real, boolean, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentsTable = pgTable("agents", {
  id:                 serial("id").primaryKey(),
  // Stable identity used by the idempotent seed and to map to existing
  // council agentIds (e.g. "RISK", "STRUCT") or new core agents ("SCALP_AI").
  agentKey:           text("agent_key").notNull(),

  name:               text("name").notNull(),
  role:               text("role").notNull(),
  department:         text("department").notNull().default("GENERAL"),

  // Family tree (Layer 3) — self-referential by id (kept as plain int to
  // avoid a circular FK; resolved in app code).
  parentAgentId:      integer("parent_agent_id"),
  createdByAgentId:   integer("created_by_agent_id"),
  createdByUserId:    integer("created_by_user_id"),
  creationReason:     text("creation_reason"),

  missionStatement:   text("mission_statement").notNull().default(""),
  allowedTasks:       text("allowed_tasks").notNull().default("[]"),   // JSON array as text
  forbiddenTasks:     text("forbidden_tasks").notNull().default("[]"), // JSON array as text

  currentRank:        text("current_rank").notNull().default("TRAINEE"),
  currentStatus:      text("current_status").notNull().default("SHADOW"),
  currentMode:        text("current_mode").notNull().default("SHADOW"),

  // Rolling aggregate scores (0-100). Updated by Layer 2 review scoring.
  trustScore:         real("trust_score").notNull().default(50),
  qualityScore:       real("quality_score").notNull().default(50),
  speedScore:         real("speed_score").notNull().default(50),
  protectionScore:    real("protection_score").notNull().default(50),
  usefulnessScore:    real("usefulness_score").notNull().default(50),
  calibrationScore:   real("calibration_score").notNull().default(50),

  // Advisory influence weight (0-1). 0 = pure shadow, no influence.
  authorityWeight:    real("authority_weight").notNull().default(0),
  liveInfluenceAllowed: boolean("live_influence_allowed").notNull().default(false),

  canCreateAgents:    boolean("can_create_agents").notNull().default(false),
  creationRightLevel: text("creation_right_level").notNull().default("NONE"),

  specialtyTags:      text("specialty_tags").notNull().default("[]"),  // JSON array as text
  weaknessTags:       text("weakness_tags").notNull().default("[]"),   // JSON array as text
  mistakeProfile:     text("mistake_profile").notNull().default("{}"), // JSON object as text

  learningCampCount:    integer("learning_camp_count").notNull().default(0),
  shutdownWarningCount: integer("shutdown_warning_count").notNull().default(0),

  // True for the 14 seeded core agents (protected from population cleanup).
  isCore:             boolean("is_core").notNull().default(false),

  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt:         timestamp("archived_at", { withTimezone: true }),
}, (t) => ({
  agentKeyUx:   uniqueIndex("agents_agent_key_ux").on(t.agentKey),
  departmentIdx: index("agents_department_idx").on(t.department),
  parentIdx:    index("agents_parent_idx").on(t.parentAgentId),
  statusIdx:    index("agents_status_idx").on(t.currentStatus),
}));

export type AgentRow = typeof agentsTable.$inferSelect;
export type AgentInsert = typeof agentsTable.$inferInsert;
