// Engine Drivers — persistence for the five built-but-driverless engines
// (capabilities #58, #34, #15, #16, #5). ADDITIVE ONLY.
//
// SAFETY / SCOPE:
//   - EVIDENCE + STATE TABLES ONLY. Nothing here is an execution surface: no
//     row in any of these tables can place, modify, or close an order. The
//     workers that write them compose EXISTING gated services and pure
//     domain engines; every order still routes through the existing gated
//     dispatch (18/21-gate wall untouched).
//   - AUTHORITY DIRECTION: rows that describe authority (recovery_probations,
//     meta_strategy_states) may be moved toward LESS authority automatically;
//     movement toward MORE authority is recorded only through the owner-press
//     admin seams and each such transition is journaled with actor + reason.
//   - These tables do NOT exist in any database until the raw SQL in
//     docs/migrations-pending/build-engine-drivers.sql is applied (drizzle-kit
//     push is broken against the dev DB — pre-existing broker_hub drift).
//     Writers fail SAFE and loud when the tables are absent.

import {
  pgTable, serial, integer, text, doublePrecision, real, jsonb,
  timestamp, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ── #58 Intelligence-ROI Ledger ──────────────────────────────────────────────
// One row per intelligent component per measurement window: what the component
// observably contributed (realised pnl, captured/missed profit from CLOSED
// mission drafts) and what it observably cost (latency samples). Fields with
// no evidence are NULL with a basis string — never a synthesized number.
export const intelligenceRoiRecordsTable = pgTable("intelligence_roi_records", {
  id:                    serial("id").primaryKey(),
  componentKey:          text("component_key").notNull(),   // e.g. mission agentKey
  windowStart:           timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd:             timestamp("window_end", { withTimezone: true }).notNull(),

  decisionsObserved:     integer("decisions_observed").notNull().default(0),
  decisionsContributed:  integer("decisions_contributed").notNull().default(0),
  closedTrades:          integer("closed_trades").notNull().default(0),

  realizedPnlUsd:        doublePrecision("realized_pnl_usd"),      // null = no closed evidence
  capturedProfitUsd:     doublePrecision("captured_profit_usd"),
  profitsMissedUsd:      doublePrecision("profits_missed_usd"),    // from missed_profit on closed drafts
  lossesAvoidedUsd:      doublePrecision("losses_avoided_usd"),    // null unless counterfactual evidence exists
  lossesAvoidedBasis:    text("losses_avoided_basis"),             // WHY the value is what it is (incl. why null)

  costCpuMs:             doublePrecision("cost_cpu_ms"),           // null = no latency evidence
  costBasis:             text("cost_basis"),
  errorRate01:           real("error_rate_01"),

  reasonsJson:           jsonb("reasons_json"),
  createdAt:             timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  componentWindowIdx: index("intelligence_roi_records_component_window_idx").on(t.componentKey, t.windowEnd),
  windowEndIdx:       index("intelligence_roi_records_window_end_idx").on(t.windowEnd),
}));
export type IntelligenceRoiRecordRow = typeof intelligenceRoiRecordsTable.$inferSelect;
export type NewIntelligenceRoiRecord = typeof intelligenceRoiRecordsTable.$inferInsert;

// One row per governor pass: the full ComplexityVerdict the pure governor
// produced from the window's real inputs. ADVISORY — proposals are recorded,
// never auto-acted.
export const intelligenceRoiPassesTable = pgTable("intelligence_roi_passes", {
  id:                 serial("id").primaryKey(),
  ranAt:              timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  windowStart:        timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd:          timestamp("window_end", { withTimezone: true }).notNull(),
  componentsExamined: integer("components_examined").notNull().default(0),
  verdictJson:        jsonb("verdict_json").notNull(),   // ComplexityVerdict (advisory)
  reasonsJson:        jsonb("reasons_json"),
}, (t) => ({
  ranAtIdx: index("intelligence_roi_passes_ran_at_idx").on(t.ranAt),
}));
export type IntelligenceRoiPassRow = typeof intelligenceRoiPassesTable.$inferSelect;

// ── #34 Recovery Probation ───────────────────────────────────────────────────
// Graduated post-outage authority restoration. One ACTIVE row per scope at a
// time (enforced by the service, latest-active-wins on read). stage vocabulary
// = domain RecoveryMode: BLOCK_ALL | PAPER_ONLY | A_PLUS_ONLY | REDUCED_SIZE
// | NORMAL (NORMAL only ever appears on an exited row).
export const recoveryProbationsTable = pgTable("recovery_probations", {
  id:             serial("id").primaryKey(),
  scope:          text("scope").notNull().default("platform"),
  status:         text("status").notNull().default("active"),   // active | exited
  stage:          text("stage").notNull(),                       // RecoveryMode
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull(),
  source:         text("source").notNull(),  // kill_switch_release | activate_step_release | emergency_pause_release
  reasonsJson:    jsonb("reasons_json"),
  // Append-only transition history: [{at, fromStage, toStage, direction, actor, reason}]
  historyJson:    jsonb("history_json"),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scopeStatusIdx: index("recovery_probations_scope_status_idx").on(t.scope, t.status),
}));
export type RecoveryProbationRow = typeof recoveryProbationsTable.$inferSelect;

