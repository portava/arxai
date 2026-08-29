// Mission realised-outcome COMPLETENESS — PURE (no DB, no clock, no IO).
//
// WHY THIS EXISTS (outcome-truth defect)
//   "Realised profit" / "Peak realised" / the target-locked badge are summed
//   over executed mission drafts that carry a `closedAt` AND a finite `pnl`. A
//   trade whose outcome was never recorded, or was recorded WITHOUT a
//   broker-confirmed P/L, silently drops out of that sum. Because the missing
//   outcomes skewed toward stop-loss LOSSES, the figure read better than the
//   truth and a mission could lock its target on a set that was not complete.
//
//   This module makes the incompleteness VISIBLE and BINDING:
//     • it counts what is missing, with typed reasons;
//     • the UI states the figure is incomplete instead of showing it bare;
//     • `applyCompletenessToMilestone` marks the TARGET CLAIM as unconfirmed
//       while anything is unrecorded — a mission may never be declared complete
//       on a partial set.
//
// NOT A FLOOR (forward-fix, supersedes the first cut of this module). The first
// version of this copy called the shown figure a "floor" and told the user to
// read it as a lower bound. That is FALSE, and false in exactly the direction
// this module exists to stop: the missing outcomes skew toward stop-loss
// LOSSES, so excluding them makes the shown number an UPPER-biased estimate,
// not a lower bound. An incomplete realised figure is a bound in NEITHER
// direction. Every string here says so plainly.
//
// NEVER REMOVES A STOP (forward-fix). The first cut flipped `stopAndLock` from
// true to false while outcomes were missing and called that "the protective
// direction". It is the opposite: `stopAndLock` is what STOPS the mission
// taking new trades (`missionDriver.ts` derives `targetReached` from it), so
// turning it off resumes trading on an unverified set. AUTO authority may only
// REDUCE exposure. The gate therefore leaves the stop exactly as the engine set
// it and withholds only the CLAIM — mission completion and the "target reached"
// journal entry are held until every outcome is broker-confirmed.
//
// HONEST DEGRADATION: an incomplete read never fabricates the missing P/L and
// never guesses a direction. It says "we do not know yet", it never widens
// risk, and it never converts silence into a flattering claim.

import type { MissionOutcomeStatus } from "./live/brokerCloseOutcome.js";

/** One executed mission draft (the de-facto mission-trade record). */
export interface MissionDraftOutcomeRow {
  draftId: string;
  brokerTicket: string | null;
  closedAt: Date | null;
  pnl: number | null;
  /** `resultJson.outcome.status` when the close was recorded from broker truth. */
  outcomeStatus: MissionOutcomeStatus | string | null;
}

/** One live-position row belonging to the same user, keyed by broker ticket. */
export interface MissionPositionOutcomeRow {
  brokerTicket: string;
  closedAt: Date | null;
  reconcileState: string | null;
  brokerAbsentSnapshotCount: number;
}

export interface MissionOutcomeCompleteness {
  /** True ONLY when every executed trade's closed outcome is broker-confirmed. */
  complete: boolean;
  /** Executed drafts carrying a recorded close. */
  closedTradeCount: number;
  /** Closed AND carrying a broker-confirmed P/L — the figures you can trust. */
  reconciledCloseCount: number;
  /** Closed but with NO broker-confirmed P/L (recorded honestly as unknown). */
  unreconciledCloseCount: number;
  /** Broker says the position is gone but no mission outcome is recorded yet. */
  pendingOutcomeCount: number;
  /** Executed drafts the broker still confirms OPEN (floating, not missing). */
  openTradeCount: number;
  /** Plain-language, user-facing statements of what is missing. Never spun. */
  reasons: string[];
}

function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Classify every executed mission draft against the broker's own position rows.
 *
 * A draft is:
 *   • RECONCILED   — closed with a broker-confirmed finite P/L.
 *   • UNRECONCILED — closed, but the broker gave no P/L (pnl stays null).
 *   • PENDING      — not recorded closed, yet the broker's row says the position
 *                    is closed / reconciled-absent / has accumulated absence
 *                    evidence, OR we cannot find the position at all. In every
 *                    one of those cases the realised figure is missing a result.
 *   • OPEN         — the broker still confirms the position open. This is NOT
 *                    incompleteness: a floating trade has no realised result yet
 *                    and is correctly excluded from a REALISED figure.
 */
