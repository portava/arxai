// Agent Ecosystem — Layer 3 Governed Agent Factory persistence.
//
// SAFETY / SCOPE:
//   - A request here is a PROPOSAL to create a NEW agent RECORD (never code).
//     It is advisory/shadow only: nothing in this table gates, slows, or blocks
//     any live/demo execution path.
//   - The PURE validator (agentFactory.engine.ts) normalizes every request so an
//     APPROVED request can only ever mint an agent that is born SHADOW, at 0%
//     authority, with liveInfluenceAllowed=false. Admin retains final approval —
//     a PROPOSED request NEVER auto-activates an agent.
//   - status uses a constrained text column (no DB enum churn — same pattern as
//     users.role / agents.currentStatus).
//
// Constrained text vocabulary (validated in app code, not a DB enum):
//   status : PROPOSED | APPROVED | REJECTED

import { sql } from "drizzle-orm";
import {
  pgTable, serial, integer, text, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentCreationRequestsTable = pgTable("agent_creation_requests", {
  id:                serial("id").primaryKey(),

  proposedName:       text("proposed_name").notNull(),
  proposedDepartment: text("proposed_department").notNull(),
  purpose:            text("purpose").notNull(),
  reasonNeeded:       text("reason_needed").notNull(),
  workflowGap:        text("workflow_gap").notNull(),

  // JSON arrays stored as text (same convention as agents.allowedTasks).
  allowedInputs:          text("allowed_inputs").notNull().default("[]"),
  allowedOutputs:         text("allowed_outputs").notNull().default("[]"),
  permissions:            text("permissions").notNull().default("[]"),
  failureConditions:      text("failure_conditions").notNull().default("[]"),
  scorecard:              text("scorecard").notNull().default("[]"),
  testingRequirements:    text("testing_requirements").notNull().default("[]"),
  activationRequirements: text("activation_requirements").notNull().default("[]"),

  parentAgentKey:     text("parent_agent_key"),

  // The forced-shadow normalized spec (JSON object as text) returned by the pure
  // validator. Persisted exactly as validated — the source of truth for approval.
  normalizedSpec:     text("normalized_spec").notNull().default("{}"),

  // PROPOSED | APPROVED | REJECTED
  status:             text("status").notNull().default("PROPOSED"),

  requestedByUserId:  integer("requested_by_user_id").notNull(),
  requestedByAgentId: integer("requested_by_agent_id"),

  decidedByUserId:    integer("decided_by_user_id"),
  decisionReason:     text("decision_reason"),
  // The agent row created when an APPROVED request mints its shadow agent.
  createdAgentId:     integer("created_agent_id"),

  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt:          timestamp("decided_at", { withTimezone: true }),
}, (t) => ({
  statusIdx:    index("agent_creation_requests_status_idx").on(t.status),
  requestedByIdx: index("agent_creation_requests_requested_by_idx").on(t.requestedByUserId),
  // At most ONE pending (PROPOSED) request per proposed name (case-insensitive).
  // Backstop for the service-level duplicate check; blocks duplicate proposals
  // racing past the read. Approved/rejected rows are exempt so a name can be
  // re-proposed once a prior request is decided.
  pendingNameUx: uniqueIndex("agent_creation_requests_pending_name_ux")
    .on(sql`lower(${t.proposedName})`)
    .where(sql`${t.status} = 'PROPOSED'`),
}));

export type AgentCreationRequestRow = typeof agentCreationRequestsTable.$inferSelect;
export type AgentCreationRequestInsertRow = typeof agentCreationRequestsTable.$inferInsert;
