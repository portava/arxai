// Task #199 — signal-outcome resolution wrapper. PURE, OBSERVATION ONLY.
//
// The canonical verdict comes from the PROVEN, fail-closed prediction resolver
// (resolvePredictionOutcome) — we do NOT re-implement that logic so the two can
// never drift. This wrapper only:
//   1. forwards the same evidence (a matched closed trade and/or observed
//      decisive candle movement; elapsed time alone NEVER grades), and
//   2. derives an ExitReason (TP/SL/EXPIRED/INVALIDATED/MANUAL) from the SAME
//      real evidence — never invented.
//
// FAIL-CLOSED: when the underlying resolver says `resolvable:false` the caller
// must leave the row PENDING/UNRESOLVED. No fabrication, no time-only verdicts.

import {
  resolvePredictionOutcome,
  type OutcomeEvidence,
} from "../agent-system/review/outcomeResolution.engine";
import type { ExitReason, SignalOutcomeStatus } from "./rubyQuality.types";

export interface SignalOutcomeEvidence extends OutcomeEvidence {
  /** Whether the user actually took the trade (entered) vs ignored the signal. */
  userEntered?: boolean;
  /** Real broker/close evidence that price reached take-profit. */
  tpHit?: boolean;
  /** Real broker/close evidence that price reached stop-loss. */
  slHit?: boolean;
  /** The setup's invalidation level was hit before any entry/target. */
  invalidated?: boolean;
}

export interface SignalOutcomeResolution {
  status: SignalOutcomeStatus;
  pnlR: number | null;
  resolvable: boolean;
  reason: string;
  exitReason: ExitReason | null;
}

/** Decide a signal's realized outcome + exit reason from observed evidence. PURE. */
export function resolveSignalOutcome(
  signal: { decision: string; direction: string | null },
  ev: SignalOutcomeEvidence,
): SignalOutcomeResolution {
  const base = resolvePredictionOutcome(signal, ev);
  const status = base.status as SignalOutcomeStatus;

  return {
    status,
    pnlR: base.pnlR,
    resolvable: base.resolvable,
    reason: base.reason,
    exitReason: deriveExitReason(status, ev),
  };
}

/**
 * Derive the exit reason from REAL evidence only. Returns null when the user
 * never entered (a no-trade / observation has no exit) or when the evidence is
 * insufficient to name a concrete exit.
 */
function deriveExitReason(
  status: SignalOutcomeStatus,
  ev: SignalOutcomeEvidence,
): ExitReason | null {
  if (ev.invalidated) return "INVALIDATED";
  // No exit reason for a trade that was never taken.
  if (ev.userEntered !== true) return null;
  if (ev.tpHit) return "TP";
  if (ev.slHit) return "SL";
  if (status === "WIN") return "TP";
  if (status === "LOSS") return "SL";
  if (status === "BREAKEVEN" || status === "EXPIRED") return "EXPIRED";
  // Resolved off a closed trade but neither target named → manual/discretionary.
  if (ev.closedTradeExists) return "MANUAL";
  return null;
}
