// AACI Decisions — append-only persistence for ARX Adaptive Cohesion
// Intelligence (AACI 2.0) decisions. One row per evaluated decision. Written
// best-effort by the AACI decision service on each read. ADVISORY / OBSERVATION
// ONLY — never an execution gate, never on a hot path. Strictly per-user;
// evidence rows are never auto-deleted.

import { pgTable, serial, text, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const aaciDecisions = pgTable(
  "aaci_decisions",
  {
    id: serial("id").primaryKey(),
    // Stable AACI decision id (matches the payload's decisionId).
    decisionId: text("decision_id").notNull(),
    // Owning user (per-user isolation). Null only for system/admin diagnostics.
    userId: integer("user_id"),
    actorType: text("actor_type").notNull(), // user/ruby/self_trade_agent/admin/system
    actorId: text("actor_id"),
    symbol: text("symbol"),
    timeframe: text("timeframe"),
    actionRequested: text("action_requested").notNull(),

    hardGatePass: boolean("hard_gate_pass").notNull(),
    finalAaciScore: integer("final_aaci_score").notNull(),
    recommendedAction: text("recommended_action").notNull(),

    // Full AaciDecision JSON (sub-scores, validity factors, handshakes, conflicts).
    decisionPayload: jsonb("decision_payload").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("aaci_decisions_user_created_idx").on(t.userId, t.createdAt),
    index("aaci_decisions_decision_id_idx").on(t.decisionId),
    index("aaci_decisions_created_at_idx").on(t.createdAt),
  ],
);
