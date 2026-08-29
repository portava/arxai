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
 */
export function planBrokerCloseRecordings(args: {
  reports?: BrokerCloseReport[];
  absenceCandidates?: BrokerAbsentGhostCandidate[];
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

  return out;
}
