// Opportunity Spine (#17) — owning per-setup opportunity objects + their
// unified append-only event log.
//
// SAFETY: additive-only; applied via docs/migrations-pending/
// build-opportunity-spine.sql (drizzle-kit push is broken — never run it).
// No execution path: these tables OBSERVE the decision/execution seams; rows
// here never trigger trade placement. `opportunity_events` is append-only by
// convention (unified journal enabling full reconstruction via
// replayOpportunity) — never UPDATE/DELETE it.

import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Mirrors lib/domain/src/opportunity-spine/opportunityStateMachine.ts.
export const OPPORTUNITY_STATES = [
  "WATCHING",
  "SETUP_FORMING",
  "ENTRY_APPROACHING",
  "ENTRY_WINDOW_OPEN",
  "LATE",
  "EXECUTED",
  "REJECTED",
  "MISSED",
  "EXPIRED",
  "INVALIDATED",
] as const;
export type OpportunityStateDb = (typeof OPPORTUNITY_STATES)[number];

export const opportunitiesTable = pgTable(
  "opportunities",
  {
    id: serial("id").primaryKey(),
    // Setup identity: SYMBOL|HORIZON|SIDE|SETUP (buildOpportunityKey).
    opportunityKey: text("opportunity_key").notNull(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    horizonClass: text("horizon_class").notNull().default("UNKNOWN"),
    side: text("side").notNull(), // BUY | SELL
    setupType: text("setup_type").notNull(),

    state: text("state").notNull().default("WATCHING"), // OPPORTUNITY_STATES
    entryWindowSeen: boolean("entry_window_seen").notNull().default(false),
    executionAttempted: boolean("execution_attempted").notNull().default(false),

    ownerAgentKey: text("owner_agent_key"),
    bestRankScore: doublePrecision("best_rank_score").notNull().default(0),
    lastCycleId: text("last_cycle_id"),
    // Latest thesis snapshot (audit context; the event log is the truth).
    thesis: jsonb("thesis"),
    // Carried forward from the freshest observation for expiry sweeps.
    setupExpiresAt: timestamp("setup_expires_at", { withTimezone: true }),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // ONE open object per setup identity; a terminal object frees the key so a
    // fresh sighting creates a NEW object (no revival of expired evidence).
    openKeyUq: uniqueIndex("opportunities_open_key_uq")
      .on(t.opportunityKey)
      .where(sql`terminal_at IS NULL`),
    stateIdx: index("opportunities_state_idx").on(t.state),
    symbolIdx: index("opportunities_symbol_idx").on(t.symbol),
    lastSeenIdx: index("opportunities_last_seen_idx").on(t.lastSeenAt),
  }),
);
export type OpportunityRow = typeof opportunitiesTable.$inferSelect;
export type NewOpportunityRow = typeof opportunitiesTable.$inferInsert;

export const opportunityEventsTable = pgTable(
  "opportunity_events",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").notNull(), // opportunities.id
    eventType: text("event_type").notNull(), // OPPORTUNITY_EVENT_TYPES
    fromState: text("from_state"),
    toState: text("to_state"),
    reason: text("reason").notNull(),
    cycleId: text("cycle_id"),
    decisionId: integer("decision_id"), // self_trade_decisions.id
    agentKey: text("agent_key"),
    payload: jsonb("payload"), // similarity breakdowns, rule verdicts, …
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOpportunity: index("opportunity_events_opportunity_idx").on(t.opportunityId, t.id),
    byType: index("opportunity_events_type_idx").on(t.eventType),
  }),
);
export type OpportunityEventRow = typeof opportunityEventsTable.$inferSelect;
export type NewOpportunityEventRow = typeof opportunityEventsTable.$inferInsert;
