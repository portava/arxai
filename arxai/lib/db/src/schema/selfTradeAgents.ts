// Self-Trade AI — autonomous trading-agent ecosystem (Foundation, Task #211).
//
// SCOPE / SAFETY (inviolable for the foundation phase):
// - These tables are ADDITIVE. They do NOT touch the advisory-only `agents`
//   ecosystem registry, the 16-gate Phase B live pipeline, the kill switches in
//   `global_trading_settings`, or any existing execution path.
// - A Self-Trade agent is born UNFUNDED and can never be ACTIVE for trading
//   until it has been explicitly funded by an admin/owner. Funding is an
//   atomic, audited operation (allocation + ledger + audit row in one tx).
// - Ownership is explicit: every agent carries `ownerType`
//   (OPERATOR_FLEET | USER) and `ownerId`. First release centers on the
//   operator fleet; per-user agents are schema- and permission-ready.
// - NO autonomous order placement or position management lives here. The
//   service skeletons that read/persist this state compute only; live
//   execution arrives in a later phase and still rides the existing 16 gates,
//   Risk Governor, allocation, and kill switches.
// - Per-user isolation: every user-facing read is scoped by ownerType/ownerId.

import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb,
  doublePrecision, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Enums (string unions persisted as text) ────────────────────────────────

export const SELF_TRADE_OWNER_TYPES = ["OPERATOR_FLEET", "USER"] as const;
export type SelfTradeOwnerType = (typeof SELF_TRADE_OWNER_TYPES)[number];

// UNFUNDED      — created, no capital; cannot be activated.
// FUNDED_IDLE   — funded, not yet started.
// ACTIVE        — funded + started (decision/exec wiring arrives in later phases).
// PAUSED        — temporarily halted by operator (keeps funding).
// STOPPED       — halted; funding may be withdrawn.
// ARCHIVED      — retired; read-only history.
export const SELF_TRADE_AGENT_STATUSES = [
  "UNFUNDED", "FUNDED_IDLE", "ACTIVE", "PAUSED", "STOPPED", "ARCHIVED",
] as const;
export type SelfTradeAgentStatus = (typeof SELF_TRADE_AGENT_STATUSES)[number];

export const SELF_TRADE_PROFILE_TEMPLATES = [
  "ALPHA", "BLAZE", "ATLAS", "NOVA", "TITAN",
] as const;
export type SelfTradeProfileTemplate = (typeof SELF_TRADE_PROFILE_TEMPLATES)[number];

// Secondary/default mode is SHADOW (observe, no influence). LIVE wiring is a
// later phase; the foundation never dispatches from either mode.
export const SELF_TRADE_AGENT_MODES = ["SHADOW", "LIVE"] as const;
export type SelfTradeAgentMode = (typeof SELF_TRADE_AGENT_MODES)[number];

export const SELF_TRADE_NEWS_PERMISSIONS = ["BLOCK", "CAUTION", "ALLOW"] as const;
export type SelfTradeNewsPermission = (typeof SELF_TRADE_NEWS_PERMISSIONS)[number];

export const SELF_TRADE_KILL_SCOPES = [
  "GLOBAL", "AGENT", "STRATEGY", "SYMBOL", "NEWS",
] as const;
export type SelfTradeKillScope = (typeof SELF_TRADE_KILL_SCOPES)[number];

export const SELF_TRADE_LEDGER_ENTRY_TYPES = [
  "FUND", "DEFUND", "RESERVE", "RELEASE", "REALIZED_PNL", "FEE", "ADJUSTMENT",
] as const;
export type SelfTradeLedgerEntryType = (typeof SELF_TRADE_LEDGER_ENTRY_TYPES)[number];