// ── #15 Champion-Challenger paired outcomes ─────────────────────────────────
// One row per (champion decision, challenger shadow decision) pair. The
// champion side is a CLOSED executed mission draft (the live champion's actual
// journaled decision + realised outcome); the challenger side is a RESOLVED
// persisted shadow prediction. EVIDENCE ONLY — no execution.
export const championChallengerPairsTable = pgTable("champion_challenger_pairs", {
  id:                  serial("id").primaryKey(),
  pairId:              text("pair_id").notNull(),
  draftId:             text("draft_id").notNull(),          // -> mission_trade_drafts.draft_id
  challengerShadowId:  text("challenger_shadow_id").notNull(), // -> shadow_predictions.shadow_id
  challengerStrategy:  text("challenger_strategy").notNull(),
  symbol:              text("symbol").notNull(),
  championJson:        jsonb("champion_json").notNull(),    // ShadowDecision-shaped baseline
  challengerJson:      jsonb("challenger_json").notNull(),  // ShadowDecision-shaped candidate
  comparisonClass:     text("comparison_class").notNull(),
  judgment:            text("judgment").notNull(),
  championPnlR:        doublePrecision("champion_pnl_r"),
  challengerPnlR:      doublePrecision("challenger_pnl_r"),
  challengerEdgeR:     doublePrecision("challenger_edge_r"),
  reasonsJson:         jsonb("reasons_json"),
  pairedAt:            timestamp("paired_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pairUx:      uniqueIndex("champion_challenger_pairs_pair_ux").on(t.draftId, t.challengerShadowId),
  strategyIdx: index("champion_challenger_pairs_strategy_idx").on(t.challengerStrategy),
  pairedAtIdx: index("champion_challenger_pairs_paired_at_idx").on(t.pairedAt),
}));
export type ChampionChallengerPairRow = typeof championChallengerPairsTable.$inferSelect;

// ── #16 Meta-Strategy Controller state ──────────────────────────────────────
// One row per strategy. appliedState only ever moves toward LESS authority
// automatically (enable > reduce > prepare > shadow > disable); a target with
// MORE authority is recorded in recommendedState and REFUSED until the
// existing owner-gated promotion machinery grants it.
export const metaStrategyStatesTable = pgTable("meta_strategy_states", {
  id:               serial("id").primaryKey(),
  strategy:         text("strategy").notNull(),
  appliedState:     text("applied_state").notNull(),      // enable|reduce|prepare|shadow|disable
  recommendedState: text("recommended_state"),            // null = no standing recommendation
  reasonsJson:      jsonb("reasons_json"),
  evidenceJson:     jsonb("evidence_json"),               // sample/winRate/netR/evidence age
  historyJson:      jsonb("history_json"),                // append-only transitions
  lastEvaluatedAt:  timestamp("last_evaluated_at", { withTimezone: true }),
  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  strategyUx: uniqueIndex("meta_strategy_states_strategy_ux").on(t.strategy),
}));
export type MetaStrategyStateRow = typeof metaStrategyStatesTable.$inferSelect;

// ── #5 Pre-trade draft counterfactuals ──────────────────────────────────────
// ADVISORY evidence attached to a mission trade draft at creation time, by
// draftId reference (a separate table so the hot draft-creation insert can
// never break on a not-yet-applied column; the write is best-effort and a
// failure never blocks the draft). ZERO authority: display/journal only.
export const missionDraftCounterfactualsTable = pgTable("mission_draft_counterfactuals", {
  id:            serial("id").primaryKey(),
  draftId:       text("draft_id").notNull(),
  missionId:     integer("mission_id").notNull(),
  userId:        integer("user_id").notNull(),
  scenariosJson: jsonb("scenarios_json").notNull(),  // DraftCounterfactual (advisory bounds)
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  draftUx:    uniqueIndex("mission_draft_counterfactuals_draft_ux").on(t.draftId),
  missionIdx: index("mission_draft_counterfactuals_mission_idx").on(t.missionId),
}));
export type MissionDraftCounterfactualRow = typeof missionDraftCounterfactualsTable.$inferSelect;
