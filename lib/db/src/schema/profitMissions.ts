// ── Profit Mission Phase 1 — Planner, Feasibility & Dashboard Shell ─────────
//
// SAFETY / SCOPE:
//   - PLANNING + DISPLAY ONLY. A profit_missions row is a user's stated goal
//     plus the SERVER-COMPUTED feasibility / probability / pace read. It NEVER
//     gates, relaxes, or touches any execution path — no agents, no proposals,
//     no trade drafts, no live/demo dispatch in this phase.
//   - Strictly per-user: every read/write is scoped by user_id. No row from one
//     user is ever returned to another.
//   - Missions default to status='draft' and automationLevel=2 (approval mode).
//     There is no execution path yet; later phases plug into this shell.
//
// Constrained text vocabularies (validated in app code, not DB enums — same
// "single text column" pattern as users.role / agents.currentStatus):
//   riskProfile   : conservative | balanced | aggressive | extreme
//   executionMode : paper | demo | live
//   status        : draft | active | paused | completed | failed | cancelled
//   currentMode   : planning | running | review

import { sql } from "drizzle-orm";
import {
  pgTable, serial, integer, text, doublePrecision, real, jsonb, timestamp, boolean, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const profitMissionsTable = pgTable("profit_missions", {
  id:               serial("id").primaryKey(),
  userId:           integer("user_id").notNull(),

  // Goal inputs (money in account currency).
  startingAmount:   doublePrecision("starting_amount").notNull(),
  targetAmount:     doublePrecision("target_amount").notNull(),
  // Server-computed convenience (targetAmount - startingAmount).
  requiredProfit:   doublePrecision("required_profit").notNull(),

  timeframeStart:   timestamp("timeframe_start", { withTimezone: true }).notNull().defaultNow(),
  timeframeEnd:     timestamp("timeframe_end", { withTimezone: true }).notNull(),

  // Flexible timeframe — minutes-first model (Task #696).
  // timeframeStart/End are kept for backward compat; these carry the richer unit detail.
  timeframeAmount:  doublePrecision("timeframe_amount"),
  timeframeUnit:    text("timeframe_unit"),   // "minutes" | "hours" | "days" | "weeks"
  timeframeMinutes: doublePrecision("timeframe_minutes"),
  timeframeLabel:   text("timeframe_label"),  // e.g. "30 minutes", "1 day"

  riskProfile:      text("risk_profile").notNull().default("balanced"),
  // Phase 1 is display-only; default execution surface is paper.
  executionMode:    text("execution_mode").notNull().default("paper"),
  // Automation Level 2 = approval mode (no autonomous execution).
  automationLevel:  integer("automation_level").notNull().default(2),

  status:           text("status").notNull().default("draft"),
  currentMode:      text("current_mode").notNull().default("planning"),

  // Free-form mission settings (preferred symbols, asset classes, style, …).
  settingsJson:     jsonb("settings_json"),

  // Live header data — current account value tracked against the goal.
  currentValue:     doublePrecision("current_value").notNull().default(0),

  // Server-computed reads (snapshots at create-time; recomputed on pulse).
  progressJson:     jsonb("progress_json"),
  feasibilityJson:  jsonb("feasibility_json"),
  probabilityJson:  jsonb("probability_json"),
  riskJson:         jsonb("risk_json"),

  // ── Phase 9 — promotion / certificate state ───────────────────────────────
  //   liveAutoEnabled is the EXPLICIT, opt-in user enablement required (alongside
  //   all promotion gates + the platform live gates) before any live-auto level
  //   may run. It defaults false and is never flipped silently. The certificate
  //   acceptance is append-only evidence (timestamp + accepted phrase snapshot).
  //   promotionJson holds the latest promotion read (paused flag/reason, drift
  //   severity, last gate evaluation, test-result summaries) — display/governance
  //   only; nothing here relaxes or bypasses any live execution gate.
  liveAutoEnabled:        boolean("live_auto_enabled").notNull().default(false),
  certificateAcceptedAt:  timestamp("certificate_accepted_at", { withTimezone: true }),
  certificateAcceptanceJson: jsonb("certificate_acceptance_json"),
  promotionJson:          jsonb("promotion_json"),

  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:      timestamp("completed_at", { withTimezone: true }),
}, (t) => ({
  userIdx:        index("profit_missions_user_idx").on(t.userId),
  userStatusIdx:  index("profit_missions_user_status_idx").on(t.userId, t.status),
  userCreatedIdx: index("profit_missions_user_created_idx").on(t.userId, t.createdAt),
}));

export type ProfitMissionRow = typeof profitMissionsTable.$inferSelect;
export type NewProfitMission = typeof profitMissionsTable.$inferInsert;

// ── Phase 2 — append-only mission journal + progress snapshots ──────────────
//
// SAFETY / SCOPE:
//   - APPEND-ONLY. Every meaningful mission decision/state change writes a
//     mission_events row; periodic progress is captured in mission_snapshots.
//     There is NO update or delete path for either table — the journal is the
//     accountability trail and users can never edit or remove it.
//   - Per-user isolation is enforced upstream: both tables are keyed by
//     mission_id, and every read/write first verifies the mission belongs to the
//     requesting user (ownMission gate) before touching its events/snapshots.
//   - OBSERVATION ONLY. Nothing here touches a trade, the EA, a broker, or any
//     execution gate.
//
// Constrained text vocabulary (validated in app code via @workspace/domain's
// MissionEventType, not a DB enum):
//   type : mission_created | status_changed | paused | resumed | cancelled
//        | settings_updated | feasibility_recorded | mode_changed
//        | snapshot_taken | risk_stop | target_reached | expired

export const missionEventsTable = pgTable("mission_events", {
  id:           serial("id").primaryKey(),
  missionId:    integer("mission_id").notNull(),   // -> profit_missions.id
  type:         text("type").notNull(),
  message:      text("message"),
  metadataJson: jsonb("metadata_json"),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  missionIdx:        index("mission_events_mission_idx").on(t.missionId),
  missionCreatedIdx: index("mission_events_mission_created_idx").on(t.missionId, t.createdAt),
}));