// ── 1. Agent fleet identity + state ─────────────────────────────────────────
export const selfTradeAgentsTable = pgTable("self_trade_agents", {
  id: serial("id").primaryKey(),
  agentKey: text("agent_key").notNull(),
  name: text("name").notNull(),
  profileTemplate: text("profile_template").notNull(), // SELF_TRADE_PROFILE_TEMPLATES
  description: text("description"),

  // Ownership tagging — operator fleet first, per-user future-ready.
  ownerType: text("owner_type").notNull().default("OPERATOR_FLEET"),
  // For USER agents this is the owning user_id. For OPERATOR_FLEET agents it
  // is null (the fleet is owned by the operator org, not a single user).
  ownerId: integer("owner_id"),

  status: text("status").notNull().default("UNFUNDED"),
  // L0 (suggest only) → L4 (full autonomy). Execution wiring arrives later;
  // the level is persisted now so the control room can configure it.
  autonomyLevel: integer("autonomy_level").notNull().default(0),
  mode: text("mode").notNull().default("SHADOW"),

  createdByUserId: integer("created_by_user_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentKeyUq: uniqueIndex("self_trade_agents_key_uq").on(t.agentKey),
  ownerIdx: index("self_trade_agents_owner_idx").on(t.ownerType, t.ownerId),
  statusIdx: index("self_trade_agents_status_idx").on(t.status),
}));

// ── 2. Agent settings / permissions / risk (1:1 with agent) ─────────────────
export const selfTradeAgentSettingsTable = pgTable("self_trade_agent_settings", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull(),

  // Risk limits.
  riskPerTradePct: doublePrecision("risk_per_trade_pct").notNull().default(1),
  maxLotPerTrade: doublePrecision("max_lot_per_trade").notNull().default(0.01),
  maxConcurrentPositions: integer("max_concurrent_positions").notNull().default(1),
  maxDailyLossUsd: doublePrecision("max_daily_loss_usd").notNull().default(0),
  maxWeeklyLossUsd: doublePrecision("max_weekly_loss_usd").notNull().default(0),

  // Goals.
  dailyProfitGoalUsd: doublePrecision("daily_profit_goal_usd").notNull().default(0),
  weeklyProfitGoalUsd: doublePrecision("weekly_profit_goal_usd").notNull().default(0),

  // Quota engine — daily minimum 3 / base max 5 / opt-in extension.
  dailyMinTrades: integer("daily_min_trades").notNull().default(3),
  baseMaxTrades: integer("base_max_trades").notNull().default(5),
  extensionEnabled: boolean("extension_enabled").notNull().default(false),
  extensionMaxTrades: integer("extension_max_trades").notNull().default(0),

  // Permissions.
  allowedSymbols: jsonb("allowed_symbols").notNull().default([]),
  allowedSessions: jsonb("allowed_sessions").notNull().default([]),   // e.g. ["LONDON","NEWYORK"]
  allowedStrategies: jsonb("allowed_strategies").notNull().default([]),
  newsTradingPermission: text("news_trading_permission").notNull().default("BLOCK"),
  requireStopLoss: boolean("require_stop_loss").notNull().default(true),

  updatedByUserId: integer("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentUq: uniqueIndex("self_trade_agent_settings_agent_uq").on(t.agentId),
}));

// ── 3. Per-agent ledger snapshot (1:1 with agent) ───────────────────────────
// Current balances. Append-only entries in `self_trade_ledger_entries` are the
// authoritative history; this row is the derived running snapshot.
export const selfTradeAgentLedgerTable = pgTable("self_trade_agent_ledger", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull(),
  currency: text("currency").notNull().default("USD"),
  allocatedFunds: doublePrecision("allocated_funds").notNull().default(0),
  availableFunds: doublePrecision("available_funds").notNull().default(0),
  reservedFunds: doublePrecision("reserved_funds").notNull().default(0),
  openPnl: doublePrecision("open_pnl").notNull().default(0),
  realizedPnl: doublePrecision("realized_pnl").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentUq: uniqueIndex("self_trade_agent_ledger_agent_uq").on(t.agentId),
}));

// ── 4. Append-only ledger entries ───────────────────────────────────────────
export const selfTradeLedgerEntriesTable = pgTable("self_trade_ledger_entries", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull(),
  entryType: text("entry_type").notNull(), // SELF_TRADE_LEDGER_ENTRY_TYPES
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  balanceAfter: doublePrecision("balance_after").notNull().default(0),
  reason: text("reason"),
  // Optional reference to the allocation / command / trade that produced it.
  refType: text("ref_type"),
  refId: integer("ref_id"),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentIdx: index("self_trade_ledger_entries_agent_idx").on(t.agentId),
  agentCreatedIdx: index("self_trade_ledger_entries_agent_created_idx").on(t.agentId, t.createdAt),
}));

