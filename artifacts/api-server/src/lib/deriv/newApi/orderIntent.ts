// Durable order intent for the Deriv path (Phase 5: idempotent orders,
// restart recovery).
//
// THE PROBLEM. The orphan ledger resolves a late reply WITHIN a process. A
// crash between "order sent" and "outcome known" loses it entirely, along with
// the one-order latch (module state) and the transport's req_id sequence. What
// survives a restart is only what was written down BEFORE the crash.
//
// THE SUBTLETY THAT DRIVES THE WHOLE DESIGN. It is tempting to treat "no
// record that the frame was written" as proof the order never left. It is not.
// Recording the write is ITSELF subject to a crash window: the process can die
// after the socket write and before the record lands. Absence of a write
// record is UNKNOWN, never ABSENT.
//
// Only two things prove no order exists:
//   * a disposition durably recorded BEFORE any attempt, or
//   * the transport reporting wireWritten === false, which is a fact about a
//     write that provably did not happen.
//
// Everything else defers to venue evidence.
//
// NO DATABASE IS REQUIRED BY THIS MODULE. It defines the record and the pure
// recovery mapping; persistence is an adapter supplied by the caller.

import {
  classifyUnknownCommand,
  type UnknownCommandFacts, type UnknownCommandEvidence,
  type UnknownCommandVerdict, type PositionEvidenceRow, type LateResultEvidenceRow,
} from "../../live/unknownClassifier.js";
import { shortcodeMatchesSymbol, type ArxPortfolioEntry, type ArxStatementBuy } from "./wire.js";

/**
 * What ARX knows about whether the order's bytes left the process.
 *
 * The distinction between REFUSED_PRE_TRANSMISSION and UNRECORDED is the
 * entire point: the first is venue-adjacent proof that nothing was sent, the
 * second is our own ignorance and must never be read as the first.
 */
export type WriteDisposition =
  /** Durably recorded before any attempt. No frame was constructed. */
  | "NOT_ATTEMPTED"
  /** The transport reported wireWritten === false: provably not transmitted. */
  | "REFUSED_PRE_TRANSMISSION"
  /** The transport confirmed the write. The venue may have acted on it. */
  | "WRITTEN"
  /** We recorded an intent and never recorded what became of it. A crash
   *  landed inside the window. This is IGNORANCE, not evidence. */
  | "UNRECORDED";

/**
 * The durable record, written BEFORE the order is sent.
 *
 * Every field earns its place by being required to resolve some specific crash
 * window. Nothing is here for convenience.
 */
export interface DerivOrderIntent {
  /** Client-generated, stable across restarts. The only handle that exists
   *  before the venue supplies a contract id. */
  intentId: string;
  /** Which account the order was for — recovery must not cross accounts. */
  accountId: string;
  /** Identifies the position at the venue once one exists. */
  symbol: string;
  contractType: "MULTUP" | "MULTDOWN";
  stake: number;
  /** Needed to recognise OUR position among several on the same symbol. */
  multiplier: number;
  /** Recorded before the send; the reference point for "did the venue see
   *  this before its snapshot was taken". */
  createdAtMs: number;
  /** Set when the transport confirms the write. Null while unknown — and null
   *  is NOT evidence the write did not happen. */
  frameWrittenAtMs: number | null;
  writeDisposition: WriteDisposition;
  /** Set once the venue adjudicated. Its presence means recovery is done. */
  outcome:
    | { kind: "CONTRACT"; contractId: number }
    | { kind: "VENUE_REFUSED"; derivCode: string | null }
    | null;
}

/**
 * IDEMPOTENCY, AND WHAT IT CANNOT MEAN HERE.
 *
 * Deriv's buy_request has no dedup key — its properties are exactly buy,
 * price, parameters, subscribe, passthrough, req_id. `passthrough` is echoed
 * back, which buys CORRELATION, not deduplication: the venue will happily
 * execute two identical buys that carry the same passthrough.
 *
 * So idempotency here is CLIENT-SIDE DISCIPLINE, and the residual risk is
 * real: two ARX processes that do not share durable intent state can still
 * double-order, and nothing in the venue will stop them. Recording that limit
 * is the honest form of this feature. Describing this guard as "idempotent
 * orders" without it would be a mitigation dressed up as an elimination.
 */