export type MissionEventRow = typeof missionEventsTable.$inferSelect;
export type NewMissionEvent = typeof missionEventsTable.$inferInsert;

export const missionSnapshotsTable = pgTable("mission_snapshots", {
  id:           serial("id").primaryKey(),
  missionId:    integer("mission_id").notNull(),   // -> profit_missions.id
  snapshotJson: jsonb("snapshot_json").notNull().default({}),
  createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  missionIdx:        index("mission_snapshots_mission_idx").on(t.missionId),
  missionCreatedIdx: index("mission_snapshots_mission_created_idx").on(t.missionId, t.createdAt),
}));

export type MissionSnapshotRow = typeof missionSnapshotsTable.$inferSelect;
export type NewMissionSnapshot = typeof missionSnapshotsTable.$inferInsert;

// ── Phase 3 — Multi-Agent Proposal System (advisory artifacts only) ─────────
//
// SAFETY / SCOPE:
//   - A mission gets a team of specialist advisory agents (mission_agents) that
//     COMPOSE the existing advisory/shadow agent ecosystem + strategy/scanner
//     engines into a mission context. They produce STRUCTURED PROPOSAL RECORDS
//     (mission_proposals) the user can read. Proposals are analysis artifacts
//     ONLY — there is NO draft, no approval-to-execute, no order placement, and
//     nothing here touches the instant-trade router, live pipeline, or MT5
//     bridge. Agents fail-open to "no proposal" and can never relax a gate.
//   - Strictly per-user / per-mission: both tables carry user_id AND mission_id;
//     every read first verifies the mission belongs to the requesting user
//     (ownMission gate) and additionally filters by user_id. No row from one
//     user/mission is ever returned to another.
//   - Feed honesty (Scanner Truth): a proposal is only minted from real feed
//     truth. Stale/blocked/no-edge conditions yield an honest "no proposal /
//     context-only" record, never a fabricated or simulator-derived setup.
//
// Constrained text vocabularies (validated in app code, not DB enums — same
// "single text column" pattern as users.role / agents.currentStatus):
//   mission_agents.agentKey : SCALPER | TREND | REVERSAL | GOLD | SYNTHETIC
//                           | FOREX | RISK | JUDGE
//   mission_agents.status   : active | shadow | learning_camp | probation
//                           | restricted | disabled
//     (status/rank/weight/performanceJson are advisory ranking signals only;
//      Phase 3 seeds the team at defaults — Phase 4 evolves them by evidence.)
//   mission_proposals.direction : BUY | SELL | NONE
//   mission_proposals.urgency   : low | medium | high
//   mission_proposals.status    : proposed | selected | rejected | vetoed
//                               | expired | context_only