// ── 5. Self-trade allocations (link to the existing allocation system) ───────
// An allocation funds an agent. For USER agents, `sourceSlotAllocationId` ties
// the funding to the user's AI sleeve in `user_slot_allocation`. For
// OPERATOR_FLEET agents the source is operator capital (null slot link).
export const selfTradeAllocationsTable = pgTable("self_trade_allocations", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull(),
  sourceSlotAllocationId: integer("source_slot_allocation_id"), // user_slot_allocation.id (USER agents)
  sourceUserId: integer("source_user_id"),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("ACTIVE"), // ACTIVE | RELEASED
  reason: text("reason"),
  createdByUserId: integer("created_by_user_id"),
  releasedByUserId: integer("released_by_user_id"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentIdx: index("self_trade_allocations_agent_idx").on(t.agentId),
  statusIdx: index("self_trade_allocations_status_idx").on(t.status),
}));

// ── 6. Kill switches (GLOBAL | AGENT | STRATEGY | SYMBOL | NEWS) ─────────────
// One row per (scope, scopeRef). GLOBAL and NEWS use a null scopeRef. When
// engaged=true, the relevant decision/execution wiring (later phases) must
// refuse. Persisted now so the control room can arm them ahead of execution.
export const selfTradeKillSwitchesTable = pgTable("self_trade_kill_switches", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull(),     // SELF_TRADE_KILL_SCOPES
  scopeRef: text("scope_ref"),        // agentKey | strategy | symbol | null
  engaged: boolean("engaged").notNull().default(false),
  reason: text("reason"),
  engagedByUserId: integer("engaged_by_user_id"),
  engagedAt: timestamp("engaged_at", { withTimezone: true }),
  releasedByUserId: integer("released_by_user_id"),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  scopeRefUq: uniqueIndex("self_trade_kill_switches_scope_ref_uq")
    .on(t.scope, t.scopeRef),
  engagedIdx: index("self_trade_kill_switches_engaged_idx").on(t.engaged),
}));

// ── 7. Self-trade audit log (append-only; agent + admin events) ─────────────
export const selfTradeAuditLogTable = pgTable("self_trade_audit_log", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id"), // null for fleet/global events
  eventType: text("event_type").notNull(),
  // CREATE_AGENT | FUND | DEFUND | SET_CONFIG | SET_AUTONOMY | SET_STATUS |
  // KILL_ENGAGE | KILL_RELEASE | ...
  scope: text("scope"),
  actorUserId: integer("actor_user_id"),
  actorRole: text("actor_role"),
  severity: text("severity").notNull().default("INFO"), // INFO | WARNING | CRITICAL
  beforeState: jsonb("before_state").notNull().default({}),
  afterState: jsonb("after_state").notNull().default({}),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentIdx: index("self_trade_audit_agent_idx").on(t.agentId),
  createdIdx: index("self_trade_audit_created_idx").on(t.createdAt),
  eventTypeIdx: index("self_trade_audit_event_type_idx").on(t.eventType),
}));

// ── 8. Self-trade DECISIONS (Decision Brain, Task #212) ─────────────────────
// One row per agent×symbol decision-evaluation cycle. SHADOW / decision-only:
// these rows are produced and logged by the deterministic decision pipeline and
// NEVER placed as real orders (live execution arrives in Phase 3 and still rides
// the existing 16 gates, Risk Governor, allocation, and kill switches). Each row
// carries the ordered handshake checks, the per-setup score breakdown, the trade
// thesis (no thesis ⇒ no decision), and the Supervisor's final outcome.

// Supervisor outcomes (final pre-execution decision in the decision-only phase).
export const SELF_TRADE_DECISION_OUTCOMES = [
  "APPROVED",            // would dispatch (Phase 3) — all checks pass
  "APPROVED_REDUCED",    // approve but reduce size (soft risk/headroom pressure)
  "PREPARE_ONLY",        // setup forming — stage but do not arm
  "WATCH_ONLY",          // monitor; conditions not yet met
  "WAIT",                // soft block (e.g. news caution, alignment pending)
  "DENIED",              // failed a decision-quality check (no thesis / no edge)
  "BLOCKED",             // hard block (kill switch, governor lock, stale data)
  "ASSIGNED_TO_ANOTHER", // another agent owns this trade (one-owner-per-trade)
] as const;
export type SelfTradeDecisionOutcome = (typeof SELF_TRADE_DECISION_OUTCOMES)[number];

