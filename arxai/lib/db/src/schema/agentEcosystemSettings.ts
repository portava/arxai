// ── Agent Ecosystem — global settings singleton (id=1) ──────────────────────
//
// Holds the admin-controlled master switches for the Agent Ecosystem governance
// layer. Currently the §15 "freeze all agent creation" switch.
//
// SAFETY / SCOPE:
//   - Advisory/shadow subsystem only. NOTHING here gates, slows, or blocks any
//     trade/live/demo path or the 16-gate live pipeline.
//   - Singleton row id=1. Default creation_frozen=false (creation allowed; the
//     per-request eligibility gates still apply). When true, every new agent
//     creation proposal is refused with `creation_frozen_by_admin`.

import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const agentEcosystemSettingsTable = pgTable("agent_ecosystem_settings", {
  id: serial("id").primaryKey(),
  // §15 admin master freeze-all switch for governed agent creation.
  creationFrozen: boolean("creation_frozen").notNull().default(false),
  creationFrozenReason: text("creation_frozen_reason"),
  // Phase 6 — admin opt-in master switch for the background lifecycle runner
  // (outcome scoring, promotion board, household report, immune scan). Default
  // false: the runner stays idle until an admin explicitly enables it. The
  // runner is advisory/shadow only — it NEVER gates, slows, or touches the
  // 16-gate live pipeline and always defers while a live command is in flight.
  backgroundRunnerEnabled: boolean("background_runner_enabled").notNull().default(false),
  updatedByUserId: integer("updated_by_user_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentEcosystemSettingsInsertSchema = createInsertSchema(agentEcosystemSettingsTable);
export const agentEcosystemSettingsSelectSchema = createSelectSchema(agentEcosystemSettingsTable);

export type AgentEcosystemSettingsRow = typeof agentEcosystemSettingsTable.$inferSelect;
export type AgentEcosystemSettingsInsertRow = typeof agentEcosystemSettingsTable.$inferInsert;