export const missionAgentsTable = pgTable("mission_agents", {
  id:               serial("id").primaryKey(),
  missionId:        integer("mission_id").notNull(),   // -> profit_missions.id
  userId:           integer("user_id").notNull(),      // mirrors mission owner

  // Team role key (see vocabulary above).
  agentKey:         text("agent_key").notNull(),
  // The ecosystem registry agent this role composes onto (agents.agent_key,
  // e.g. SCALP_AI / STRUCT / RISK / EXEC), or null for a pure mission role.
  registryAgentKey: text("registry_agent_key"),

  name:             text("name").notNull(),
  role:             text("role").notNull(),

  // Advisory ranking signals (ranking/visibility only — never execution).
  // Phase 3 seeds defaults; Phase 4 evolves these by reviewed evidence.
  status:           text("status").notNull().default("active"),
  rank:             integer("rank").notNull().default(0),
  weight:           real("weight").notNull().default(0),
  performanceJson:  jsonb("performance_json"),

  createdAt:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  missionIdx:     index("mission_agents_mission_idx").on(t.missionId),
  userIdx:        index("mission_agents_user_idx").on(t.userId),
  // One row per (mission, role) — idempotent team seeding.
  missionAgentUx: uniqueIndex("mission_agents_mission_agent_ux").on(t.missionId, t.agentKey),
}));

export type MissionAgentRow = typeof missionAgentsTable.$inferSelect;
export type NewMissionAgent = typeof missionAgentsTable.$inferInsert;

export const missionProposalsTable = pgTable("mission_proposals", {
  id:                   serial("id").primaryKey(),
  // Stable external id (idempotent dedupe within a scan run).
  proposalId:           text("proposal_id").notNull(),
  missionId:            integer("mission_id").notNull(),   // -> profit_missions.id
  userId:               integer("user_id").notNull(),      // mirrors mission owner
  missionAgentId:       integer("mission_agent_id").notNull(), // -> mission_agents.id
  agentKey:             text("agent_key").notNull(),

  symbol:               text("symbol").notNull(),
  timeframe:            text("timeframe").notNull(),
  direction:            text("direction").notNull().default("NONE"),
  setupType:            text("setup_type"),

  confidence:           real("confidence").notNull().default(0),
  urgency:              text("urgency").notNull().default("low"),
  expectedR:            doublePrecision("expected_r"),
  riskAmount:           doublePrecision("risk_amount"),

  // Structured plans + placeholders for later phases (kept null in Phase 3).
  entryPlanJson:        jsonb("entry_plan_json"),            // entry zone/price, SL, TP
  riskPlanJson:         jsonb("risk_plan_json"),             // sl, tp, risk amount, R
  edgeJson:             jsonb("edge_json"),                  // placeholder (Phase 5)
  executionQualityJson: jsonb("execution_quality_json"),    // placeholder (Phase 7)
  missionImpactJson:    jsonb("mission_impact_json"),        // placeholder
  marketSnapshotJson:   jsonb("market_snapshot_json"),       // market-intelligence snapshot
  warningsJson:         jsonb("warnings_json"),              // string[]

  reason:               text("reason"),
  invalidationLevel:    text("invalidation_level"),

  // Lifecycle (see vocabulary above). Risk Agent objection + Judge selection
  // annotation are recorded here — selection-only, never an execution decision.
  status:               text("status").notNull().default("proposed"),
  selectionReason:      text("selection_reason"),
  rejectionReason:      text("rejection_reason"),
  riskObjection:        text("risk_objection"),
  judgeDecision:        text("judge_decision"),

  createdAt:            timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt:           timestamp("expires_at", { withTimezone: true }),
}, (t) => ({
  missionIdx:        index("mission_proposals_mission_idx").on(t.missionId),
  userIdx:           index("mission_proposals_user_idx").on(t.userId),
  missionStatusIdx:  index("mission_proposals_mission_status_idx").on(t.missionId, t.status),
  missionCreatedIdx: index("mission_proposals_mission_created_idx").on(t.missionId, t.createdAt),
  proposalUx:        uniqueIndex("mission_proposals_proposal_ux").on(t.proposalId),
}));

export type MissionProposalRow = typeof missionProposalsTable.$inferSelect;
export type NewMissionProposal = typeof missionProposalsTable.$inferInsert;

// ── Phase 5 — Trade Drafts (reviewable / approvable; NO order placement) ─────
//
// SAFETY / SCOPE:
//   - APPROVAL ARTIFACTS ONLY. A mission_trade_drafts row is the best-debated
//     proposal turned into a reviewable, approvable TRADE DRAFT. Approving a
//     draft in this phase flips its status to `approved` and writes a journal
//     event — it NEVER places a live/demo order, and nothing here touches the
//     instant-trade router, live pipeline, or MT5 bridge. The `executed` status
//     is reserved for later phases; no Phase 5 code path drives it.
//   - The edge score (edge_json) is ADVISORY and capped honestly — it can only
//     LOWER a setup's standing, never raise it above a safety block. A draft is
//     never created from a stale-feed / extreme-spread / too-late edge.
//   - Strictly per-user / per-mission: every row carries user_id AND mission_id;
//     every read/write first verifies the mission belongs to the requesting user
//     (ownMission gate) and additionally filters by user_id.
//
// Constrained text vocabulary (validated in app code via @workspace/domain's
// TradeDraftStatus, not a DB enum):
//   status : proposed | waiting_confirmation | approved | rejected | expired
//          | executed | cancelled