// Conflict classification for one-owner-per-trade resolution.
export const SELF_TRADE_CONFLICT_STATES = [
  "NONE",
  "DUPLICATE",              // same agent-cycle duplicate
  "SAME_SYMBOL_SAME_SIDE",  // two agents, same symbol+side → highest rank owns
  "SAME_SYMBOL_OPPOSITE",   // two agents, opposing sides on one symbol
  "CORRELATED",             // correlated-symbol exposure conflict
] as const;
export type SelfTradeConflictState = (typeof SELF_TRADE_CONFLICT_STATES)[number];

export const selfTradeDecisionsTable = pgTable("self_trade_decisions", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull(),
  agentKey: text("agent_key").notNull(),
  cycleId: text("cycle_id").notNull(), // groups one fleet evaluation cycle
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull().default("M5"),
  side: text("side"), // BUY | SELL | null when no directional edge

  outcome: text("outcome").notNull(), // SELF_TRADE_DECISION_OUTCOMES
  setupType: text("setup_type"),      // classifier label (or null when none)
  setupScore: doublePrecision("setup_score").notNull().default(0),
  rankScore: doublePrecision("rank_score").notNull().default(0),
  noTradeScore: doublePrecision("no_trade_score").notNull().default(0),
  confidence: doublePrecision("confidence").notNull().default(0),
  confidenceDecayed: doublePrecision("confidence_decayed").notNull().default(0),

  plannedAction: text("planned_action").notNull(),
  reason: text("reason").notNull(),
  riskState: text("risk_state"), // governor-derived band (HEALTHY/WATCH/...)

  // Structured payloads.
  quotaProgress: jsonb("quota_progress").notNull().default({}),
  handshakes: jsonb("handshakes").notNull().default([]),     // ordered check[]
  scoreBreakdown: jsonb("score_breakdown").notNull().default({}),
  thesis: jsonb("thesis"),                                   // null ⇒ no decision

  // One-owner-per-trade conflict resolution.
  ownerAgentKey: text("owner_agent_key"),
  conflictState: text("conflict_state").notNull().default("NONE"),

  // Setup expiry + decay lifecycle.
  setupExpiresAt: timestamp("setup_expires_at", { withTimezone: true }),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentIdx: index("self_trade_decisions_agent_idx").on(t.agentId),
  symbolIdx: index("self_trade_decisions_symbol_idx").on(t.symbol),
  cycleIdx: index("self_trade_decisions_cycle_idx").on(t.cycleId),
  agentCreatedIdx: index("self_trade_decisions_agent_created_idx").on(t.agentId, t.createdAt),
}));

// ── 9. Self-trade AGENT EXECUTIONS (Autonomous Live Execution, Task #213) ────
// One row per autonomous execution attempt produced from a supervisor-APPROVED
// decision. This table is the agent-side ledger of truth that links a decision
// → the live command it produced (arx_live_commands.commandId) → the real
// broker fill (brokerTicket) → close → realized P/L → agent ledger entries.
//
// SAFETY (inviolable):
// - This table NEVER places an order. The real order is dispatched ONLY through
//   the existing executeInstant → createLiveDraft → confirm → dispatch → 16-gate
//   Phase B pipeline → master bridge. This row only records the attempt and its
//   real outcome.
// - dispatch ≠ fill. A DISPATCHED row means the command reached the bridge; it
//   becomes FILLED ONLY when a real brokerTicket + LIVE_FILLED arrives. Fills
//   are never fabricated.
// - The partial-unique index over active states blocks a second live dispatch
//   for the same (agentId, idempotencyKey) — agent-layer exactly-once.
export const SELF_TRADE_EXECUTION_STATUSES = [
  "PENDING_TICKET", // L1 prepare-only: draft staged, awaiting human confirm
  "DISPATCHED",     // sent to the bridge via the existing pipeline (NOT a fill)
  "FILLED",         // real broker fill confirmed (brokerTicket present)
  "REJECTED",       // pipeline/EA/broker rejected the entry
  "BLOCKED",        // execution gate / 16-gate refused (carries blockReason)
  "CLOSED",         // position closed (manual, managed, or broker)
  "EXPIRED",        // command TTL elapsed before the EA executed it
] as const;
export type SelfTradeExecutionStatus = (typeof SELF_TRADE_EXECUTION_STATUSES)[number];

