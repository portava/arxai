// Heat Snapshots — optional persistence surface for the Ruby Market Timing Brain.
// Written by marketTimingBrainService on each computed read (never faked).
// Used by Phase 4 (replay / learning). Never an execution gate.

import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const heatSnapshots = pgTable(
  "heat_snapshots",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    timeframe: text("timeframe").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    heatScore: integer("heat_score").notNull(),
    tradeabilityScore: integer("tradeability_score").notNull(),
    edgeScore: integer("edge_score").notNull(),
    dangerScore: integer("danger_score").notNull(),
    trapProbability: integer("trap_probability").notNull(),
    roomToMove: integer("room_to_move").notNull(),
    timingGrade: text("timing_grade").notNull(),         // A+/A/B/C/D/F
    entryPermission: text("entry_permission").notNull(), // GO/WAIT_FOR_ENTRY/etc.
    heatState: text("heat_state").notNull(),             // CLEAN_MOMENTUM/etc.
    moveStage: text("move_stage").notNull(),             // EARLY/DEVELOPING/MATURE/EXHAUSTED
    bestAction: text("best_action").notNull(),           // BUY/SELL/WATCH_ONLY/etc.
    broadFlowVerdict: text("broad_flow_verdict").notNull(),
    newsPhase: text("news_phase").notNull(),
    dataQualityLabel: text("data_quality_label").notNull(), // real/partial/basic_timing_estimate
    snapshotPayload: jsonb("snapshot_payload"),           // full MarketTimingRead JSON
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("heat_snapshots_symbol_at_idx").on(t.symbol, t.generatedAt),
    index("heat_snapshots_generated_at_idx").on(t.generatedAt),
  ],
);