export const missionTradeDraftsTable = pgTable("mission_trade_drafts", {
  id:                serial("id").primaryKey(),
  // Stable external id (idempotent dedupe across reads).
  draftId:           text("draft_id").notNull(),
  missionId:         integer("mission_id").notNull(),   // -> profit_missions.id
  userId:            integer("user_id").notNull(),      // mirrors mission owner

  // Source proposal (stable external id + row id for joins).
  proposalId:        text("proposal_id").notNull(),     // -> mission_proposals.proposal_id
  missionProposalRowId: integer("mission_proposal_row_id"), // -> mission_proposals.id
  agentKey:          text("agent_key").notNull(),

  symbol:            text("symbol").notNull(),
  timeframe:         text("timeframe").notNull(),
  direction:         text("direction").notNull().default("NONE"),

  // The reviewable plan (composed from existing engines; never re-derived).
  entryPrice:        doublePrecision("entry_price"),
  stopLoss:          doublePrecision("stop_loss"),
  takeProfit:        doublePrecision("take_profit"),
  lot:               doublePrecision("lot"),
  riskAmount:        doublePrecision("risk_amount"),
  expectedR:         doublePrecision("expected_r"),

  // Advisory edge read (capped honestly — never raises over a safety block).
  edgeScore:         real("edge_score"),
  edgeTier:          text("edge_tier"),
  edgeJson:          jsonb("edge_json"),
  // Best/expected/worst + pace deltas for TP vs SL.
  missionImpactJson: jsonb("mission_impact_json"),

  reason:            text("reason"),
  approvalReason:    text("approval_reason"),
  rejectionReason:   text("rejection_reason"),

  // Lifecycle (see vocabulary above). Approval = `approved`, never execution.
  status:            text("status").notNull().default("proposed"),

  // ── Phase 8 — Exit/result record (an executed draft IS the mission trade) ────
  //   Populated only AFTER the draft dispatches and later closes via the
  //   EXISTING instant-trade path. There is no `mission_trades` table; the
  //   executed draft carries the realised outcome so missed-profit/compounding
  //   can read from one place. All fields null until the trade is live/closed.
  brokerTicket:      text("broker_ticket"),          // broker fill ticket (when filled)
  commandId:         text("command_id"),             // arx_live_commands link
  pnl:               doublePrecision("pnl"),         // realised P/L, account currency
  rMultiple:         doublePrecision("r_multiple"),  // realised reward-to-risk
  mfe:               doublePrecision("mfe"),         // max favourable excursion (profit)
  mae:               doublePrecision("mae"),         // max adverse excursion (loss, ≤ 0)
  capturedProfit:    doublePrecision("captured_profit"),
  missedProfit:      doublePrecision("missed_profit"),
  exitReason:        text("exit_reason"),            // trigger that closed the trade
  resultJson:        jsonb("result_json"),           // exit decision + capture verdict snapshot
  closedAt:          timestamp("closed_at", { withTimezone: true }),

  // ── Paper/demo SIMULATED outcome — accounted SEPARATELY from broker truth ────
  //   A paper/demo mission never contacts a broker, so it can never produce the
  //   broker-reconciled columns above. Its outcome lands HERE instead, in its own
  //   column family, and `simulated` tags the row unmistakably at row level.
  //
  //   THE SEPARATION IS STRUCTURAL, NOT A FILTER: a simulated row's `pnl`,
  //   `r_multiple`, `closed_at`, `captured_profit` and `missed_profit` stay NULL
  //   FOREVER. Every existing consumer of realised money (mission realised stats,
  //   compounding, economic postings, ROI/champion/flywheel workers, the forward
  //   test aggregator's money legs) keys off `closed_at`/`pnl`, so a simulated
  //   outcome is incapable of reaching a live realised figure or an economic
  //   posting even if a future caller forgets to filter. Writers must never
  //   populate both families on one row.
  //
  //   `sim_json` carries the modelling assumptions and the REAL quote the fill
  //   was priced from (provider, timestamp, bid/ask), so no reader can mistake a
  //   simulated outcome for execution truth.
  simulated:         boolean("simulated").notNull().default(false),
  simEntryPrice:     doublePrecision("sim_entry_price"),
  simExitPrice:      doublePrecision("sim_exit_price"),
  simPnl:            doublePrecision("sim_pnl"),        // MODELLED P/L, never money
  simRMultiple:      doublePrecision("sim_r_multiple"),
  simMfe:            doublePrecision("sim_mfe"),
  simMae:            doublePrecision("sim_mae"),
  simExitReason:     text("sim_exit_reason"),
  simJson:           jsonb("sim_json"),                 // assumptions + quote provenance
  simOpenedAt:       timestamp("sim_opened_at", { withTimezone: true }),
  simClosedAt:       timestamp("sim_closed_at", { withTimezone: true }),

  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt:         timestamp("expires_at", { withTimezone: true }),
  approvedAt:        timestamp("approved_at", { withTimezone: true }),
  rejectedAt:        timestamp("rejected_at", { withTimezone: true }),
}, (t) => ({
  missionIdx:        index("mission_trade_drafts_mission_idx").on(t.missionId),
  userIdx:           index("mission_trade_drafts_user_idx").on(t.userId),
  missionStatusIdx:  index("mission_trade_drafts_mission_status_idx").on(t.missionId, t.status),
  missionCreatedIdx: index("mission_trade_drafts_mission_created_idx").on(t.missionId, t.createdAt),
  draftUx:           uniqueIndex("mission_trade_drafts_draft_ux").on(t.draftId),
  // At most one ACTIVE draft per source proposal (idempotent approve/create).
  activeDraftUx:     uniqueIndex("mission_trade_drafts_active_proposal_ux")
    .on(t.proposalId)
    .where(sql`status in ('proposed','waiting_confirmation','approved')`),
}));

