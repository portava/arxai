import {
  type StopMovementSuggestion, type StopAction, type TradeSnapshot,
  TRADE_ADVISOR_THRESHOLDS,
} from "./tradeAdvisor.types";

// suggestStopMovement
//
// Pure: returns NONE / MOVE_TO_BE / TRAIL / TIGHTEN suggestions. NEVER
// returns "widen" — if model logic would suggest a wider stop, the
// engine returns WIDEN_REFUSED with a blocker explaining why. Widening
// stops mid-trade is a textbook revenge-trading anti-pattern; the
// advisor refuses to even surface it as an option.
export function suggestStopMovement(snap: TradeSnapshot): StopMovementSuggestion {
  const T = TRADE_ADVISOR_THRESHOLDS.stopMovement;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const r = snap.trade.unrealizedR;
  const sign = snap.trade.direction === "BUY" ? 1 : -1;
  const oneRPrice = Math.abs(snap.trade.entryPrice - snap.trade.stopLoss);

  if (oneRPrice <= 0) {
    blockers.push("entry-to-stop distance is zero — cannot derive R-based stop levels");
    return mkResult("NONE", null, null, ["malformed trade — stop equals entry"], blockers, snap);
  }
  if (snap.trade.pipSize <= 0) {
    blockers.push("pipSize is zero or negative — cannot compute pip distance");
    return mkResult("NONE", null, null, ["malformed trade — invalid pipSize"], blockers, snap);
  }

  // ── Suggestion 1: Trail at 2R+ ──────────────────────────────────────────
  // A trailing stop at "current price − 1R" locks in 1R of profit.
  if (r >= T.trailAtR) {
    const trailedSl = snap.market.currentPrice - sign * oneRPrice;
    if (isStopMoveImproving(snap, trailedSl)) {
      reasons.push(`at ${r.toFixed(2)}R ≥ ${T.trailAtR}R — trail stop to lock 1R profit`);
      return mkResult("TRAIL", trailedSl, distancePips(snap, trailedSl), reasons, blockers, snap);
    }
  }

  // ── Suggestion 2: Move to break-even at 1R+ ─────────────────────────────
  if (r >= T.moveToBeAtR) {
    const beStop = snap.trade.entryPrice;
    if (isStopMoveImproving(snap, beStop)) {
      reasons.push(`at ${r.toFixed(2)}R ≥ ${T.moveToBeAtR}R — move stop to break-even`);
      return mkResult("MOVE_TO_BE", beStop, distancePips(snap, beStop), reasons, blockers, snap);
    } else {
      reasons.push(`at ${r.toFixed(2)}R but stop already at-or-better than break-even`);
    }
  }

  // ── Suggestion 3: Tighten after MFE retracement ─────────────────────────
  // If we made > 1R, retraced > 50% of MFE, and stop is still original —
  // tighten to cut further bleed. New stop = current price − 0.5R.
  if (snap.extremes.maxFavorableExcursionR > 1.0
      && snap.extremes.maxFavorableExcursionR > r
      && (snap.extremes.maxFavorableExcursionR - r) / snap.extremes.maxFavorableExcursionR
         >= T.tightenAfterMfeRetracementPct) {
    const tightSl = snap.market.currentPrice - sign * 0.5 * oneRPrice;
    if (isStopMoveImproving(snap, tightSl)) {
      reasons.push(
        `MFE ${snap.extremes.maxFavorableExcursionR.toFixed(2)}R retraced ` +
        `≥ ${(T.tightenAfterMfeRetracementPct * 100).toFixed(0)}% — tighten to ${tightSl.toFixed(5)}`,
      );
      return mkResult("TIGHTEN", tightSl, distancePips(snap, tightSl), reasons, blockers, snap);
    }
  }

  reasons.push("no stop movement suggested — trade not yet earned protection");
  return mkResult("NONE", null, null, reasons, blockers, snap);
}

// True when the proposed new stop is closer to the entry side than the
// current stop (i.e. tightens, not widens). For BUY: newStop > currentStop.
// For SELL: newStop < currentStop.
function isStopMoveImproving(snap: TradeSnapshot, newStop: number): boolean {
  if (snap.trade.direction === "BUY")  return newStop > snap.trade.stopLoss;
  return newStop < snap.trade.stopLoss;
}

function distancePips(snap: TradeSnapshot, target: number): number | null {
  if (snap.trade.pipSize <= 0) return null;
  return Math.abs(target - snap.market.currentPrice) / snap.trade.pipSize;
}

function mkResult(
  action: StopAction, newStopLoss: number | null, distancePipsVal: number | null,
  reasons: string[], blockers: string[], snap: TradeSnapshot,
): StopMovementSuggestion {
  // Defensive: never let a non-finite pip distance escape into the result.
  if (distancePipsVal !== null && !Number.isFinite(distancePipsVal)) {
    distancePipsVal = null;
  }
  // Sanity guard: never let a "would widen" sneak through as a real action.
  if (newStopLoss !== null && action !== "NONE" && !isStopMoveImproving(snap, newStopLoss)) {
    return {
      action: "WIDEN_REFUSED", newStopLoss: null, distancePips: null,
      reasons: [...reasons, `proposed stop ${newStopLoss.toFixed(5)} would widen — refused`],
      blockers: [...blockers, "widening stop mid-trade is forbidden by the advisor"],
    };
  }
  return { action, newStopLoss, distancePips: distancePipsVal, reasons, blockers };
}
