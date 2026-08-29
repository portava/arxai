// Phase A — ARX Live Trading Enablement (per-user).
//
// SAFETY (inviolable):
// - These tables are ADDITIVE. They do not touch the singleton
//   `live_trading_state`, `live_trade_approvals`, or any existing
//   live infrastructure.
// - The live command pipeline ALWAYS routes through
//   `placeLiveOrderGuarded()`, which still returns
//   `BROKER_PLACEMENT_LAYER_NOT_IMPLEMENTED`. Every row ends in
//   `LIVE_BLOCKED` until Phase B ships EA v1.27 + the broker layer.
// - `arx_live_arming` is per-user. There is no global "armed" state.
// - Server-side hard ceiling: 10% weekly portfolio drawdown.

import {
  pgTable, serial, integer, text, timestamp, jsonb, boolean,
  doublePrecision, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const ARX_LIVE_COMMAND_STATUSES = [
  "LIVE_DRAFT",
  "LIVE_CONFIRMATION_REQUIRED",
  "LIVE_APPROVED",
  "SENT_TO_MT5_LIVE",
  "LIVE_FILLED",
  "LIVE_REJECTED",
  "LIVE_FAILED",
  "LIVE_BLOCKED",
  "LIVE_CANCELLED",
  "LIVE_CLOSED",
  // Task #28 — a SENT_TO_MT5_LIVE command whose TTL elapsed before the EA
  // executed it (server-side sweep) OR which the EA refused as stale
  // (STALE_COMMAND_REJECTED). Terminal. A LIVE_EXPIRED command is never
  // re-served and never retried automatically. R2 S1: the sweep may only
  // stamp LIVE_EXPIRED on a row with NO pickup evidence (arx pickedByEaAt
  // null AND transport mirror never claimed) — provable non-delivery.
  "LIVE_EXPIRED",
  // R2 S5 (spec §12 / §20 "Acknowledged is not treated as filled") —
  // NON-TERMINAL execution stages between dispatch and a settled outcome.
  //
  // LIVE_ACKNOWLEDGED: the broker acknowledged the order but NO fill is
  // confirmed. An acknowledgement is not an execution; treating it as one is
  // exactly the conflation §20 forbids. Reservation stays HELD.
  // Reachable from the bridge-v2 TRADE_TRANSACTION lifecycle (REQUEST /
  // ORDER_ADD without a dealTicket). The production v1.5x EA posts only a
  // settled result, so this state is FORWARD-DECLARED for that path: the read
  // layer and transition table recognize it ahead of a v2 writer, exactly as
  // DEMO_PARTIALLY_FILLED was.
  "LIVE_ACKNOWLEDGED",
  // LIVE_PARTIALLY_FILLED: a broker ticket exists and executedVolume is
  // strictly between zero and requestedVolume. Emittable TODAY — the EA
  // already reports executedVolume; it was simply never classified, so a
  // partial landed as a full LIVE_FILLED. Reservation stays HELD: the
  // remainder is still working, so releasing on the filled portion would
  // under-count exposure.
  "LIVE_PARTIALLY_FILLED",
  // R2 S1 (audit-execution.md G1) — epistemic states. NON-TERMINAL.
  //
  // LIVE_UNKNOWN: the command was (or may have been) seen by the EA and no
  // confirmed broker outcome exists — TTL elapsed after pickup, or the EA
  // reported a success-looking status with no broker ticket. A real position
  // may exist at the broker, so the master exposure reservation is HELD, not
  // released, and duplicate submission stays blocked (idem index below).
  // Only reconciliation against broker truth may resolve it (R2 S3).
  "LIVE_UNKNOWN",
  // LIVE_RECONCILIATION_REQUIRED: an UNKNOWN command that automatic urgent
  // reconciliation could not resolve after N reliable sweeps — operator /
  // reconciler attention required before it may reach a terminal state.
  "LIVE_RECONCILIATION_REQUIRED",
] as const;
export type ArxLiveCommandStatus = (typeof ARX_LIVE_COMMAND_STATUSES)[number];

export const ARX_LIVE_COMMAND_TYPES = [
  "PLACE_LIVE_MARKET_ORDER",
  "PLACE_LIVE_PENDING_ORDER",
  "CLOSE_LIVE_POSITION",
  "MODIFY_LIVE_SLTP",
] as const;
export type ArxLiveCommandType = (typeof ARX_LIVE_COMMAND_TYPES)[number];

// Per-user arming. One row per user — no cross-user side effects.
export const arxLiveArmingTable = pgTable("arx_live_arming", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  isArmed: boolean("is_armed").notNull().default(false),
  armedAt: timestamp("armed_at", { withTimezone: true }),
  armedByUserId: integer("armed_by_user_id"),
  armedFromIp: text("armed_from_ip"),

  disarmedAt: timestamp("disarmed_at", { withTimezone: true }),
  disarmedReason: text("disarmed_reason"),

  // What the user confirmed during arming. We never store the raw confirmation
  // phrase plain; only its SHA-256 for audit, plus a length sanity check.
  confirmationPhraseHash: text("confirmation_phrase_hash"),
  accountNumberConfirmed: text("account_number_confirmed"),
  brokerServerConfirmed: text("broker_server_confirmed"),
  maxLotConfirmed: doublePrecision("max_lot_confirmed"),
  dailyLossLimitConfirmed: doublePrecision("daily_loss_limit_confirmed"),
  killSwitchAcknowledged: boolean("kill_switch_acknowledged").notNull().default(false),

  // Per-user kill switch — independent of singleton liveTradingStateTable.
  killSwitchEngaged: boolean("kill_switch_engaged").notNull().default(false),
  killSwitchEngagedAt: timestamp("kill_switch_engaged_at", { withTimezone: true }),
  killSwitchEngagedByUserId: integer("kill_switch_engaged_by_user_id"),
  killSwitchReason: text("kill_switch_reason"),

  // Snapshot of the 15-check gate result at arm time, for audit + UI replay.
  lastReadinessCheckAt: timestamp("last_readiness_check_at", { withTimezone: true }),
  lastReadinessSnapshot: jsonb("last_readiness_snapshot").notNull().default({}),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUq: uniqueIndex("arx_live_arming_user_uq").on(t.userId),
}));

