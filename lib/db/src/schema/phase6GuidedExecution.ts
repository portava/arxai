// Phase 6 - guided execution persistence.
//
// Three tables: the versioned Personal Trading Constitution, the expiring
// Approval Ticket, and the durable Deriv order intent.
//
// SCHEMA APPLICATION. This repo has no migration system - no .sql files, no
// migrations directory, no migrate() call. Schema lands via
// `drizzle-kit push --force` run against the database by the owner. Two
// consequences that have bitten this repo before:
//   - this file MUST be re-exported from schema/index.ts or drizzle-kit cannot
//     see it and the push silently creates nothing;
//   - never run two push-force operations concurrently, and budget generously
//     (introspection has been observed at ~350s as the schema has grown).
//
// CONVENTIONS FOLLOWED. Plain pgTable, serial PKs, text columns paired with an
// exported `as const` array plus a derived union (this repo uses pgEnum in 0 of
// 162 schema files), and `integer("user_id")` for ownership - enforced in
// application code, since there is no RLS anywhere in this database.

import {
  pgTable, serial, text, integer, jsonb, boolean,
  timestamp, uniqueIndex, index, doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Personal Trading Constitution ─────────────────────────────────────────
//
// IMMUTABLE AND VERSIONED, following the shape `owner_decisions` already uses:
// a new version is a new row, and the old row is never updated. An approval
// ticket records the version that governed it, so a later policy change can
// never retroactively rewrite what a user was told they were approving.
//
// Append-only is NOT enforced by the database here - this repo has no triggers,
// no revoked grants and no RLS. It is enforced by the regex CI guard over source
// text (scripts/src/ci/check-vault-mutations.ts), which means this table gets
// zero protection until its Drizzle symbol is added to that guard's table list.
// That registration is a required follow-up, not an optional one.

export const tradingConstitutionsTable = pgTable("trading_constitutions", {
  id: serial("id").primaryKey(),
  constitutionId: text("constitution_id").notNull(),
  userId: integer("user_id").notNull(),
  /** Monotonic per user. (userId, version) is unique. */
  version: integer("version").notNull(),

  allowedBrokers: jsonb("allowed_brokers").notNull().default([]),
  allowedAccountRefs: jsonb("allowed_account_refs").notNull().default([]),
  allowedInstruments: jsonb("allowed_instruments").notNull().default([]),
  allowedMarketCategories: jsonb("allowed_market_categories").notNull().default([]),
  allowedSessionsUtc: jsonb("allowed_sessions_utc").notNull().default([]),

  maxRiskPerTradeUsd: doublePrecision("max_risk_per_trade_usd").notNull(),
  maxDailyLossUsd: doublePrecision("max_daily_loss_usd").notNull(),
  maxWeeklyLossUsd: doublePrecision("max_weekly_loss_usd"),
  maxSimultaneousPositions: integer("max_simultaneous_positions").notNull(),
  maxExposurePerSymbolUsd: doublePrecision("max_exposure_per_symbol_usd").notNull(),
  maxTradesPerDay: integer("max_trades_per_day").notNull(),

  requireStopLoss: boolean("require_stop_loss").notNull().default(true),
  requireTakeProfit: boolean("require_take_profit").notNull().default(false),

  minStakeUsd: doublePrecision("min_stake_usd").notNull(),
  maxStakeUsd: doublePrecision("max_stake_usd").notNull(),
  minMultiplier: doublePrecision("min_multiplier").notNull(),
  maxMultiplier: doublePrecision("max_multiplier").notNull(),

  lossStreakCooldown: jsonb("loss_streak_cooldown"),
  forbiddenInstruments: jsonb("forbidden_instruments").notNull().default([]),
  forbiddenConditions: jsonb("forbidden_conditions").notNull().default([]),

  /** EXPLAIN | RECOMMEND | PREPARE_TICKET. Never AUTHORIZE. */
  rubyAuthority: text("ruby_authority").notNull().default("EXPLAIN"),

  /** Points at the version this one replaced. Null for the first. */
  supersedesVersion: integer("supersedes_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
}, (t) => ({
  userVersionUq: uniqueIndex("trading_constitutions_user_version_uq").on(t.userId, t.version),
  constitutionIdIdx: index("trading_constitutions_cid_idx").on(t.constitutionId),
  userIdx: index("trading_constitutions_user_idx").on(t.userId),
}));

// ── Approval tickets ──────────────────────────────────────────────────────

export const APPROVAL_TICKET_DB_STATES = [
  "PENDING", "APPROVED", "REJECTED", "EXPIRED",
  "DISPATCHING", "EXECUTED", "UNRESOLVED", "CANCELLED",
] as const;
export type ApprovalTicketDbState = (typeof APPROVAL_TICKET_DB_STATES)[number];

export const approvalTicketsTable = pgTable("approval_tickets", {
  id: serial("id").primaryKey(),
  ticketId: text("ticket_id").notNull().unique(),
  /**
   * The account owner. Present and NOT NULL - unlike live_trade_approvals,
   * which carries no user column at all and therefore cannot enforce that one
   * user's approval never authorizes another user's account.
   */
  userId: integer("user_id").notNull(),
  state: text("state").notNull().default("PENDING"),

  // Material terms. Every field here is part of the fingerprint.
  broker: text("broker").notNull(),
  accountRef: text("account_ref").notNull(),
  instrument: text("instrument").notNull(),
  side: text("side").notNull(),
  stakeUsd: doublePrecision("stake_usd").notNull(),
  multiplier: doublePrecision("multiplier").notNull(),
  stopLossUsd: doublePrecision("stop_loss_usd"),
  takeProfitUsd: doublePrecision("take_profit_usd"),
  /** The venue-neutral intent this ticket authorizes. One ticket, one intent. */
  intentId: text("intent_id").notNull(),

  /**
   * TAMPER EVIDENCE. sha256 over the exact material terms, computed by
   * materialTermsFingerprint. Recorded at APPROVAL, re-derived at dispatch from
   * live state. A row edited in the database without recomputing this is
   * detectable; a row edited WITH a recomputed fingerprint still cannot match
   * an approval the user gave for different terms, because the approval
   * fingerprint and the approver are recorded together.
   */
  approvedFingerprint: text("approved_fingerprint"),
  approvedByUserId: integer("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),

  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectedByUserId: integer("rejected_by_user_id"),
  /** USER | SYSTEM_PRE_TRANSMISSION | SYSTEM_GATE */
  rejectionSource: text("rejection_source"),
  rejectionReason: text("rejection_reason"),

  /**
   * The atomic dispatch claim. A CAS on (ticket_id, state='APPROVED') sets this;
   * exactly one concurrent caller can win, which is what makes "one approval,
   * at most one order" true under double-clicks and retries.
   */
  dispatchClaimedAt: timestamp("dispatch_claimed_at", { withTimezone: true }),
  /** The arx_live_commands.command_id this ticket dispatched as. */
  liveCommandId: text("live_command_id"),
  venueContractRef: text("venue_contract_ref"),

  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

  // Provenance: what governed this ticket, recorded at proposal time.
  constitutionVersion: integer("constitution_version").notNull(),
  gateVerdicts: jsonb("gate_verdicts").notNull().default({}),
  gateVerdictsPassed: boolean("gate_verdicts_passed").notNull().default(false),
  /**
   * Gate 18 (DISCLOSURE_NOT_ACCEPTED) can pass via an operator waiver without
   * the user ever accepting the risk disclosure. Recorded separately so an
   * inbox can never present an operator waiver as the user's own consent.
   */
  disclosureWaivedByOperator: boolean("disclosure_waived_by_operator").notNull().default(false),

  // Lineage - the whole guided flow, reconstructable from one row.
  scannerSignalId: text("scanner_signal_id"),
  rubyExplanation: text("ruby_explanation"),
  riskEvaluation: jsonb("risk_evaluation").notNull().default({}),
  referenceQuote: doublePrecision("reference_quote"),
  expectedPayoutUsd: doublePrecision("expected_payout_usd"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userStateIdx: index("approval_tickets_user_state_idx").on(t.userId, t.state),
  expiresIdx: index("approval_tickets_expires_idx").on(t.expiresAt),
  intentUq: uniqueIndex("approval_tickets_intent_uq").on(t.intentId),
  /**
   * One LIVE ticket per (user, account, instrument) at a time. Terminal states
   * are excluded so a user can retry after a rejection or expiry, but an
   * in-flight or unresolved ticket blocks a second one - the same reasoning as
   * arx_live_commands_idem_active_uq, which covers LIVE_UNKNOWN precisely so an
   * unconfirmed outcome cannot be retried into a duplicate order.
   */
  activeUq: uniqueIndex("approval_tickets_active_uq")
    .on(t.userId, t.accountRef, t.instrument)
    .where(sql`state in ('PENDING','APPROVED','DISPATCHING','UNRESOLVED')`),
}));

// ── Deriv order intents ───────────────────────────────────────────────────
//
// The durable record written BEFORE any frame is sent. This is what makes
// recovery possible at all: req_id is monotonic only within one transport
// instance and restarts at 0, so after a process restart it cannot correlate a
// late reply to anything. This row can.

export const DERIV_WRITE_DISPOSITIONS = [
  "NOT_ATTEMPTED",
  "REFUSED_PRE_TRANSMISSION",
  "WRITTEN",
  "UNRECORDED",
] as const;
export type DerivWriteDisposition = (typeof DERIV_WRITE_DISPOSITIONS)[number];

export const derivOrderIntentsTable = pgTable("deriv_order_intents", {
  id: serial("id").primaryKey(),
  intentId: text("intent_id").notNull().unique(),
  userId: integer("user_id").notNull(),
  ticketId: text("ticket_id"),
  liveCommandId: text("live_command_id"),

  accountRef: text("account_ref").notNull(),
  instrument: text("instrument").notNull(),
  side: text("side").notNull(),
  stakeUsd: doublePrecision("stake_usd").notNull(),
  multiplier: doublePrecision("multiplier").notNull(),

  writeDisposition: text("write_disposition").notNull().default("NOT_ATTEMPTED"),
  /**
   * The transport's req_id for this intent. Correlates a late reply back here.
   * Meaningful ONLY together with transportInstanceId: the sequence restarts at
   * 0 for every new transport, so a bare req_id can match the wrong intent
   * after a reconnect.
   */
  reqId: integer("req_id"),
  transportInstanceId: text("transport_instance_id"),

  venueContractRef: text("venue_contract_ref"),
  /** Protection read back FROM the venue, never echoed from the request. */
  protectionReadback: jsonb("protection_readback"),

  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  /**
   * Set when a closed-INCLUSIVE venue read established absence. An open-only
   * read can never set this: an order that opened and settled is missing from
   * it, so its absence proves nothing.
   */
  absenceProvenClosedInclusiveAt: timestamp("absence_proven_closed_inclusive_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index("deriv_order_intents_user_idx").on(t.userId),
  ticketIdx: index("deriv_order_intents_ticket_idx").on(t.ticketId),
  /** Correlation key for a late reply. Unique within one transport instance. */
  reqUq: uniqueIndex("deriv_order_intents_req_uq").on(t.transportInstanceId, t.reqId),
  /** Intents that may still have an order standing at the venue. */
  unresolvedIdx: index("deriv_order_intents_unresolved_idx")
    .on(t.userId, t.writeDisposition)
    .where(sql`resolved_at is null and write_disposition in ('WRITTEN','UNRECORDED')`),
}));

// ── Guided attempt events ─────────────────────────────────────────────────
//
// APPEND-ONLY forensic ledger for one guided attempt. Registered with
// check-vault-mutations, so an UPDATE or DELETE here fails CI.
//
// WHY NOT REUSE execution_events: that ledger is keyed on a NUMERIC command_id
// belonging to the MT5 live-command path. The guided spine is a TEXT intent id,
// and forcing one into the other would mean either a lossy cast or a second
// meaning for an existing column. A separate table keeps both honest.
//
// The spine is intent_id: ticket, live command, Deriv intent and this ledger all
// carry it, so reconstructing an attempt is a lookup rather than a
// timestamp-correlation exercise — and timestamp correlation is how two
// concurrent attempts get merged into one story.

export const GUIDED_ATTEMPT_EVENT_TYPES = [
  "PROPOSAL_CREATED", "USER_APPROVED", "USER_REJECTED", "TICKET_EXPIRED",
  "DISPATCH_CLAIMED", "DRY_RUN_REFUSED", "GATE_REFUSED", "VENUE_REJECTED",
  "EXECUTED", "EXECUTION_UNKNOWN", "RECONCILED", "CONTRADICTION",
] as const;
export type GuidedAttemptEventType = (typeof GUIDED_ATTEMPT_EVENT_TYPES)[number];

export const guidedAttemptEventsTable = pgTable("guided_attempt_events", {
  id: serial("id").primaryKey(),
  /** THE SPINE. Every row of one attempt shares this. */
  intentId: text("intent_id").notNull(),
  ticketId: text("ticket_id").notNull(),
  userId: integer("user_id").notNull(),
  liveCommandId: text("live_command_id"),
  eventType: text("event_type").notNull(),
  /** Monotonic within an attempt. (intent_id, sequence_no) is unique. */
  sequenceNo: integer("sequence_no").notNull(),
  constitutionVersion: integer("constitution_version").notNull(),
  /**
   * Venue-proven ONLY. Null when nothing proved a contract exists — never an
   * empty string, never a placeholder. buildLineageRecord refuses to construct
   * a row that violates this.
   */
  venueContractRef: text("venue_contract_ref"),
  /**
   * VENUE-REPORTED realized P/L, present ONLY on RECONCILED events. Null means
   * the venue did not state a number — never "zero", never derived from stop
   * levels or spot deltas (the exact fabrication the spine bans). The
   * close-reconciliation worker writes it verbatim from the venue's settled
   * contract read; buildLineageRecord refuses it on any other event type.
   */
  venueProfitUsd: doublePrecision("venue_profit_usd"),
  scannerSignalId: text("scanner_signal_id"),
  rubyExplanation: text("ruby_explanation"),
  /** Human-readable. Passed through assertNoSecretLeak before it gets here. */
  detail: text("detail").notNull().default(""),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  intentSeqUq: uniqueIndex("guided_attempt_events_intent_seq_uq").on(t.intentId, t.sequenceNo),
  intentIdx: index("guided_attempt_events_intent_idx").on(t.intentId),
  userIdx: index("guided_attempt_events_user_idx").on(t.userId),
  ticketIdx: index("guided_attempt_events_ticket_idx").on(t.ticketId),
}));