export type DuplicateVerdict =
  /** No prior intent for this key, or every prior one provably never reached
   *  the venue. Sending is safe. */
  | { allowed: true; reason: "NO_PRIOR_INTENT" | "PRIOR_PROVABLY_NOT_SENT" | "PRIOR_VENUE_REFUSED" }
  /** A prior order for this key may or does exist. Sending again could double
   *  the position, and no venue mechanism would prevent it. */
  | { allowed: false; reason: "PRIOR_UNRESOLVED" | "PRIOR_FILLED"; priorIntentId: string };

/**
 * Refuse a second order for the same logical intent.
 *
 * The key is supplied by the caller and must be derived from the DECISION that
 * produced the order, not from the order's parameters — two genuinely separate
 * decisions can legitimately produce identical parameters, and collapsing them
 * would suppress a real second order.
 *
 * A prior VENUE_REFUSED is retryable because a venue refusal is adjudicated
 * proof no contract was created. A prior UNRECORDED is NOT, for the same
 * reason it is not recoverable: our ignorance is not the venue's answer.
 */
export function checkDuplicateOrder(
  idempotencyKey: string,
  priorIntents: Array<DerivOrderIntent & { idempotencyKey?: string }>,
): DuplicateVerdict {
  const priors = priorIntents.filter((i) => i.idempotencyKey === idempotencyKey);
  if (priors.length === 0) return { allowed: true, reason: "NO_PRIOR_INTENT" };

  // A filled prior is the strongest block: the position exists.
  const filled = priors.find((i) => i.outcome?.kind === "CONTRACT");
  if (filled) return { allowed: false, reason: "PRIOR_FILLED", priorIntentId: filled.intentId };

  // Anything whose fate is unknown blocks: it MAY have reached the venue.
  const unresolved = priors.find((i) => i.outcome === null
    && (i.writeDisposition === "WRITTEN" || i.writeDisposition === "UNRECORDED"));
  if (unresolved) {
    return { allowed: false, reason: "PRIOR_UNRESOLVED", priorIntentId: unresolved.intentId };
  }

  // Every prior was either adjudicated as refused, or provably never sent.
  const refused = priors.some((i) => i.outcome?.kind === "VENUE_REFUSED");
  return {
    allowed: true,
    reason: refused ? "PRIOR_VENUE_REFUSED" : "PRIOR_PROVABLY_NOT_SENT",
  };
}

/** Venue evidence gathered AFTER a restart, before classifying. */
export interface DerivVenueEvidence {
  /** Contracts visible to the recovery read. */
  openContracts: ArxPortfolioEntry[];
  /** When that read landed. Null when none succeeded. */
  portfolioReadAtMs: number | null;
  /**
   * Does the evidence set include contracts that may ALREADY HAVE CLOSED?
   *
   * THIS GATES ABSENCE, and it exists because of a false-"no trade" this
   * module shipped with. Deriv's `portfolio` returns only OUTSTANDING
   * contracts — its schema is titled "Receive information about my current
   * portfolio of outstanding options". An order that filled and was then
   * closed (a multiplier stop-out needs no action from ARX, and in a crash
   * scenario ARX is dead by construction) is simply ABSENT from a portfolio
   * read. Feeding that to the classifier as a complete sweep asserted a
   * completeness Deriv never supplied, and produced RESOLVE_ABSENT for an
   * order that had executed.
   *
   * The classifier's `lastCompleteSnapshotAt` means a sweep over a store that
   * RETAINS closed rows. A portfolio read is not that, so it must not be
   * presented as one.
   *
   * Only a closed-inclusive source — a `statement` read covering the order's
   * window — can satisfy this. Until one is supplied, absence stays unprovable
   * and recovery HOLDS. That is the correct failure direction: a held order
   * costs an operator a look, a false "no trade" costs a stranded position.
   */
  closedInclusive: boolean;
  /**
   * Buy transactions from a `statement` read — the CLOSED-INCLUSIVE source.
   *
   * A statement buy row exists from the moment a buy executes and SURVIVES the
   * contract closing, which is precisely the evidence a portfolio read cannot
   * give. Without these rows, `closedInclusive` was a flag asserting a
   * completeness nothing actually supplied: a caller whose statement FOUND the
   * buy would still have been told the order never executed.
   */
  statementBuys: ArxStatementBuy[];
  /** Late replies recovered from any durable orphan store, for THIS intent. */
  lateReplies: Array<{ contractId: number | null; derivCode: string | null }>;
  /** False when ANY evidence source was unreadable. Blocks absence
   *  resolution; does not block resolving a fill from what WAS readable. */
  evidenceComplete: boolean;
}

