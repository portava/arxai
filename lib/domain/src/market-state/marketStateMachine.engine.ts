import {
  type MarketPhase, type MarketSignals, type MarketStateRecord, type Substate,
  MARKET_STATE_THRESHOLDS,
} from "./marketPhase.types";
import { proposeTransition, classifyPhaseFromSignals } from "./stateTransition.engine";
import { detectSubstate } from "./substateDetection.engine";

// stepMarketState — pure state-machine step. Given the previous record and
// fresh signals, returns the next record. Tracks consecutiveConfirmations
// (bars since entering current phase) and bumps it on confirming signals,
// or resets it on conflicting signals. Transitions only when hysteresis
// threshold met (handled by proposeTransition).
//
// The caller persists the returned MarketStateRecord (replacing the prior
// one) — state IS persistent across candles by virtue of being passed
// back in on the next call.
export function stepMarketState(
  prev: MarketStateRecord | null,
  signals: MarketSignals,
  oppositeStreakBefore: number,
): { next: MarketStateRecord; oppositeStreakAfter: number } {
  // Bootstrap — no prior state, just classify
  if (prev === null) {
    const { phase, reasons } = classifyPhaseFromSignals(signals);
    const substate = detectSubstate(phase, signals, 0);
    return {
      next: {
        phase, substate: substate.substate, enteredAt: signals.observedAt,
        consecutiveConfirmations: 1,
        confidence01: substate.confidence01,
        reasons: ["bootstrap state from first signals", ...reasons, ...substate.reasons],
      },
      oppositeStreakAfter: 0,
    };
  }

  const { phase: classified } = classifyPhaseFromSignals(signals);
  const proposal = proposeTransition(prev.phase, signals, oppositeStreakBefore);

  if (proposal.shouldTransition && proposal.proposedPhase !== null) {
    const newPhase: MarketPhase = proposal.proposedPhase;
    const sub = detectSubstate(newPhase, signals, 1);
    return {
      next: {
        phase: newPhase, substate: sub.substate, enteredAt: signals.observedAt,
        consecutiveConfirmations: 1,
        confidence01: sub.confidence01,
        reasons: [...proposal.reasons, ...sub.reasons],
      },
      oppositeStreakAfter: 0,
    };
  }

  // No transition — confirm or reset opposite streak
  const confirms = classified === prev.phase;
  const nextConsec = confirms ? prev.consecutiveConfirmations + 1 : prev.consecutiveConfirmations;
  const nextOpposite = confirms ? 0 : oppositeStreakBefore + 1;
  const sub = detectSubstate(prev.phase, signals, nextConsec);
  return {
    next: {
      phase: prev.phase,
      substate: sub.substate,
      enteredAt: prev.enteredAt,
      consecutiveConfirmations: nextConsec,
      confidence01: sub.confidence01,
      reasons: confirms
        ? [`${nextConsec}-bar confirmation of ${prev.phase}`, ...sub.reasons]
        : [`opposite signal ${classified} (${nextOpposite}/${MARKET_STATE_THRESHOLDS.hysteresisBars}) — hold ${prev.phase}`, ...sub.reasons],
    },
    oppositeStreakAfter: nextOpposite,
  };
}

// Re-export for convenience.
export type { MarketStateRecord, MarketPhase, Substate, MarketSignals };