export type MissionTradeDraftRow = typeof missionTradeDraftsTable.$inferSelect;
export type NewMissionTradeDraft = typeof missionTradeDraftsTable.$inferInsert;

// ── Phase 9 — Testing Lab results (append-only, honestly labelled) ──────────
//
// SAFETY / SCOPE:
//   - APPEND-ONLY evidence. Each row is one backtest (historical/simulated) or
//     forward-test (paper/demo/live) result for a mission strategy, persisted with
//     its honest label and a small-sample warning. There is NO update/delete path.
//   - ADVISORY ONLY. A result can describe a strategy's record; it can NEVER grant
//     live permission or bypass any live execution gate. Promotion reads these as
//     INPUT to the gate evaluator, never as authority.
//   - Strictly per-user / per-mission: every row carries user_id AND mission_id;
//     every read first verifies the mission belongs to the requesting user.
//   - Feed honesty: a FORWARD result is only written from REAL executed-trade
//     evidence — never fabricated to imply live performance.
//
// Constrained text vocabulary (validated in app code via @workspace/domain's
// MissionTestKind, not a DB enum):
//   kind : BACKTEST | FORWARD

export const missionTestResultsTable = pgTable("mission_test_results", {
  id:            serial("id").primaryKey(),
  missionId:     integer("mission_id").notNull(),   // -> profit_missions.id
  userId:        integer("user_id").notNull(),      // mirrors mission owner

  kind:          text("kind").notNull(),            // BACKTEST | FORWARD
  strategyKey:   text("strategy_key").notNull(),
  symbol:        text("symbol").notNull(),
  timeframe:     text("timeframe").notNull(),
  // Honest display label ("Historical / simulated" | "Forward (paper / demo / live)").
  label:         text("label").notNull(),

  sampleSize:    integer("sample_size").notNull().default(0),
  // Non-null when the sample is too small to be meaningful (shown to the user).
  sampleWarning: text("sample_warning"),
  // Normalized MissionTestMetrics snapshot + the engine summary.
  metricsJson:   jsonb("metrics_json").notNull().default({}),
  // True only when sample is sufficient AND a positive edge is present.
  isVerified:    boolean("is_verified").notNull().default(false),

  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  missionIdx:        index("mission_test_results_mission_idx").on(t.missionId),
  userIdx:           index("mission_test_results_user_idx").on(t.userId),
  missionKindIdx:    index("mission_test_results_mission_kind_idx").on(t.missionId, t.kind),
  missionCreatedIdx: index("mission_test_results_mission_created_idx").on(t.missionId, t.createdAt),
}));

export type MissionTestResultRow = typeof missionTestResultsTable.$inferSelect;
export type NewMissionTestResult = typeof missionTestResultsTable.$inferInsert;
