// Economic truth spine (#29/#30/#31) — bitemporal double-entry postings and
// the reconciliation discrepancy record.
//
// APPEND-ONLY CONTRACT (binding, same discipline as execution_events):
//   - No code path may UPDATE or DELETE rows in either table. Enforcement is
//     CI (check-vault-mutations.ts lists both symbols), because the app
//     connects as a superuser and a REVOKE would enforce nothing.
//   - A wrong posting is corrected by APPENDING a CORRECTION_REVERSAL journal
//     (negated legs, naming reverses_journal_id) followed by a
//     CORRECTION_REPOST journal — the decision ledger's forward-fix rule,
//     applied to money.
//
// BITEMPORAL (#29): effective_at is when the economic event happened at its
// source (broker/venue time); known_at is when ARX learned it. Late broker
// evidence therefore lands with an old effective_at and a new known_at — the
// out-of-order arrival is visible in the table, never smoothed over.
//
// BALANCE INVARIANT (#30): postings are written ONLY in whole journals whose
// legs sum to zero (journal_id groups a journal; unique(journal_id, leg_index)
// keeps legs stable). Therefore sum(amount_minor) per (ledger, currency,
// scale) is ALWAYS zero — the balance test asserts exactly that.
//
// AMOUNTS are integer minor units (bigint) + currency + scale, mirroring
// @workspace/money — never floating point. value_unknown=true marks an
// honesty row: the amount is NOT known and the stored zero must never be
// read as a claimed zero.
//
// SAFETY: these tables record money movements that already happened at
// existing seams. Nothing here is consulted by any gate or dispatch path;
// they cannot place, size, or authorise an order.

import {
  pgTable, bigserial, bigint, integer, text, boolean, timestamp, jsonb,
  index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const economicPostingsTable = pgTable("economic_postings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** Groups the legs of ONE balanced journal. */
  journalId: text("journal_id").notNull(),
  /** Stable order of the leg within its journal. */
  legIndex: integer("leg_index").notNull(),
  userId: integer("user_id").notNull(),
  /** Ledger partition: LIVE | DEMO. Demo money never mixes with live money. */
  ledger: text("ledger").notNull(),
  /** Account taxonomy code (lib/accounting ECONOMIC_ACCOUNTS). */
  account: text("account").notNull(),
  /** Per-strategy attribution sub-account (nullable). */
  strategyId: text("strategy_id"),
  /** Exact integer minor units; sign carries the side (no debit/credit column). */
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currency: text("currency").notNull(),
  scale: integer("scale").notNull(),
  /** TRUE = amount genuinely unknown; the zero stored here is NOT a claimed zero. */
  valueUnknown: boolean("value_unknown").notNull().default(false),
  /** Journal kind (TRADE_OPEN_FEE, TRADE_CLOSE_PNL, CORRECTION_REVERSAL, …). */
  kind: text("kind").notNull(),
  /** Truth-hierarchy source of the figures (BROKER_STATEMENT|BROKER_EVENT|LOCAL_EXECUTION|DERIVED). */
  source: text("source").notNull(),
  /** When the economic event happened at its source. */
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  /** When ARX learned it (DB default now()). */
  knownAt: timestamp("known_at", { withTimezone: true }).notNull().defaultNow(),
  /** Originating live/guided command id, when any. */
  commandId: text("command_id"),
  brokerTicket: text("broker_ticket"),
  /** CORRECTION_REVERSAL rows name the journal they reverse. */
  reversesJournalId: text("reverses_journal_id"),
  metadata: jsonb("metadata").notNull().default({}),
}, (t) => ({
  journalLegUq: uniqueIndex("economic_postings_journal_leg_uq").on(t.journalId, t.legIndex),
  userLedgerIdx: index("economic_postings_user_ledger_idx").on(t.userId, t.ledger),
  accountIdx: index("economic_postings_account_idx").on(t.account),
  commandIdx: index("economic_postings_command_idx").on(t.commandId),
}));

export type EconomicPosting = typeof economicPostingsTable.$inferSelect;
export type NewEconomicPosting = typeof economicPostingsTable.$inferInsert;

// One reconciliation observation: posting-ledger balance vs the broker's
// reported account balance. APPEND-ONLY; DISCREPANCY rows are the loud,
// honest surfacing — there is deliberately NO "resolved/adjusted" column,
// because resolution is a human-authored correction journal, not a flag flip.
export const economicDiscrepanciesTable = pgTable("economic_discrepancies", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: integer("user_id").notNull(),
  ledger: text("ledger").notNull(),
  /** MATCHED | DISCREPANCY | BASELINE_ESTABLISHED | UNKNOWN */
  verdict: text("verdict").notNull(),
  /** Broker-reported balance in minor units; null when unavailable/stale. */
  brokerBalanceMinor: bigint("broker_balance_minor", { mode: "bigint" }),
  /** Sum of BROKER_CASH postings at observation time. */
  ledgerCashMinor: bigint("ledger_cash_minor", { mode: "bigint" }).notNull(),
  /** Baseline in force for this comparison (established or carried forward). */
  baselineMinor: bigint("baseline_minor", { mode: "bigint" }),
  /** broker − (baseline + ledger); null when not comparable. */
  differenceMinor: bigint("difference_minor", { mode: "bigint" }),
  currency: text("currency").notNull(),
  scale: integer("scale").notNull(),
  /** Truth source of the broker figure (BROKER_STATEMENT | BROKER_EVENT). */
  brokerSource: text("broker_source"),
  /** For a DISCREPANCY: the prevailing source per the truth hierarchy. */
  truthWinner: text("truth_winner"),
  reason: text("reason").notNull(),
  /** DAILY | ON_DEMAND */
  trigger: text("trigger").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb("metadata").notNull().default({}),
}, (t) => ({
  userLedgerIdx: index("economic_discrepancies_user_ledger_idx").on(t.userId, t.ledger),
  verdictIdx: index("economic_discrepancies_verdict_idx").on(t.verdict),
}));

export type EconomicDiscrepancy = typeof economicDiscrepanciesTable.$inferSelect;
export type NewEconomicDiscrepancy = typeof economicDiscrepanciesTable.$inferInsert;
