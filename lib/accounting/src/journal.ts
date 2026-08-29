// Double-entry journal engine (#30) + bitemporal discipline (#29).
//
// PURE. Imports only @workspace/money and the local taxonomy. No IO, no clock
// (every time is an input), nothing from the dispatch/gate path. This module
// cannot place an order or write a row — it only SHAPES balanced journals that
// a server-side writer persists.
//
// THE THREE RULES (each has a red test):
//   1. BALANCED OR REFUSED. Every journal's legs sum to exactly zero in one
//      currency. An imbalanced journal THROWS JournalImbalanceError — it is
//      never "fixed up" with a plug amount, because a plug is a fabricated
//      value wearing an accountant's coat.
//   2. BITEMPORAL, APPEND-ONLY. Every journal carries effectiveAt (when the
//      economic event happened at its source) and knownAt (when ARX learned
//      it). A correction is a NEW pair of journals — reverse then repost —
//      never a mutation. The decision ledger's discipline, applied to money.
//   3. UNKNOWN IS EXPLICIT. A value ARX does not know (the broker reported a
//      fill but no commission figure) posts as a ZERO-amount leg pair with
//      valueUnknown=true against UNKNOWN_SUSPENSE. The flag is the honesty:
//      a flagged zero says "amount unknown", an unflagged zero would claim
//      "amount known to be zero" — which nothing proved.

import { Money } from "@workspace/money";
import type { TruthSource } from "@workspace/domain/safety-contracts/truthHierarchy";
import {
  type EconomicAccount, type LedgerPartition,
  isEconomicAccount, isLedgerPartition,
} from "./accounts.js";

/**
 * Where a journal's numbers came from. THE type is the truth-hierarchy safety
 * contract's — re-aliased, not redeclared, so accounting can never grow a
 * source the precedence contract does not rank.
 */
export type JournalTruthSource = TruthSource;