/**
 * Map a Deriv intent onto the existing, CI-covered unknown-command classifier.
 *
 * COMPOSITION, NOT DUPLICATION — the blueprint's standing rule. The classifier
 * is already pure, already models RESOLVE_FILLED / RESOLVE_ABSENT / HOLD with
 * typed reasons, and already refuses to prove a negative from incomplete
 * evidence. Writing a second one would let the two drift apart on exactly the
 * judgements that matter most.
 *
 * The vocabulary is MT5-flavoured; the semantics are not. Each mapping is
 * spelled out here so the translation is auditable rather than implied:
 *
 *   brokerTicket    <- Deriv contract_id, the venue's position handle
 *   sentToMt5At     <- when the frame was WRITTEN (not when it was intended)
 *   pickedByEaAt    <- null: no Deriv analogue. The classifier takes the max
 *                      of the two timestamps and needs only one, so a null
 *                      here narrows nothing.
 *   requestedVolume <- stake. A multiplier position is stake x multiplier,
 *                      not lots; stake is the sizing quantity that exists.
 */
export function toUnknownCommandFacts(intent: DerivOrderIntent): UnknownCommandFacts {
  return {
    commandId: intent.intentId,
    // The classifier reserves its positive-absence branch for market orders;
    // any other type is held for an operator. A Deriv multiplier buy IS a
    // market order, and mislabelling it made every outcome an unconditional
    // HOLD — safe, but incapable of ever resolving anything.
    commandType: "PLACE_LIVE_MARKET_ORDER",
    status: "LIVE_UNKNOWN",
    symbol: intent.symbol,
    side: intent.contractType === "MULTUP" ? "BUY" : "SELL",
    requestedVolume: intent.stake,
    brokerTicket: intent.outcome?.kind === "CONTRACT"
      ? String(intent.outcome.contractId) : null,
    // Only a CONFIRMED write is a reference point. An unrecorded write cannot
    // date the order, and dating it from createdAtMs would let a snapshot
    // taken before the frame ever left be treated as covering it.
    sentToMt5At: intent.frameWrittenAtMs !== null ? new Date(intent.frameWrittenAtMs) : null,
    pickedByEaAt: null,
    expiresAt: null,
  };
}

export function toUnknownCommandEvidence(
  intent: DerivOrderIntent,
  venue: DerivVenueEvidence,
): UnknownCommandEvidence {
  const positions: PositionEvidenceRow[] = venue.openContracts
    // Only contracts on OUR symbol can be ours. A different symbol is not
    // ambiguity, it is a non-match.
    .filter((c) => c.underlyingSymbol === null || c.underlyingSymbol === intent.symbol)
    .map((c) => ({
      brokerTicket: String(c.contractId),
      // Deriv has no client-reference field on a contract, so a contract can
      // never be LINKED to an intent — only ticket-matched. That is why the
      // intent's own recorded contractId matters so much.
      sourceCommandId: null,
      symbol: c.underlyingSymbol ?? intent.symbol,
      side: c.contractType === "MULTDOWN" ? "SELL" : "BUY",
      volume: c.buyPrice ?? intent.stake,
      // Dated from the venue's own purchase_time. Null here would stop the
      // classifier's ambiguity check from firing, and a real position that
      // cannot be dated is a real position that cannot block an absence
      // conclusion.
      openedAt: c.purchaseTimeSec !== null ? new Date(c.purchaseTimeSec * 1000) : null,
      closedAt: null,
    }));
  // Statement buys join the SAME evidence set. A closed contract appears here
  // and nowhere else, so omitting them is what made a closed-but-executed
  // order look like one that never happened.
  for (const b of venue.statementBuys) {
    const match = shortcodeMatchesSymbol(b.shortcode, intent.symbol);
    // null means the row could not be identified — no shortcode, or one that
    // does not parse. UNKNOWN is kept as a CANDIDATE so it blocks absence.
    // Dropping it would let an unidentifiable row be reasoned past into a
    // no-trade conclusion, which is the failure this whole gate exists for.
    if (match === false) continue;
    positions.push({
      brokerTicket: String(b.contractId),
      sourceCommandId: null,
      symbol: intent.symbol,
      side: intent.contractType === "MULTUP" ? "BUY" : "SELL",
      volume: b.amount !== null ? Math.abs(b.amount) : intent.stake,
      // transaction_time, NOT purchase_time — the latter is documented
      // "present only for sell transaction" and is absent on every buy row.
      openedAt: b.transactionTimeSec !== null ? new Date(b.transactionTimeSec * 1000) : null,
      closedAt: null,
    });
  }

  const lateResults: LateResultEvidenceRow[] = venue.lateReplies.map((r) => ({
    reportedOutcome: r.contractId !== null ? "LIVE_FILLED" : null,
    brokerTicket: r.contractId !== null ? String(r.contractId) : null,
    fillPrice: null,
    executedVolume: null,
  }));
  return {
    positions,
    lateResults,
    // Withheld unless the evidence set can actually see a closed contract.
    // Passing a portfolio timestamp here is what produced the false absence.
    lastCompleteSnapshotAt: (venue.closedInclusive && venue.portfolioReadAtMs !== null)
      ? new Date(venue.portfolioReadAtMs) : null,
    evidenceComplete: venue.evidenceComplete,
  };
}