// Per-user live command pipeline. Separate from `mt5_demo_commands` so a
// demo command can never accidentally route as live and vice versa.
export const arxLiveCommandsTable = pgTable("arx_live_commands", {
  id: serial("id").primaryKey(),
  commandId: text("command_id").notNull(),
  userId: integer("user_id").notNull(),

  bridgeConnectionId: integer("bridge_connection_id"),
  accountLogin: text("account_login"),
  brokerServer: text("broker_server"),
  accountNumber: text("account_number"),

  commandType: text("command_type").notNull(),
  status: text("status").notNull().default("LIVE_DRAFT"),

  symbol: text("symbol").notNull(),
  side: text("side").notNull(),                          // BUY | SELL
  orderType: text("order_type").notNull(),               // MARKET_BUY | MARKET_SELL | BUY_LIMIT | SELL_LIMIT | BUY_STOP | SELL_STOP | BUY_STOP_LIMIT | SELL_STOP_LIMIT
  requestedVolume: doublePrecision("requested_volume").notNull(),
  // Phase 6 — the EXECUTION VENUE this command is bound for. Explicit, never
  // inferred from the symbol.
  //
  // The default is a BACKFILL FACT, not a runtime fallback: every row created
  // before this column existed was bound to an mt5_connection by construction,
  // because the dispatch path had no other venue. Recording them as
  // MT5_EA_BRIDGE states something already true.
  //
  // It is NOT a licence to omit the venue on a new row. `routeExecutionVenue`
  // has no default and refuses an absent venue, and the CI guard
  // check-execution-venue-explicit asserts every writer sets this column
  // explicitly — so the column default cannot become the back door to the
  // default the router deliberately refuses to have.
  executionVenue: text("execution_venue").notNull().default("MT5_EA_BRIDGE"),
  executedVolume: doublePrecision("executed_volume"),
  stopLoss: doublePrecision("stop_loss"),
  takeProfit: doublePrecision("take_profit"),

  sourcePage: text("source_page").notNull().default("LIVE_TRADE_TICKET"),
  // e.g. LIVE_TRADE_TICKET | MARKET_SCANNER_LIVE | OPEN_LIVE_POSITIONS_CLOSE | LIVE_POSITION_MODIFY
  rubyExplanationSummary: text("ruby_explanation_summary"),

  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  brokerTicket: text("broker_ticket"),
  fillPrice: doublePrecision("fill_price"),
  mt5Retcode: integer("mt5_retcode"),
  brokerMessage: text("broker_message"),
  rejectionReason: text("rejection_reason"),

  // Snapshot of the safety gate at the moment of dispatch. Audit-only.
  dispatchGateSnapshot: jsonb("dispatch_gate_snapshot").notNull().default({}),
  payload: jsonb("payload").notNull().default({}),

  // Phase B — idempotency. SHA-256 of (userId|symbol|side|lot|sl|tp|minuteBucket).
  // A partial unique index prevents a second SENT_TO_MT5_LIVE for the same key.
  idempotencyKey: text("idempotency_key"),
  // Phase B — picked by EA fingerprint (account login + EA session id + timestamp).
  pickedByEaAt: timestamp("picked_by_ea_at", { withTimezone: true }),

  // ── Task #28 — command lifecycle / TTL / ownership ──────────────────────
  // Stamped at dispatch (SENT_TO_MT5_LIVE). A command that is not executed
  // by the EA before `expiresAt` is swept to LIVE_EXPIRED server-side and is
  // also refused by the EA (STALE_COMMAND_REJECTED). This guarantees a live
  // command can never fire late after a network stall.
  ttlSeconds: integer("ttl_seconds"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Authoritative server clock at dispatch, so the EA can compare its own
  // wall-clock against ARX time and reject drift-stale commands.
  serverTimestamp: timestamp("server_timestamp", { withTimezone: true }),
  expiredAt: timestamp("expired_at", { withTimezone: true }),

  // Ownership linking — lets every live command be traced back to the
  // allocation, test cycle, and originating flow that produced it. All
  // nullable; purely additive audit/traceability columns.
  allocationId: integer("allocation_id"),
  cycleId: text("cycle_id"),
  source: text("source"),

  // Task #213 — Self-Trade AI autonomous ownership. When a live command was
  // produced by an autonomous agent decision (NOT a human click), these tie it
  // back to the agent + the supervisor decision that authorized it. Both
  // nullable + additive; a human-originated command leaves them NULL and behaves
  // exactly as before. The full ownership tag set also lives in `payload`.
  selfTradeAgentId: integer("self_trade_agent_id"),
  selfTradeDecisionId: integer("self_trade_decision_id"),

  // Foundation gate #19 — command provenance envelope. Stamped by
  // createLiveDraft for ENTRY drafts: {v, originActorType, producer{...},
  // dataSource, sourceId, asOf, capturedAt} (see api-server
  // lib/provenance/commandProvenance.ts). A byte-identical copy also lives in
  // `payload.commandProvenance`, which IS covered by payload_hash — the
  // dispatch gate compares the two, so the envelope cannot be forged between
  // confirm and dispatch. Nullable + additive: a NULL on an entry means "no
  // provenance" and gate #19 refuses LIVE dispatch (default-deny); close/
  // modify ops rows leave it NULL and are exempt. Migration: additive
  // nullable column, no backfill (drizzle push on Replit later).
  provenanceEnvelope: jsonb("provenance_envelope"),

  // Foundation gate #20 — promotion-ledger reference. Points at
  // production_edges.id for the strategy/edge that produced this command.
  // Deliberately NO .references() (same precedent as assignedRiskTemplateId)
  // so tests/dev can populate either side first; the dispatch gate treats a
  // dangling reference as "row not found" and refuses (fail closed).
  // Nullable + additive: human manual commands leave it NULL (gate #20 not
  // required for USER/ADMIN/OWNER actors); an autonomous entry with NULL is
  // REFUSED at dispatch. Migration: additive nullable column, no backfill.
  edgeId: integer("edge_id"),

  // R3 slice 5 — signal-provenance timestamp. When the caller knows WHEN the
  // signal/decision behind an entry was generated (scanner signal time, agent
  // decision time), createLiveDraft threads it here. Nullable + additive: a
  // NULL means "no timing provenance supplied". The dispatch signal-age
  // pre-gate refuses entries older than arx_live_user_settings.
  // max_signal_age_ms — and, fail-closed, refuses entries with a NULL stamp
  // while a bound is configured (a bound demands provenance of timing).
  // Migration: additive nullable column, no backfill needed (drizzle push on
  // Replit later; existing rows read as NULL = no provenance).
  signalTimestamp: timestamp("signal_timestamp", { withTimezone: true }),

  // ── AACI Security Phase 3 — Command Integrity & Live Execution Protection ──
  // Tamper / replay / source protection for sensitive (live) commands. All
  // additive + nullable; a legacy row with NULLs is treated as integrity
  // UNVERIFIED by the dispatch verifier (default-deny → block + admin alert).
  //
  // - payload_hash:        SHA-256 of the canonical trade-critical parameters
  //   (commandType, symbol, side, orderType, requestedVolume, SL, TP, and the
  //   meaningful payload). Stamped at draft; re-derived at dispatch and compared
  //   — any change to the approved order between confirm and dispatch is a tamper.
  // - integrity_hash:      HMAC-SHA256 (node:crypto) over the integrity envelope
  //   {commandId, userId, actorId, actorType, actionType, payloadHash, keyVersion}
  //   keyed by a server secret (key-separated from SESSION_SECRET). The
  //   signature; recomputed + compared at dispatch. NULL only in placeholder
  //   (CREATED) mode when no server secret is available.
  // - integrity_key_version: signing key generation (1 = signed/ACTIVE,
  //   0 = placeholder). Future-ready for key rotation.
  // - integrity_status:    'ACTIVE' (signed) | 'CREATED' (placeholder, payload
  //   hash only — no signing key available in this environment).
  // - actor_id / actor_type: the principal that authored the command
  //   (USER | ADMIN | OWNER | SELF_TRADE_AGENT | SYSTEM) for source validation.
  // - action_type:         the sensitive-action class (mirrors commandType class)
  //   bound into the signature so a command cannot be repurposed.
  payloadHash: text("payload_hash"),
  integrityHash: text("integrity_hash"),
  integrityKeyVersion: integer("integrity_key_version"),
  integrityStatus: text("integrity_status"),
  actorId: integer("actor_id"),
  actorType: text("actor_type"),
  actionType: text("action_type"),

  // Dedup result-capture — first EA result wins. A second result POST for an
  // already-terminal command is ignored (DUPLICATE_IGNORED) but counted +
  // timestamped here for audit, never re-applied.
  resultRecordedAt: timestamp("result_recorded_at", { withTimezone: true }),
  duplicateResultCount: integer("duplicate_result_count").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentToMt5At: timestamp("sent_to_mt5_at", { withTimezone: true }),
  filledAt: timestamp("filled_at", { withTimezone: true }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => ({
  cmdUq: uniqueIndex("arx_live_commands_command_id_uq").on(t.commandId),
  userIdx: index("arx_live_commands_user_idx").on(t.userId),
  statusIdx: index("arx_live_commands_status_idx").on(t.status),
  userStatusIdx: index("arx_live_commands_user_status_idx").on(t.userId, t.status),
  createdAtIdx: index("arx_live_commands_created_at_idx").on(t.createdAt),
  // Per-user command history / timeline (user + recency).
  userCreatedIdx: index("arx_live_commands_user_created_at_idx").on(t.userId, t.createdAt),
  // Phase B — DB-layer belt against duplicate dispatch while a command is
  // in flight to the EA or already filled. Terminal states (REJECTED/FAILED/
  // BLOCKED/CANCELLED/CLOSED) are intentionally NOT covered so the user can
  // retry after a failure with the same key in a new minute bucket.
  // R2 S1 (audit G1e) — LIVE_UNKNOWN / LIVE_RECONCILIATION_REQUIRED are
  // covered: an unconfirmed outcome may be standing at the broker, so the
  // identical order must be refused until reconciliation resolves it.
  idemUq: uniqueIndex("arx_live_commands_idem_active_uq")
    .on(t.userId, t.idempotencyKey)
    .where(sql`status in ('SENT_TO_MT5_LIVE','LIVE_FILLED','LIVE_UNKNOWN','LIVE_RECONCILIATION_REQUIRED')`),
}));

// Phase B — Live positions. SEPARATE from `live_positions` (Build TT) and
// from any demo position table. EA v1.27+ pushes snapshots here only when
// AccountType=LIVE. Per-user.
export const arxLivePositionsTable = pgTable("arx_live_positions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  bridgeConnectionId: integer("bridge_connection_id").notNull(),
  brokerTicket: text("broker_ticket").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),
  volume: doublePrecision("volume").notNull(),
  entryPrice: doublePrecision("entry_price").notNull(),
  currentPrice: doublePrecision("current_price"),
  floatingPl: doublePrecision("floating_pl"),
  stopLoss: doublePrecision("stop_loss"),
  takeProfit: doublePrecision("take_profit"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  sourceCommandId: text("source_command_id"),
  accountLogin: text("account_login"),
  brokerServer: text("broker_server"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  // Reconciles with the live DB column (created at row insert). Declared here so
  // `drizzle-kit push` does not propose a destructive drop of an existing,
  // populated column. Additive/non-destructive.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Task #31 — operator orphan-position resolution. An open arx_live_position
  // with no matching arx_live_commands row is an ORPHAN_BROKER_POSITION in the
  // Reconciliation Center. An admin may explicitly resolve it WITHOUT ever
  // auto-assigning ownership:
  //   IGNORED   — acknowledged, intentionally left at the broker (audited).
  //   EXTERNAL  — confirmed placed outside ARX; tracked as external (audited).
  //   IMPORTED  — manually linked to an existing command (sourceCommandId set).
  // Any non-null reconcileState removes the row from the orphan detector. The
  // server NEVER sets ownership/userId automatically — every transition is an
  // explicit, audited operator action.
  //   RECONCILED_BROKER_ABSENT — broker-side close (manual/SL/TP/stop-out)
  //     confirmed absent across N consecutive RELIABLE complete sweeps. Set by
  //     the Broker-Side Close Reconciliation Guardrail (never by a broker
  //     command). closed_at is stamped alongside; reconcileReason records the
  //     evidence. Distinct from the ARX-initiated LIVE_FILLED close path (which
  //     stamps closed_at with reconcileState left NULL).
  reconcileState: text("reconcile_state"), // null | IGNORED | EXTERNAL | IMPORTED | RECONCILED_BROKER_ABSENT
  reconcileNote: text("reconcile_note"),
  reconciledByAdminId: integer("reconciled_by_admin_id"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  // Broker-Side Close Reconciliation Guardrail — consecutive reliable-absence
  // evidence. ALL additive + nullable (count defaults 0). Updated ONLY on a
  // reliable COMPLETE EA sweep: the counter resets to 0 when the position
  // reappears in the broker snapshot and increments when it is absent. A row is
  // eligible to be stamped closed (reconcileState=RECONCILED_BROKER_ABSENT)
  // ONLY after `brokerAbsentSnapshotCount` >= N AND the first-absence is old
  // enough. Never auto-closes on a single missing snapshot; process restarts do
  // not reset the evidence because it lives on the row, not in memory.
  brokerAbsentSnapshotCount: integer("broker_absent_snapshot_count").notNull().default(0),
  firstBrokerAbsentAt: timestamp("first_broker_absent_at", { withTimezone: true }),
  lastBrokerAbsentAt: timestamp("last_broker_absent_at", { withTimezone: true }),
  lastReliableSnapshotAt: timestamp("last_reliable_snapshot_at", { withTimezone: true }),
  // Human/audit-readable evidence string for a broker-absence reconciliation
  // (e.g. "absent across 3 reliable sweeps; first absent 2026-06-07T...").
  reconcileReason: text("reconcile_reason"),
  // ── Broker-REPORTED close (outcome truth). ALL additive + nullable. ─────────
  // Set ONLY from an explicit broker/EA close report for this ticket — a close
  // ARX did not issue (stop-loss, stop-out, manual close at the terminal). These
  // hold the BROKER's own numbers verbatim; ARX never derives them from the
  // stop-loss level, the take-profit level, or the last floating P/L. When the
  // broker reports a close WITHOUT numbers these stay NULL and the mission
  // outcome is recorded as UNRECONCILED rather than guessed.
  //
  // DEPLOY ORDER: `docs/migrations-pending/fix-outcome-truth.sql` MUST be
  // applied to a database BEFORE code carrying these three fields is deployed
  // against it. Additive in the DB, NOT backward-compatible in the code: a bare
  // `db.select()` on this table emits an explicit column list from this model,
  // so every live-position read (~10 call sites) fails 42703 against an
  // unmigrated database. The SQL file lists the call sites and the verification
  // query. Code rollback is safe; SQL rollback under new code is not.
  brokerCloseReportedAt: timestamp("broker_close_reported_at", { withTimezone: true }),
  brokerClosePrice: doublePrecision("broker_close_price"),
  brokerRealisedPnl: doublePrecision("broker_realised_pnl"),
  // Capability #44 — manual takeover as a first-class per-position state.
  //   STRATEGY_MANAGED (default) — automated strategy management may act.
  //   MANUAL_CONTROL             — the owner has taken the position over; every
  //                                automated management command MUST refuse
  //                                (see lib/domain self-trade/manualTakeover +
  //                                missionExitManager guard). Protective
  //                                MONITORING continues; only automated ACTION
  //                                stops. Release back is an explicit press.
  // All columns additive + defaulted, never destructive.
  managementState: text("management_state").notNull().default("STRATEGY_MANAGED"),
  manualTakeoverAt: timestamp("manual_takeover_at", { withTimezone: true }),
  manualTakeoverReason: text("manual_takeover_reason"),
  manualReleaseAt: timestamp("manual_release_at", { withTimezone: true }),
}, (t) => ({
  userTicketUq: uniqueIndex("arx_live_positions_user_ticket_uq").on(t.userId, t.brokerTicket),
  userOpenIdx: index("arx_live_positions_user_open_idx").on(t.userId, t.closedAt),
}));

// Per-user trading style + hard ceilings. Server hard caps live no matter what:
// - weeklyDrawdownCeilingPct ≤ 10
// - Sane per-market max lot defaults; users can lower but not exceed admin override
export const arxLiveUserSettingsTable = pgTable("arx_live_user_settings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),

  // Hard ceiling — server refuses values > 10. UI can pick lower.
  weeklyDrawdownCeilingPct: doublePrecision("weekly_drawdown_ceiling_pct").notNull().default(10),
  dailyLossLimitUsd: doublePrecision("daily_loss_limit_usd").notNull().default(0),

  // {EURUSD: 0.10, XAUUSD: 0.05, ...}. Anything not listed uses
  // ARX_LIVE_DEFAULT_MAX_LOT_PER_MARKET.
  maxLotPerMarket: jsonb("max_lot_per_market").notNull().default({}),
  allowedSymbols: jsonb("allowed_symbols").notNull().default([]),

  requireStopLoss: boolean("require_stop_loss").notNull().default(true),
  adminAllowNoStopLoss: boolean("admin_allow_no_stop_loss").notNull().default(false),

  // ── Wave-4 dispatch pre-gate caps. ALL nullable + additive: NULL means the
  // corresponding gate is not configured (skipped / no bound / no cap) —
  // existing rows and users change behaviour ONLY by explicitly setting a
  // value. Migration: additive nullable columns, no backfill, no default
  // (drizzle push on Replit later). NOTE deliberate contrast with the NOT
  // NULL DEFAULT 0 caps above: for these, 0 is a REAL cap of zero (the
  // 0-as-unlimited trap is not reproduced); "off" is NULL.
  //
  // R3 slice 4 — price collar: max |draft-requested vs dispatch-reference|
  // deviation in BASIS POINTS for entries. NULL = server collar off (the
  // EA's own DEVIATION_TOO_LARGE guard still applies). With a cap set, an
  // unresolvable reference price fails CLOSED at dispatch.
  maxEntryDeviationBps: doublePrecision("max_entry_deviation_bps"),
  // R3 slice 5 — max age (ms) of arx_live_commands.signal_timestamp for
  // entries. NULL = no bound. With a bound set, a missing signal timestamp
  // fails CLOSED (a bound demands provenance of timing).
  maxSignalAgeMs: integer("max_signal_age_ms"),
  // Correlation guard (wires lib/domain risk-correlation, R3 slice 6 core):
  // caps on the candidate's (risk family × direction) cluster INCLUDING the
  // candidate — USD proxy risk and position count. NULL = no cap for that
  // dimension. Production values are an owner decision (the pure core ships
  // no defaults).
  maxClusterRiskUsd: doublePrecision("max_cluster_risk_usd"),
  maxClusterPositions: integer("max_cluster_positions"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userUq: uniqueIndex("arx_live_user_settings_user_uq").on(t.userId),
}));

export type ArxLiveArming = typeof arxLiveArmingTable.$inferSelect;
export type ArxLiveCommand = typeof arxLiveCommandsTable.$inferSelect;
export type NewArxLiveCommand = typeof arxLiveCommandsTable.$inferInsert;
export type ArxLiveUserSettings = typeof arxLiveUserSettingsTable.$inferSelect;
export type ArxLivePosition = typeof arxLivePositionsTable.$inferSelect;
export type NewArxLivePosition = typeof arxLivePositionsTable.$inferInsert;