export const JOURNAL_KINDS = [
  "TRADE_OPEN_STAKE",     // demo Deriv stake: cash → open positions
  "TRADE_OPEN_FEE",       // fee/commission at open (usually UNKNOWN at the MT5 seam)
  "TRADE_CLOSE_PNL",      // realized P&L at close
  "TRADE_CLOSE_FEE",      // fee/commission at close
  "TRADE_CLOSE_FUNDING",  // swap / funding at close
  "CORRECTION_REVERSAL",  // negates a prior journal, names it in reversesJournalId
  "CORRECTION_REPOST",    // the corrected figures, posted after the reversal
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface PostingLeg {
  account: EconomicAccount;
  amount: Money;
  /**
   * TRUE only for an honesty leg: the real amount is not known, the stored
   * amount MUST be zero, and downstream consumers MUST NOT read it as a
   * claimed zero. Enforced by buildJournal.
   */
  valueUnknown: boolean;
}

export interface EconomicJournal {
  /** Caller-supplied, globally unique per journal (e.g. `ej_<commandId>_close`). */
  journalId: string;
  ledger: LedgerPartition;
  kind: JournalKind;
  source: JournalTruthSource;
  /** When the economic event happened at its source (broker/venue time). */
  effectiveAt: Date;
  /** When ARX learned it (the bitemporal "knowledge" axis). */
  knownAt: Date;
  legs: readonly PostingLeg[];
  userId: number;
  strategyId: string | null;
  commandId: string | null;
  brokerTicket: string | null;
  /** CORRECTION_REVERSAL only: the journal being reversed. */
  reversesJournalId: string | null;
  metadata: Record<string, unknown>;
}

export class JournalImbalanceError extends Error {
  constructor(journalId: string, detail: string) {
    super(`ECONOMIC_JOURNAL_REFUSED ${journalId}: ${detail}`);
    this.name = "JournalImbalanceError";
  }
}

export interface BuildJournalInput {
  journalId: string;
  ledger: LedgerPartition;
  kind: JournalKind;
  source: JournalTruthSource;
  effectiveAt: Date;
  knownAt: Date;
  legs: readonly PostingLeg[];
  userId: number;
  strategyId?: string | null;
  commandId?: string | null;
  brokerTicket?: string | null;
  reversesJournalId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Validate and freeze one balanced journal. THROWS (never repairs) on:
 * fewer than 2 legs, mixed currencies/scales, a non-zero sum, an unknown-
 * flagged leg with a non-zero amount, an invalid account/ledger, or a
 * non-positive userId.
 */
export function buildJournal(input: BuildJournalInput): EconomicJournal {
  const { journalId, legs } = input;
  if (typeof journalId !== "string" || journalId.trim() === "") {
    throw new JournalImbalanceError(String(journalId), "journalId is required");
  }
  if (!isLedgerPartition(input.ledger)) {
    throw new JournalImbalanceError(journalId, `invalid ledger partition ${String(input.ledger)}`);
  }
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new JournalImbalanceError(journalId, `invalid userId ${String(input.userId)}`);
  }
  if (legs.length < 2) {
    throw new JournalImbalanceError(journalId, `a journal needs at least 2 legs, got ${legs.length}`);
  }
  for (const leg of legs) {
    if (!isEconomicAccount(leg.account)) {
      throw new JournalImbalanceError(journalId, `unknown account ${String(leg.account)}`);
    }
    if (leg.valueUnknown && !leg.amount.isZero()) {
      throw new JournalImbalanceError(
        journalId,
        `leg ${leg.account} is flagged valueUnknown but carries ${leg.amount.toString()} — an unknown amount must be stored as flagged zero, never a claimed value`,
      );
    }
  }
  // sum() throws on currency/scale mismatch, which is exactly the refusal we want.
  let sum: Money;
  try {
    sum = legs.map((l) => l.amount).reduce((a, b) => a.add(b));
  } catch (e) {
    throw new JournalImbalanceError(journalId, e instanceof Error ? e.message : String(e));
  }
  if (!sum.isZero()) {
    throw new JournalImbalanceError(
      journalId,
      `legs sum to ${sum.toString()}, not zero — refused, never plugged`,
    );
  }
  if (input.kind === "CORRECTION_REVERSAL" && !input.reversesJournalId) {
    throw new JournalImbalanceError(journalId, "a CORRECTION_REVERSAL must name reversesJournalId");
  }
  return Object.freeze({
    journalId,
    ledger: input.ledger,
    kind: input.kind,
    source: input.source,
    effectiveAt: input.effectiveAt,
    knownAt: input.knownAt,
    legs: Object.freeze(legs.map((l) => ({ ...l }))),
    userId: input.userId,
    strategyId: input.strategyId ?? null,
    commandId: input.commandId ?? null,
    brokerTicket: input.brokerTicket ?? null,
    reversesJournalId: input.reversesJournalId ?? null,
    metadata: input.metadata ?? {},
  });
}

/** An honesty leg: amount UNKNOWN, stored as flagged zero. */
export function unknownLeg(account: EconomicAccount, currency: string): PostingLeg {
  return { account, amount: Money.zero(currency), valueUnknown: true };
}

/** Known leg helper. */
export function leg(account: EconomicAccount, amount: Money): PostingLeg {
  return { account, amount, valueUnknown: false };
}

/** The journal's net effect on BROKER_CASH (what the broker's balance should move by). */
export function journalCashNet(journal: EconomicJournal): Money {
  const cash = journal.legs.filter((l) => l.account === "BROKER_CASH").map((l) => l.amount);
  if (cash.length === 0) {
    const first = journal.legs[0]!.amount;
    return Money.zero(first.currency, first.scale);
  }
  return cash.reduce((a, b) => a.add(b));
}

// ── Seam builders ────────────────────────────────────────────────────────────

export interface TradeOpenInput {
  journalIdBase: string;
  ledger: LedgerPartition;
  source: JournalTruthSource;
  effectiveAt: Date;
  knownAt: Date;
  userId: number;
  strategyId?: string | null;
  commandId?: string | null;
  brokerTicket?: string | null;
  currency: string;
  /**
   * Stake actually debited from cash at open (Deriv-style contracts).
   * undefined = no cash moved at open (MT5 margin trade).
   */
  stake?: Money;
  /**
   * Fee/commission at open as a COST. null = a fee event exists but its
   * amount is NOT KNOWN (the MT5 EA result carries no commission figure) —
   * posts an explicit UNKNOWN pair. undefined = no fee journal at all.
   */
  fee?: Money | null;
  metadata?: Record<string, unknown>;
}

/**
 * The fill-confirmation seam's journals. Anything unknown posts FLAGGED, and
 * anything unreported posts NOTHING — no value is ever fabricated to make an
 * open "look complete".
 */
export function buildTradeOpenJournals(input: TradeOpenInput): EconomicJournal[] {
  const base = {
    ledger: input.ledger,
    source: input.source,
    effectiveAt: input.effectiveAt,
    knownAt: input.knownAt,
    userId: input.userId,
    strategyId: input.strategyId ?? null,
    commandId: input.commandId ?? null,
    brokerTicket: input.brokerTicket ?? null,
    metadata: input.metadata ?? {},
  };
  const journals: EconomicJournal[] = [];
  if (input.stake !== undefined) {
    journals.push(buildJournal({
      ...base,
      journalId: `${input.journalIdBase}_stake`,
      kind: "TRADE_OPEN_STAKE",
      legs: [leg("OPEN_POSITIONS", input.stake), leg("BROKER_CASH", input.stake.negate())],
    }));
  }
  if (input.fee !== undefined) {
    journals.push(buildJournal({
      ...base,
      journalId: `${input.journalIdBase}_fee`,
      kind: "TRADE_OPEN_FEE",
      legs: input.fee == null
        ? [unknownLeg("FEES_EXPENSE", input.currency), unknownLeg("UNKNOWN_SUSPENSE", input.currency)]
        : [leg("FEES_EXPENSE", input.fee), leg("BROKER_CASH", input.fee.negate())],
    }));
  }
  return journals;
}

export interface TradeCloseInput {
  journalIdBase: string;
  ledger: LedgerPartition;
  source: JournalTruthSource;
  effectiveAt: Date;
  knownAt: Date;
  userId: number;
  strategyId?: string | null;
  commandId?: string | null;
  brokerTicket?: string | null;
  currency: string;
  /** Realized P&L as reported (profit positive). null = NOT KNOWN. */
  realizedPnl: Money | null;
  /** Fee/commission as a COST (positive = charged). null = NOT KNOWN. undefined = no fee event reported at all. */
  fee?: Money | null;
  /** Funding/swap as a COST (positive = charged; negative = credited). null = NOT KNOWN. undefined = none reported. */
  funding?: Money | null;
  metadata?: Record<string, unknown>;
}

/**
 * The close-reconciliation seam's journals: realized P&L, and (when reported)
 * fee and funding — each its own journal so a later correction can reverse
 * exactly the component that was wrong.
 *
 * HONESTY: a null component posts an UNKNOWN pair (flagged zero against
 * UNKNOWN_SUSPENSE), never a silent zero. An undefined fee/funding posts
 * NOTHING — absence of a reported event is not an event.
 */
export function buildTradeCloseJournals(input: TradeCloseInput): EconomicJournal[] {
  const base = {
    ledger: input.ledger,
    source: input.source,
    effectiveAt: input.effectiveAt,
    knownAt: input.knownAt,
    userId: input.userId,
    strategyId: input.strategyId ?? null,
    commandId: input.commandId ?? null,
    brokerTicket: input.brokerTicket ?? null,
    metadata: input.metadata ?? {},
  };
  const journals: EconomicJournal[] = [];

  // Realized P&L: profit → cash up, REALIZED_PNL down (income sign convention).
  journals.push(buildJournal({
    ...base,
    journalId: `${input.journalIdBase}_pnl`,
    kind: "TRADE_CLOSE_PNL",
    legs: input.realizedPnl == null
      ? [unknownLeg("BROKER_CASH", input.currency), unknownLeg("UNKNOWN_SUSPENSE", input.currency)]
      : [leg("BROKER_CASH", input.realizedPnl), leg("REALIZED_PNL", input.realizedPnl.negate())],
  }));

  if (input.fee !== undefined) {
    journals.push(buildJournal({
      ...base,
      journalId: `${input.journalIdBase}_fee`,
      kind: "TRADE_CLOSE_FEE",
      legs: input.fee == null
        ? [unknownLeg("FEES_EXPENSE", input.currency), unknownLeg("UNKNOWN_SUSPENSE", input.currency)]
        : [leg("FEES_EXPENSE", input.fee), leg("BROKER_CASH", input.fee.negate())],
    }));
  }

  if (input.funding !== undefined) {
    journals.push(buildJournal({
      ...base,
      journalId: `${input.journalIdBase}_funding`,
      kind: "TRADE_CLOSE_FUNDING",
      legs: input.funding == null
        ? [unknownLeg("FUNDING_EXPENSE", input.currency), unknownLeg("UNKNOWN_SUSPENSE", input.currency)]
        : [leg("FUNDING_EXPENSE", input.funding), leg("BROKER_CASH", input.funding.negate())],
    }));
  }

  return journals;
}

/**
 * Correction (#29): reverse-and-repost, NEVER update. Returns [reversal,
 * repost]. The reversal negates every leg of the original (unknown flags
 * preserved — reversing an unknown is still unknown) and names it; the repost
 * carries the corrected legs. effectiveAt of BOTH stays the ORIGINAL economic
 * time; knownAt is when the correction was learned — that split is the whole
 * point of the bitemporal axes.
 */
export function buildCorrectionJournals(args: {
  original: EconomicJournal;
  correctedLegs: readonly PostingLeg[];
  correctedSource: JournalTruthSource;
  knownAt: Date;
  correctionIdBase: string;
  metadata?: Record<string, unknown>;
}): [EconomicJournal, EconomicJournal] {
  const { original } = args;
  const reversal = buildJournal({
    journalId: `${args.correctionIdBase}_reversal`,
    ledger: original.ledger,
    kind: "CORRECTION_REVERSAL",
    source: args.correctedSource,
    effectiveAt: original.effectiveAt,
    knownAt: args.knownAt,
    legs: original.legs.map((l) => ({
      account: l.account,
      amount: l.amount.negate(),
      valueUnknown: l.valueUnknown,
    })),
    userId: original.userId,
    strategyId: original.strategyId,
    commandId: original.commandId,
    brokerTicket: original.brokerTicket,
    reversesJournalId: original.journalId,
    metadata: { ...(args.metadata ?? {}), reverses: original.journalId },
  });
  const repost = buildJournal({
    journalId: `${args.correctionIdBase}_repost`,
    ledger: original.ledger,
    kind: "CORRECTION_REPOST",
    source: args.correctedSource,
    effectiveAt: original.effectiveAt,
    knownAt: args.knownAt,
    legs: args.correctedLegs,
    userId: original.userId,
    strategyId: original.strategyId,
    commandId: original.commandId,
    brokerTicket: original.brokerTicket,
    metadata: { ...(args.metadata ?? {}), corrects: original.journalId },
  });
  return [reversal, repost];
}

// ── Balance invariant over persisted rows ────────────────────────────────────

/** The row shape the invariant checker needs (matches economic_postings columns). */
export interface PostingRowLike {
  amountMinor: bigint;
  currency: string;
  scale: number;
  ledger: string;
}

export interface BalanceCheckResult {
  balanced: boolean;
  /** Per ledger+currency totals in minor units; every value must be 0n. */
  totals: Record<string, bigint>;
}

/**
 * THE invariant: sum(all postings) === 0, per ledger partition per currency.
 * Pure fold over rows — usable against DB rows and in-memory fixtures alike.
 */
export function checkBalanceInvariant(rows: readonly PostingRowLike[]): BalanceCheckResult {
  const totals: Record<string, bigint> = {};
  for (const r of rows) {
    const key = `${r.ledger}:${r.currency}:${r.scale}`;
    totals[key] = (totals[key] ?? 0n) + r.amountMinor;
  }
  const balanced = Object.values(totals).every((v) => v === 0n);
  return { balanced, totals };
}
