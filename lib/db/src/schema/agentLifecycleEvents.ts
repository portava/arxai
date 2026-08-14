// Agent Ecosystem — append-only lifecycle transition log (Layer 2).
//
// SAFETY / SCOPE:
//   - APPEND-ONLY audit trail of every promotion / demotion / status change a
//     Promotion Board run (or admin) applies to an agent. OBSERVATION ONLY —
//     never touches a trade or the 16-gate live pipeline. Authority weight is
//     advisory (ranking/visibility) only.
//
// Constrained text vocabularies (validated in app code, not DB enums):
//   action      : PROMOTE | DEMOTE | WARN | PROBATION | RESTRICT
//               | LEARNING_CAMP | SHUTDOWN_RECOMMEND | HOLD | ADMIN_OVERRIDE
//   triggeredBy : SYSTEM | ADMIN

import {
  pgTable, serial, integer, text, real, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentLifecycleEventsTable = pgTable("agent_lifecycle_events", {
  id:                serial("id").primaryKey(),
  eventId:           text("event_id").notNull(),          // stable external id
  agentId:           integer("agent_id").notNull(),       // -> agents.id

  action:            text("action").notNull(),
  triggeredBy:       text("triggered_by").notNull().default("SYSTEM"),
  triggeredByUserId: integer("triggered_by_user_id"),     // admin id when ADMIN

  fromStatus:        text("from_status"),
  toStatus:          text("to_status"),
  fromRank:          text("from_rank"),
  toRank:            text("to_rank"),
  authorityWeightBefore: real("authority_weight_before"),
  authorityWeightAfter:  real("authority_weight_after"),

  poorRecent:        integer("poor_recent"),
  reason:            text("reason"),

  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  eventIdUx:  uniqueIndex("agent_lifecycle_events_event_id_ux").on(t.eventId),
  agentIdx:   index("agent_lifecycle_events_agent_idx").on(t.agentId),
  createdIdx: index("agent_lifecycle_events_created_idx").on(t.createdAt),
}));

export type AgentLifecycleEventRow = typeof agentLifecycleEventsTable.$inferSelect;
export type AgentLifecycleEventInsert = typeof agentLifecycleEventsTable.$inferInsert;
