// Broker-side close OUTCOME resolution — PURE (no DB, no clock, no IO).
//
// WHY THIS EXISTS (outcome-truth defect)
//   A mission trade's realised result used to be recorded through exactly ONE
//   runtime entrance: `recordMissionTradeCloseByBrokerTicket`, called only when
//   an ARX-issued CLOSE_LIVE_POSITION command FILLS. Take-profit / trailing /
//   protective exits route through ARX, so they were recorded. A position closed
//   by its own STOP-LOSS *at the broker* never comes back through that path, so
//   its loss was never recorded at all. Wins in, stop-losses out — the realised
//   figure was structurally biased UPWARD.
//
//   The fix records the outcome from BROKER truth as well. This module is the
//   single decision surface for "what may we honestly record?".
//
// HONESTY SPINE (inviolable)
//   • A P/L is recorded ONLY when the BROKER reported one. We never derive it
//     from the last observed floating P/L, from the stop-loss level, from the
//     take-profit level, or from any price we did not receive as a broker fill.
//   • When the broker tells us a position is gone but gives us no numbers, the
//     honest record is: closed = true, pnl = null, status = UNRECONCILED with a
//     typed reason. An absent figure is always better than a flattering one.
//   • An UNRECONCILED outcome is never silently averaged away: it is counted by
//     the completeness read (`missionOutcomeCompleteness.ts`) which holds the
//     mission's target lock and labels the UI figure as incomplete.

import type { BrokerAbsentGhostCandidate } from "./brokerAbsenceReconcile.js";

/** Where the knowledge that the trade closed came from. */
export type MissionOutcomeSource =
  /** An ARX-issued CLOSE_LIVE_POSITION command reached LIVE_FILLED. */
  | "ARX_CLOSE_FILL"
  /** The broker/EA explicitly reported the closed deal for this ticket. */
  | "BROKER_CLOSE_REPORT"
  /** The position vanished from N consecutive reliable COMPLETE broker sweeps. */
  | "BROKER_ABSENCE";

/** Whether the recorded outcome carries a broker-confirmed P/L. */
export type MissionOutcomeStatus = "RECONCILED" | "UNRECONCILED";

/**
 * Typed reasons a recorded close carries no P/L. These are surfaced verbatim in
 * `resultJson.outcome.unreconciledReason` and drive the UI completeness copy.
 */
export const OUTCOME_UNRECONCILED_NO_BROKER_PNL = "UNRECONCILED_NO_BROKER_PNL" as const;
export const OUTCOME_UNRECONCILED_BROKER_ABSENT = "UNRECONCILED_BROKER_ABSENT" as const;

export type MissionOutcomeUnreconciledReason =
  | typeof OUTCOME_UNRECONCILED_NO_BROKER_PNL
  | typeof OUTCOME_UNRECONCILED_BROKER_ABSENT;

/** Exit reason stamped on a close ARX did not initiate. */
export const BROKER_SIDE_EXIT_REASON = "broker_side_close" as const;

export interface BrokerCloseEvidence {
  source: MissionOutcomeSource;
  /**
   * Realised P/L in ACCOUNT currency exactly as the broker reported it. A loss
   * is negative and is just as valid as a win. `null`/`undefined` means the
   * broker gave us nothing — we then refuse to invent one.
   */
  brokerRealisedPnl?: number | null;
  /** Close FILL price as reported by the broker (evidence only — never math). */
  brokerClosePrice?: number | null;
}

export interface BrokerCloseOutcome {
  source: MissionOutcomeSource;
  status: MissionOutcomeStatus;
  /** ONLY ever a broker-reported figure; null when the broker reported none. */
  realisedPnl: number | null;
  /** Broker-reported close fill price, or null. Carried as evidence only. */
  closePrice: number | null;
  unreconciledReason: MissionOutcomeUnreconciledReason | null;
  /** Exit trigger recorded on the draft. */
  exitReason: string;
}

/**
 * A broker P/L is trustworthy when it is a finite number that was actually
 * present in the report. Negative and zero are BOTH legitimate realised results
 * (a stop-out is negative; a scratch is zero), so — unlike a fill PRICE, where
 * `realizedPnl.ts` rejects 0 — we do not reject them here. What we reject is
 * anything that is not a real number: null, undefined, NaN, ±Infinity, strings.
 */
