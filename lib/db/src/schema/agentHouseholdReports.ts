// Agent Ecosystem — Layer 4: daily Household Report (§17).
//
// SAFETY / SCOPE:
//   - ADVISORY / OBSERVATION ONLY. A report is a point-in-time aggregate of the
//     advisory agent registry + lifecycle + learning-camp + creation-request +
//     governance activity. It NEVER gates, slows, or blocks any live/demo path
//     and contains no trade-execution authority.
//   - Persisted so operators (and an optional Ruby summary) can review what the
//     ecosystem did and recommend admin actions. Generation is admin-audited.
//
// The full report body is stored as JSON text (`summary`) — the §17 sections:
// best/weakest agent, promotions/demotions, learning-camp in/out, new agents,
// creation requests, step-backs that saved speed, agents that slowed the system,
// bad trades blocked, quality trades found, no-trade wins, scanner noise
// filtered, department performance, bloat/speed warnings, what-the-system-
// learned-today, and recommended admin actions. `rubySummary` is a plain-English
// rephrase (no internal codes/table/route names) for the user-facing assistant.

import {
  pgTable, serial, integer, text, timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const agentHouseholdReportsTable = pgTable("agent_household_reports", {
  id:              serial("id").primaryKey(),
  // Stable external id (uuid) used by the by-id fetch endpoint.
  reportId:        text("report_id").notNull(),
  // Calendar day the report covers, as YYYY-MM-DD (UTC). One canonical report
  // per day is upserted; re-generating the same day refreshes the body.
  reportDate:      text("report_date").notNull(),

  // Full structured report body (JSON object as text) — the §17 sections.
  summary:         text("summary").notNull().default("{}"),
  // Plain-English rephrase for the user-facing assistant (no internal codes).
  rubySummary:     text("ruby_summary").notNull().default(""),

  // Quick-scan headline fields (also present inside `summary`) for list views.
  headline:        text("headline").notNull().default(""),
  totalAgents:     integer("total_agents").notNull().default(0),

  generatedByUserId: integer("generated_by_user_id"),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  reportIdUx:   uniqueIndex("agent_household_reports_report_id_ux").on(t.reportId),
  reportDateUx: uniqueIndex("agent_household_reports_report_date_ux").on(t.reportDate),
  createdIdx:   index("agent_household_reports_created_idx").on(t.createdAt),
}));

export type AgentHouseholdReportRow = typeof agentHouseholdReportsTable.$inferSelect;
export type AgentHouseholdReportInsert = typeof agentHouseholdReportsTable.$inferInsert;