/** What recovery decided, and why. */
export type DerivRecoveryOutcome =
  | { intentId: string; action: "ALREADY_RESOLVED"; detail: string }
  /** Provably no order. The ONLY two routes to this without venue evidence. */
  | { intentId: string; action: "NO_ORDER_PLACED"; evidence: "NEVER_ATTEMPTED" | "REFUSED_PRE_TRANSMISSION" }
  | { intentId: string; action: "RESOLVED"; verdict: UnknownCommandVerdict }
  /** Needs a human. Recovery that cannot conclude says so. */
  | { intentId: string; action: "ESCALATE"; reason: string };

/**
 * Recover a set of intents against venue evidence. PURE.
 *
 * No database, no network, no clock unless injected — so every crash window
 * below is testable offline, which is the point: the code that runs after a
 * crash is the code least likely to be exercised in practice.
 */
export function recoverDerivIntents(
  intents: DerivOrderIntent[],
  venue: DerivVenueEvidence,
  opts?: { now?: Date; snapshotFreshnessMs?: number },
): DerivRecoveryOutcome[] {
  return intents.map((intent) => {
    if (intent.outcome !== null) {
      return {
        intentId: intent.intentId, action: "ALREADY_RESOLVED",
        detail: intent.outcome.kind === "CONTRACT"
          ? `contract ${intent.outcome.contractId}`
          : `venue refused (${intent.outcome.derivCode ?? "no code"})`,
      };
    }
    // The only two dispositions that prove nothing was sent.
    if (intent.writeDisposition === "NOT_ATTEMPTED") {
      return { intentId: intent.intentId, action: "NO_ORDER_PLACED", evidence: "NEVER_ATTEMPTED" };
    }
    if (intent.writeDisposition === "REFUSED_PRE_TRANSMISSION") {
      return { intentId: intent.intentId, action: "NO_ORDER_PLACED", evidence: "REFUSED_PRE_TRANSMISSION" };
    }
    // DERIV EVIDENCE IS WEAKER THAN MT5'S, and the adapter must not let a
    // classifier tuned for the stronger case reach a stronger conclusion than
    // Deriv can support.
    //
    // MT5 positions carry sourceCommandId — the EA writes the originating
    // command back, so a position can be POSITIVELY attributed. Deriv's
    // contracts carry no client reference at all. Any open contract on our
    // symbol and side is therefore a candidate that ARX cannot confirm or
    // rule out, and it must block absence rather than be reasoned past.
    //
    // The classifier already blocks on this via its circumstantial check, but
    // only for contracts it can DATE. An undated candidate would slip through
    // to a positive-absence verdict, so undated candidates are caught here.
    const undatedCandidate = venue.openContracts.some(
      (c) => (c.underlyingSymbol === null || c.underlyingSymbol === intent.symbol)
        && c.purchaseTimeSec === null,
    ) || venue.statementBuys.some(
      (b) => shortcodeMatchesSymbol(b.shortcode, intent.symbol) !== false
        && b.transactionTimeSec === null,
    );
    if (undatedCandidate && intent.outcome === null) {
      return {
        intentId: intent.intentId, action: "ESCALATE",
        reason: "an open contract on this symbol carries no purchase time, so it can be "
          + "neither attributed to this order nor ruled out",
      };
    }

    // WRITTEN or UNRECORDED: the venue may have acted. Defer to its evidence.
    const verdict = classifyUnknownCommand(
      toUnknownCommandFacts(intent),
      toUnknownCommandEvidence(intent, venue),
      { now: opts?.now, snapshotFreshnessMs: opts?.snapshotFreshnessMs },
    );
    return { intentId: intent.intentId, action: "RESOLVED", verdict };
  });
}