export function isBrokerReportedPnl(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** A broker close FILL price is only real when finite and strictly > 0. */
export function isBrokerReportedClosePrice(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

/**
 * Decide what may honestly be recorded for a close ARX did not perform.
 *
 * NEVER infers. With a broker P/L → RECONCILED with that exact number (loss
 * included). Without one → UNRECONCILED, pnl null, typed reason. A close price
 * on its own does NOT become a P/L here: converting a price to account currency
 * needs contract size + FX, and a plausible wrong dollar figure is worse than an
 * honestly absent one.
 */
export function resolveBrokerCloseOutcome(ev: BrokerCloseEvidence): BrokerCloseOutcome {
  const closePrice = isBrokerReportedClosePrice(ev.brokerClosePrice) ? ev.brokerClosePrice : null;
  if (isBrokerReportedPnl(ev.brokerRealisedPnl)) {
    return {
      source: ev.source,
      status: "RECONCILED",
      realisedPnl: ev.brokerRealisedPnl,
      closePrice,
      unreconciledReason: null,
      exitReason: BROKER_SIDE_EXIT_REASON,
    };
  }
  return {
    source: ev.source,
    status: "UNRECONCILED",
    realisedPnl: null,
    closePrice,
    unreconciledReason:
      ev.source === "BROKER_ABSENCE"
        ? OUTCOME_UNRECONCILED_BROKER_ABSENT
        : OUTCOME_UNRECONCILED_NO_BROKER_PNL,
    exitReason: BROKER_SIDE_EXIT_REASON,
  };
}

/**
 * A close the broker explicitly REPORTED for one of our tickets, with whatever
 * numbers it chose to give us. Any of the numbers may legitimately be absent.
 */
export interface BrokerCloseReport {
  brokerTicket: string;
  /** Realised P/L in account currency, exactly as reported. Negative = a loss. */
  brokerRealisedPnl?: number | null;
  /** Close fill price, exactly as reported. */
  brokerClosePrice?: number | null;
}

/** Why a broker close report was accepted or refused for this bridge. */
export type BrokerCloseReportAttribution =
  /** A position row for this ticket exists on THIS bridge. */
  | "THIS_BRIDGE"
  /** Rows exist for this ticket, but only on ANOTHER of the user's bridges. */
  | "OTHER_BRIDGE"
  /** No position row anywhere for this user — nothing to confuse it with. */
  | "UNKNOWN_TICKET";

/**
 * PURE. Decide which broker close reports this bridge may be believed about.
 *
 * WHY THIS EXISTS. Broker ticket numbers are broker-local, so one user's two
 * bridges can legitimately carry the SAME ticket string. The close-report ingest
 * originally matched on userId alone, which let bridge A's EA stamp a close —
 * and write a broker-realised P/L that flows straight into the mission's
 * realised money figure — onto bridge B's position.
 *
 * THE RULE, and why it is not simply "must be on this bridge". Position rows are
 * created ONLY by the snapshot ingest, so a trade that opens and stops out
 * between two sweeps never gets a row at all. Refusing every ticket without a
 * row on this bridge would therefore throw away exactly the broker-confirmed P/L
 * this whole branch is trying to capture. So:
 *   • rows on THIS bridge          → accept (unambiguous).
 *   • rows only on ANOTHER bridge  → REFUSE (this is the collision we fear).
 *   • no rows anywhere             → accept (there is no other claimant; the
 *                                    ambiguity the refusal protects against does
 *                                    not exist).
 * RESIDUAL, stated plainly: an UNKNOWN ticket is still resolved to a mission
 * draft by (userId, ticket) downstream, so a ticket that collides with a draft
 * dispatched on a different bridge AND has no position row on either would be
 * mis-attributed. Closing that needs bridge attribution on the draft itself,
 * which this layer does not have.
 */
export function attributeBrokerCloseReports(args: {
  bridgeConnectionId: number;
  reportTickets: string[];
  /** Every position row this USER holds for those tickets, across ALL bridges. */
  positionRows: Array<{ brokerTicket: string | null; bridgeConnectionId: number | null }>;
}): {
  accepted: string[];
  refused: Array<{ brokerTicket: string; attribution: BrokerCloseReportAttribution }>;
} {
  const onThisBridge = new Set<string>();
  const onAnyBridge = new Set<string>();
  for (const row of args.positionRows) {
    const t = typeof row.brokerTicket === "string" ? row.brokerTicket.trim() : "";
    if (t.length === 0) continue;
    onAnyBridge.add(t);
    if (row.bridgeConnectionId === args.bridgeConnectionId) onThisBridge.add(t);
  }

  const accepted: string[] = [];
  const refused: Array<{ brokerTicket: string; attribution: BrokerCloseReportAttribution }> = [];
  const seen = new Set<string>();
  for (const raw of args.reportTickets) {
    const t = typeof raw === "string" ? raw.trim() : "";
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    if (onThisBridge.has(t)) accepted.push(t);
    else if (onAnyBridge.has(t)) refused.push({ brokerTicket: t, attribution: "OTHER_BRIDGE" });
    else accepted.push(t);
  }
  return { accepted, refused };
}

/**
 * One recording instruction — precisely the arguments handed to the SAME honest
 * recorder the ARX close path uses (`recordMissionTradeCloseByBrokerTicket`).
 * There is no second recorder and no second set of rules.
 */
export interface BrokerCloseRecording {
  brokerTicket: string;
  realisedPnl: number | null;
  outcomeSource: MissionOutcomeSource;
  outcomeStatus: MissionOutcomeStatus;
  unreconciledReason: MissionOutcomeUnreconciledReason | null;
  brokerClosePrice: number | null;
  exitReason: string;
}

/**
 * PURE. Turn broker evidence into recording instructions.
 *
 * Precedence: an EXPLICIT broker close report always wins over absence evidence
 * for the same ticket — a report carries the broker's own numbers, absence
 * carries none. A ticket is never planned twice.
 *
 * Absence candidates are only accepted when the shared safety evaluator marked
 * them `safeToStampClosed` — same bar as the action path. Anything blocked
 * (unreliable sweep, incomplete sweep, cross-user/bridge, uncertain mapping,
 * pending ARX close, too little / too young absence evidence) records NOTHING.
 *
 * `reconciledAbsentTickets` is the RECOVERY source (forward-fix). When the
 * ACTION path (`runBrokerAbsenceReconcile`, flag-gated) stamps a row
 * closed_at + reconcileState=RECONCILED_BROKER_ABSENT, that row stops matching
 * the observer's open-and-unreconciled candidate query — permanently. Without
 * this source the mission outcome for that trade would never be recorded at all
 * and the draft would stay open forever. These tickets already cleared the
 * IDENTICAL evidence bar (the action path applies the same evaluator), so
 * recording an honest UNRECONCILED close for them fabricates nothing: it is the
 * same numberless close the absence path would have produced had it won the
 * race. The recorder is idempotent, so a re-offered ticket is a no-op.
 */
export function planBrokerCloseRecordings(args: {
  reports?: BrokerCloseReport[];
  absenceCandidates?: BrokerAbsentGhostCandidate[];
  reconciledAbsentTickets?: string[];
}): BrokerCloseRecording[] {
  const out: BrokerCloseRecording[] = [];
  const seen = new Set<string>();

  for (const r of args.reports ?? []) {
    const ticket = typeof r.brokerTicket === "string" ? r.brokerTicket.trim() : "";
    if (ticket.length === 0 || seen.has(ticket)) continue;
    seen.add(ticket);
    const outcome = resolveBrokerCloseOutcome({
      source: "BROKER_CLOSE_REPORT",
      brokerRealisedPnl: r.brokerRealisedPnl,
      brokerClosePrice: r.brokerClosePrice,
    });
    out.push({
      brokerTicket: ticket,
      realisedPnl: outcome.realisedPnl,
      outcomeSource: outcome.source,
      outcomeStatus: outcome.status,
      unreconciledReason: outcome.unreconciledReason,
      brokerClosePrice: outcome.closePrice,
      exitReason: outcome.exitReason,
    });
  }

  for (const c of args.absenceCandidates ?? []) {
    if (!c.safeToStampClosed) continue;
    const ticket = typeof c.brokerTicket === "string" ? c.brokerTicket.trim() : "";
    if (ticket.length === 0 || seen.has(ticket)) continue;
    seen.add(ticket);
    // Absence gives us the FACT of a close and nothing else. No price, no P/L,
    // and we refuse to derive either. Honest typed null.
    const outcome = resolveBrokerCloseOutcome({ source: "BROKER_ABSENCE" });
    out.push({
      brokerTicket: ticket,
      realisedPnl: outcome.realisedPnl,
      outcomeSource: outcome.source,
      outcomeStatus: outcome.status,
      unreconciledReason: outcome.unreconciledReason,
      brokerClosePrice: outcome.closePrice,
      exitReason: outcome.exitReason,
    });
  }

  for (const t of args.reconciledAbsentTickets ?? []) {
    const ticket = typeof t === "string" ? t.trim() : "";
    if (ticket.length === 0 || seen.has(ticket)) continue;
    seen.add(ticket);
    // Same honest numberless close as the absence path: the ACTION path already
    // proved the position is gone, and it gave us no P/L to record either.
    const outcome = resolveBrokerCloseOutcome({ source: "BROKER_ABSENCE" });
    out.push({
      brokerTicket: ticket,
      realisedPnl: outcome.realisedPnl,
      outcomeSource: outcome.source,
      outcomeStatus: outcome.status,
      unreconciledReason: outcome.unreconciledReason,
      brokerClosePrice: outcome.closePrice,
      exitReason: outcome.exitReason,
    });
  }

  return out;
}