export const selfTradeAgentExecutionsTable = pgTable("self_trade_agent_executions", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull(),
  agentKey: text("agent_key").notNull(),
  decisionId: integer("decision_id"),       // self_trade_decisions.id (nullable)
  cycleId: text("cycle_id"),                 // groups the originating cycle

  symbol: text("symbol").notNull(),
  side: text("side").notNull(),              // BUY | SELL
  autonomyLevel: integer("autonomy_level").notNull().default(0),
  mode: text("mode").notNull().default("SHADOW"),

  // The user context the order was dispatched under (agent owner / operator).
  executingUserId: integer("executing_user_id"),

  intendedVolume: doublePrecision("intended_volume").notNull().default(0),
  slPrice: doublePrecision("sl_price"),
  tpPrice: doublePrecision("tp_price"),

  // Link to the real live command + its outcome.
  commandId: text("command_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("PENDING_TICKET"),
  brokerTicket: text("broker_ticket"),
  fillPrice: doublePrecision("fill_price"),
  closePrice: doublePrecision("close_price"),
  realizedPnl: doublePrecision("realized_pnl"),
  blockReason: text("block_reason"),

  // Autonomous management state (BE moved, partials taken, last action, …).
  managementState: jsonb("management_state").notNull().default({}),

  openedAt: timestamp("opened_at", { withTimezone: true }),
  filledAt: timestamp("filled_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  agentIdx: index("self_trade_agent_executions_agent_idx").on(t.agentId),
  agentStatusIdx: index("self_trade_agent_executions_agent_status_idx").on(t.agentId, t.status),
  agentCreatedIdx: index("self_trade_agent_executions_agent_created_idx").on(t.agentId, t.createdAt),
  commandIdx: index("self_trade_agent_executions_command_idx").on(t.commandId),
  // Agent-layer exactly-once: at most one active execution per (agent, key).
  // Terminal states (REJECTED/BLOCKED/CLOSED/EXPIRED) are intentionally not
  // covered so a fresh decision can re-attempt with a new key.
  idemActiveUq: uniqueIndex("self_trade_agent_executions_idem_active_uq")
    .on(t.agentId, t.idempotencyKey)
    .where(sql`status in ('PENDING_TICKET','DISPATCHED','FILLED')`),
}));

// ── Types + insert schemas ──────────────────────────────────────────────────
export type SelfTradeAgentExecution = typeof selfTradeAgentExecutionsTable.$inferSelect;
export type NewSelfTradeAgentExecution = typeof selfTradeAgentExecutionsTable.$inferInsert;
export type SelfTradeDecision = typeof selfTradeDecisionsTable.$inferSelect;
export type NewSelfTradeDecision = typeof selfTradeDecisionsTable.$inferInsert;
export type SelfTradeAgent = typeof selfTradeAgentsTable.$inferSelect;
export type NewSelfTradeAgent = typeof selfTradeAgentsTable.$inferInsert;
export type SelfTradeAgentSettings = typeof selfTradeAgentSettingsTable.$inferSelect;
export type NewSelfTradeAgentSettings = typeof selfTradeAgentSettingsTable.$inferInsert;
export type SelfTradeAgentLedger = typeof selfTradeAgentLedgerTable.$inferSelect;
export type SelfTradeLedgerEntry = typeof selfTradeLedgerEntriesTable.$inferSelect;
export type NewSelfTradeLedgerEntry = typeof selfTradeLedgerEntriesTable.$inferInsert;
export type SelfTradeAllocation = typeof selfTradeAllocationsTable.$inferSelect;
export type NewSelfTradeAllocation = typeof selfTradeAllocationsTable.$inferInsert;
export type SelfTradeKillSwitch = typeof selfTradeKillSwitchesTable.$inferSelect;
export type SelfTradeAuditLogRow = typeof selfTradeAuditLogTable.$inferSelect;
export type NewSelfTradeAuditLogRow = typeof selfTradeAuditLogTable.$inferInsert;

export const insertSelfTradeAgentSchema =
  createInsertSchema(selfTradeAgentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSelfTradeAgent = z.infer<typeof insertSelfTradeAgentSchema>;