export function computeMissionOutcomeCompleteness(args: {
  drafts: MissionDraftOutcomeRow[];
  positions: MissionPositionOutcomeRow[];
  /** Absence sweeps that make a still-open row "the broker says it is gone". */
  absenceEvidenceThreshold: number;
}): MissionOutcomeCompleteness {
  const byTicket = new Map<string, MissionPositionOutcomeRow>();
  for (const p of args.positions) {
    if (typeof p.brokerTicket === "string" && p.brokerTicket.length > 0) {
      byTicket.set(p.brokerTicket, p);
    }
  }

  let closedTradeCount = 0;
  let reconciledCloseCount = 0;
  let unreconciledCloseCount = 0;
  let pendingOutcomeCount = 0;
  let openTradeCount = 0;

  for (const d of args.drafts) {
    if (d.closedAt != null) {
      closedTradeCount += 1;
      // A recorded close counts as reconciled ONLY with a real P/L number AND
      // without an explicit UNRECONCILED stamp. Both conditions matter: an old
      // row may predate the stamp, and a stamped row may carry a stale pnl.
      if (isNum(d.pnl) && d.outcomeStatus !== "UNRECONCILED") reconciledCloseCount += 1;
      else unreconciledCloseCount += 1;
      continue;
    }
    const ticket = typeof d.brokerTicket === "string" ? d.brokerTicket.trim() : "";
    if (ticket.length === 0) {
      // Executed but we never learned its broker ticket — we cannot follow this
      // trade to an outcome at all. Honestly incomplete, never assumed a win.
      pendingOutcomeCount += 1;
      continue;
    }
    const pos = byTicket.get(ticket);
    if (pos == null) {
      // No live-position row for a ticket we dispatched: the outcome is not
      // knowable from here. Counted as missing rather than quietly ignored.
      pendingOutcomeCount += 1;
      continue;
    }
    const brokerSaysClosed =
      pos.closedAt != null ||
      pos.reconcileState === "RECONCILED_BROKER_ABSENT" ||
      pos.brokerAbsentSnapshotCount >= args.absenceEvidenceThreshold;
    if (brokerSaysClosed) pendingOutcomeCount += 1;
    else openTradeCount += 1;
  }

  const reasons: string[] = [];
  if (pendingOutcomeCount > 0) {
    reasons.push(
      `${pendingOutcomeCount} ${plural(pendingOutcomeCount, "trade has", "trades have")} closed at the broker with no result recorded yet.`,
    );
  }
  if (unreconciledCloseCount > 0) {
    reasons.push(
      `${unreconciledCloseCount} closed ${plural(unreconciledCloseCount, "trade", "trades")} ${plural(unreconciledCloseCount, "has", "have")} no broker-confirmed profit or loss, so ${plural(unreconciledCloseCount, "it is", "they are")} not in this figure.`,
    );
  }

  const complete = pendingOutcomeCount === 0 && unreconciledCloseCount === 0;
  if (!complete) {
    // NOT a floor and NOT a ceiling. Unconfirmed closes are excluded entirely,
    // so the true figure may land either side of this number — and because the
    // closes ARX did not perform are most often stop-losses, an incomplete
    // figure reads HIGH more often than it reads low. Never claim a bound.
    reasons.push(
      "Realised profit is incomplete — unconfirmed closes are excluded, so the true figure may be higher or lower than this number.",
    );
    reasons.push(
      "Closes ARX did not perform are most often stop-losses, so an incomplete figure usually reads better than the result.",
    );
  }

  return {
    complete,
    closedTradeCount,
    reconciledCloseCount,
    unreconciledCloseCount,
    pendingOutcomeCount,
    openTradeCount,
    reasons,
  };
}

/** The empty/unknown completeness read used when nothing has executed yet. */
export const COMPLETE_OUTCOME_SET: MissionOutcomeCompleteness = {
  complete: true,
  closedTradeCount: 0,
  reconciledCloseCount: 0,
  unreconciledCloseCount: 0,
  pendingOutcomeCount: 0,
  openTradeCount: 0,
  reasons: [],
};

/** Copy shown wherever a target CLAIM is being held by an incomplete set. */
export const TARGET_CLAIM_HELD_REASON =
  "Target reached on the confirmed results only — the mission is stopped, and completion is held until every closed trade has a broker-confirmed result." as const;

export interface MilestoneLockShape {
  stopAndLock: boolean;
  reasons: string[];
}

/**
 * STRICTER-ONLY gate — and stricter in the direction that matters for capital.
 *
 * `stopAndLock` is not a badge: `missionDriver.ts` derives `targetReached` from
 * it, and `targetReached` is what stops the mission planning new risk. Turning
 * it OFF because we are unsure would RESUME trading on an unverified set, which
 * is a widening of exposure decided by an automated read. This gate therefore
 * NEVER touches `stopAndLock` — it cannot turn a lock on, and it cannot turn one
 * off. The only thing it changes is the set of honest reasons carried alongside.
 *
 * What is actually withheld while the set is incomplete is the CLAIM: the caller
 * (`refreshMissionProtection`) holds the flip to `completed` and the "target
 * reached" journal entry on `completeness.complete`, so ARX stops trading
 * immediately but never announces a result it cannot stand behind.
 */
export function applyCompletenessToMilestone<T extends MilestoneLockShape>(
  milestone: T,
  completeness: MissionOutcomeCompleteness,
): T {
  if (completeness.complete || !milestone.stopAndLock) return milestone;
  return {
    ...milestone,
    reasons: [...milestone.reasons, TARGET_CLAIM_HELD_REASON, ...completeness.reasons],
  };
}
