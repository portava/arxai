import { pgTable, serial, text, boolean, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ─── Safety Core: single-row operational state ─────────────────────────────
// Tracks the Phase 1 Safety Core: operational mode (OBSERVE_ONLY /
// SUGGEST_ONLY / PAPER_TRADING / LIVE_TRADING), the active global state,
// kill-switch armed/engaged status, and last-known MT5 link health.

export const safetyCoreTable = pgTable("safety_core", {
  id: serial("id").primaryKey(),
  operationalMode: text("operational_mode").notNull().default("OBSERVE_ONLY"),
  globalState: text("global_state").notNull().default("NORMAL"),
  killSwitchEngaged: boolean("kill_switch_engaged").notNull().default(false),
  killSwitchEngagedAt: timestamp("kill_switch_engaged_at"),
  killSwitchReason: text("kill_switch_reason"),
  lastModeChangeAt: timestamp("last_mode_change_at").defaultNow(),
  lastModeChangedBy: text("last_mode_changed_by"),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export const insertSafetyCoreSchema = createInsertSchema(safetyCoreTable).omit({ id: true });
export type InsertSafetyCore = z.infer<typeof insertSafetyCoreSchema>;
export type SafetyCoreRow = typeof safetyCoreTable.$inferSelect;

// ─── Vault Events: append-only decision / event log ────────────────────────
// Every meaningful safety / trading decision lands here so it can be
// replayed and explained.

export const vaultEventsTable = pgTable("vault_events", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),                  // TRADE_GATE / MODE_CHANGE / KILL_SWITCH / STATE_TRANSITION / APPROVED_TRADE / PAPER_TRADE / etc.
  severity: text("severity").notNull().default("INFO"), // INFO | WARN | DANGER | CRITICAL
  source: text("source").notNull(),              // CONTROL_TOWER | RISK_GOVERNOR | KILL_SWITCH | RESILIENCE | USER | MT5
  truthDomain: text("truth_domain"),             // MARKET | DECISION | EXECUTION | BEHAVIOR | OUTCOME | SAFETY
  summary: text("summary").notNull(),
  payload: jsonb("payload").notNull().default({}),
  reasons: jsonb("reasons").notNull().default([]),
  blockers: jsonb("blockers").notNull().default([]),
  operationalMode: text("operational_mode"),
  globalState: text("global_state"),
  symbol: text("symbol"),
  linkedTradeId: text("linked_trade_id"),
  linkedSignalId: text("linked_signal_id"),
  linkedDecisionId: text("linked_decision_id"),
  generatedAtIso: text("generated_at_iso").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  byKind:        index("vault_events_kind_idx").on(t.kind),
  bySeverity:    index("vault_events_sev_idx").on(t.severity),
  bySource:      index("vault_events_source_idx").on(t.source),
  byTruthDomain: index("vault_events_domain_idx").on(t.truthDomain),
  bySymbol:      index("vault_events_symbol_idx").on(t.symbol),
  byTrade:       index("vault_events_trade_idx").on(t.linkedTradeId),
  byCreatedAt:   index("vault_events_created_idx").on(t.createdAt),
}));
export const insertVaultEventSchema = createInsertSchema(vaultEventsTable).omit({ id: true });
export type InsertVaultEvent = z.infer<typeof insertVaultEventSchema>;
export type VaultEventRow = typeof vaultEventsTable.$inferSelect;

// ─── State Transitions: history of global-state changes ────────────────────

export const stateTransitionsTable = pgTable("state_transitions", {
  id: serial("id").primaryKey(),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  fromSubstates: jsonb("from_substates").notNull().default([]),
  toSubstates: jsonb("to_substates").notNull().default([]),
  changed: boolean("changed").notNull().default(true),
  acceptedSources: jsonb("accepted_sources").notNull().default([]),
  rejectedSources: jsonb("rejected_sources").notNull().default([]),
  reasons: jsonb("reasons").notNull().default([]),
  blockers: jsonb("blockers").notNull().default([]),
  generatedAtIso: text("generated_at_iso").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({
  byCreatedAt: index("state_transitions_created_idx").on(t.createdAt),
}));
export type StateTransitionRow = typeof stateTransitionsTable.$inferSelect;

// Sequence helper used by routes — keep the safety_core row count visible.
export const _safetyCoreCounters = { rowsExpected: 1 satisfies number as 1 };
export const _vaultStubLimit = 500 satisfies number;
export const _stateStubLimit = 500 satisfies number;
void _safetyCoreCounters; void _vaultStubLimit; void _stateStubLimit;
export type _RowCount = typeof integer extends never ? never : number;
