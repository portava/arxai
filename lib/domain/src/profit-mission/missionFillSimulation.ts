// Profit Mission — HONEST paper/demo fill simulation (pure, IO-free, deterministic).
//
// WHY THIS EXISTS: before this module a paper/demo mission recorded an audit row
// and stopped. Nothing ever wrote an outcome for a non-live draft, so a paper or
// demo mission's value was frozen forever, it could never complete, and the
// promotion gate's `demo_performance` requirement (sample ≥ 20) had NO producible
// source — which made the ONLY road to any auto level real-money trading at
// level 2. This module is the missing arithmetic.
//
// THE HONESTY CONTRACT (the whole reason this may exist at all):
//   1. NO INVENTED PRICES. Every price this module returns is taken from a REAL
//      quote handed in by the caller (the market-data router's quote at decision
//      time). No quote → no fill, and the caller gets the typed reason
//      `NO_FILL_NO_QUOTE`. There is no synthetic-price branch, at all.
//   2. NOT BROKER TRUTH. Everything produced here is a MODEL of what a fill
//      would have been. It is tagged simulated at the row level by the caller and
//      is never a broker-reconciled figure. It must never enter an economic
//      posting or be summed into a live realised total.
//   3. THE ASSUMPTIONS TRAVEL WITH THE NUMBER. `SIMULATED_FILL_ASSUMPTIONS`
//      records exactly what is and is NOT modelled (spread crossing yes;
//      slippage, partial fills, commission/swap, latency, gap risk no) and the
//      caller persists it ON the row, so nobody downstream can mistake a
//      simulated outcome for execution truth.
//   4. UNMODELLED IS SAID, NOT GUESSED. Slippage is recorded as
//      "NONE_MODELLED" rather than given an invented number — an invented cost is
//      still an invented price.
//
// Nothing here executes, dispatches, or touches a gate. It is arithmetic over
// numbers the caller already read honestly.

/** Bumped whenever the modelling changes, so old rows stay interpretable. */
export const SIMULATED_FILL_MODEL_VERSION = "mission-sim-fill/1";

/** What this model does and — just as importantly — does not do. */
export const SIMULATED_FILL_ASSUMPTIONS = {
  model: SIMULATED_FILL_MODEL_VERSION,
  /** Entry crosses the real spread: a BUY pays the ask, a SELL receives the bid. */
  spreadCrossing: "REAL_QUOTE_SPREAD_CROSSED",
  /** No slippage is invented. A modelled fill sits exactly on the quoted side. */
  slippage: "NONE_MODELLED",
  /** The full requested volume is assumed to fill in one piece. */
  partialFills: "NONE_MODELLED_FULL_VOLUME_ASSUMED",
  /** Commission, swap and financing are outside this model. */
  commissionsAndSwap: "NOT_MODELLED",
  /** Order latency / queue position are outside this model. */
  latency: "NONE_MODELLED",
  /** A stop or target is modelled as filling exactly at its level — a real gap
   *  through the level would fill worse. Never model a gap in the user's favour. */
  gapRisk: "NOT_MODELLED_STOP_AND_TARGET_FILL_AT_LEVEL",
  /** P/L is derived from the mission's OWN planned risk, not a contract size. */
  pnlDerivation: "R_MULTIPLE_TIMES_PLANNED_RISK_AMOUNT",
} as const;

export type SimulatedFillAssumptions = typeof SIMULATED_FILL_ASSUMPTIONS;

/** Typed refusals. A refusal is a correct output — never a fabricated fill. */
export type SimulatedFillRefusal =
  /** The router returned no quote at all for this symbol. */
  | "NO_FILL_NO_QUOTE"
  /** A quote arrived but carried no usable price on the side we must trade. */
  | "NO_FILL_NO_USABLE_PRICE"
  /** The draft carries no BUY/SELL direction, so there is nothing to fill. */
  | "NO_FILL_NO_DIRECTION";

export type SimulatedSide = "BUY" | "SELL";

/** The real quote, narrowed to the numbers a fill needs. Nulls are honest. */
export interface SimulatedQuoteInput {
  bid: number | null;
  ask: number | null;
  last: number | null;
}

/** How the quoted price for one side was obtained. */
export type SimulatedPriceBasis =
  /** The side-correct half of a real two-sided quote (BUY→ask, SELL→bid). */
  | "REAL_BID_ASK_CROSSED"
  /** Only a single (last/mid) price existed — the spread could not be crossed,
   *  so the fill is optimistic by up to half a spread. Recorded, never hidden. */
  | "REAL_LAST_NO_SPREAD_AVAILABLE";

export interface SimulatedPrice {
  price: number;
  basis: SimulatedPriceBasis;
}

function isNum(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function isSimulatedSide(v: unknown): v is SimulatedSide {
  return v === "BUY" || v === "SELL";
}

/**
 * The REAL price at which the given side would transact right now: a BUY lifts
 * the ask, a SELL hits the bid. Falls back to `last` ONLY when the quote carries
 * no two-sided price, and says so in the basis. Returns null when the quote has
 * no usable number — never a substitute.
 */
export function quotedPriceForSide(
  side: SimulatedSide,
  quote: SimulatedQuoteInput | null | undefined,
): SimulatedPrice | null {
  if (quote == null) return null;
  const sided = side === "BUY" ? quote.ask : quote.bid;
  if (isNum(sided) && sided > 0) return { price: sided, basis: "REAL_BID_ASK_CROSSED" };
  if (isNum(quote.last) && quote.last > 0) {
    return { price: quote.last, basis: "REAL_LAST_NO_SPREAD_AVAILABLE" };
  }
  return null;
}

/** The side that CLOSES a position opened on `side`. */
export function closingSide(side: SimulatedSide): SimulatedSide {
  return side === "BUY" ? "SELL" : "BUY";
}

export type SimulatedEntryFill =
  | {
      ok: true;
      side: SimulatedSide;
      /** The modelled entry price — a real quoted price, never invented. */
      price: number;
      basis: SimulatedPriceBasis;
      assumptions: SimulatedFillAssumptions;
    }
  | { ok: false; refusal: SimulatedFillRefusal; detail: string };

/**
 * Model the ENTRY fill for a paper/demo draft from a real quote. No quote (or no
 * usable price in it) means NO FILL and a typed reason — the honest degraded
 * state the spine requires, never a fabricated entry.
 */
export function simulateEntryFill(args: {
  direction: string | null | undefined;
  quote: SimulatedQuoteInput | null | undefined;
}): SimulatedEntryFill {
  const side = args.direction != null ? args.direction.trim().toUpperCase() : "";
  if (!isSimulatedSide(side)) {
    return {
      ok: false,
      refusal: "NO_FILL_NO_DIRECTION",
      detail: "the draft carries no BUY/SELL direction, so there is nothing to fill",
    };
  }
  if (args.quote == null) {
    return {
      ok: false,
      refusal: "NO_FILL_NO_QUOTE",
      detail:
        "no real quote was available at decision time — a simulated fill is refused rather than priced from an invented number",
    };
  }
  const priced = quotedPriceForSide(side, args.quote);
  if (priced == null) {
    return {
      ok: false,
      refusal: "NO_FILL_NO_USABLE_PRICE",
      detail: `the quote carried no usable ${side === "BUY" ? "ask" : "bid"} or last price — no fill is modelled`,
    };
  }
  return {
    ok: true,
    side,
    price: priced.price,
    basis: priced.basis,
    assumptions: SIMULATED_FILL_ASSUMPTIONS,
  };
}

/** Why a simulated position closed. Mirrors the live exit vocabulary. */
export type SimulatedExitTrigger =
  | "stop_loss"
  | "take_profit"
  | "protective_exit"
  | "mission_ended";

export type SimulatedExitEvaluation =
  | {
      closed: true;
      trigger: SimulatedExitTrigger;
      /** Exit price — a real quoted price, or the stop/target level it crossed. */
      exitPrice: number;
      basis: SimulatedPriceBasis | "AT_PROTECTIVE_LEVEL";
      /** The honest mark at evaluation time (what we could exit at right now). */
      markPrice: number;
      reason: string;
    }
  | {
      closed: false;
      /** Present when a real quote priced the mark; null when unreadable. */
      markPrice: number | null;
      refusal: SimulatedFillRefusal | null;
      reason: string;
    };

/**
 * Evaluate an OPEN simulated position against a REAL subsequent quote using the
 * same exit logic a live position obeys: stop first (losses are recognised before
 * gains), then target, then any protective close the caller's exit engine
 * decided. No quote → the position simply stays open with a typed reason; a
 * simulated position is NEVER closed at a price nobody quoted.
 *
 * STOP-BEFORE-TARGET is deliberate: when a single quote sits beyond both levels
 * the pessimistic branch is taken, because the order in which price visited them
 * is unknowable from one quote and assuming the favourable one would be a lie in
 * the user's favour.
 */
export function evaluateSimulatedExit(args: {
  side: SimulatedSide;
  stopLoss: number | null;
  takeProfit: number | null;
  quote: SimulatedQuoteInput | null | undefined;
  /** The caller's protective-exit engine asked for an immediate close. */
  protectiveClose?: boolean;
  /** The mission's window ended — close at the honest current mark. */
  missionEnded?: boolean;
}): SimulatedExitEvaluation {
  const exitSide = closingSide(args.side);
  const priced = quotedPriceForSide(exitSide, args.quote);
  if (priced == null) {
    return {
      closed: false,
      markPrice: null,
      refusal: args.quote == null ? "NO_FILL_NO_QUOTE" : "NO_FILL_NO_USABLE_PRICE",
      reason:
        "no real quote was available — the simulated position stays open rather than close at an invented price",
    };
  }
  const mark = priced.price;

  // Stop first: the pessimistic branch when one quote sits beyond both levels.
  const stopHit =
    isNum(args.stopLoss) &&
    (args.side === "BUY" ? mark <= args.stopLoss : mark >= args.stopLoss);
  if (stopHit && isNum(args.stopLoss)) {
    return {
      closed: true,
      trigger: "stop_loss",
      exitPrice: args.stopLoss,
      basis: "AT_PROTECTIVE_LEVEL",
      markPrice: mark,
      reason: `the real quote reached the stop at ${args.stopLoss} (modelled as filling exactly at the level; a real gap would fill worse)`,
    };
  }
  const targetHit =
    isNum(args.takeProfit) &&
    (args.side === "BUY" ? mark >= args.takeProfit : mark <= args.takeProfit);
  if (targetHit && isNum(args.takeProfit)) {
    return {
      closed: true,
      trigger: "take_profit",
      exitPrice: args.takeProfit,
      basis: "AT_PROTECTIVE_LEVEL",
      markPrice: mark,
      reason: `the real quote reached the target at ${args.takeProfit} (modelled as filling exactly at the level)`,
    };
  }
  if (args.protectiveClose === true || args.missionEnded === true) {
    return {
      closed: true,
      trigger: args.missionEnded === true ? "mission_ended" : "protective_exit",
      exitPrice: mark,
      basis: priced.basis,
      markPrice: mark,
      reason:
        args.missionEnded === true
          ? "the mission window ended — the simulated position is closed at the real current quote"
          : "the protective exit engine asked for a close — modelled at the real current quote",
    };
  }
  return {
    closed: false,
    markPrice: mark,
    refusal: null,
    reason: "no stop, target, or protective trigger was reached — the simulated position stays open",
  };
}

/**
 * The risk distance (price terms) the mission's `riskAmount` was sized against:
 * the PLANNED entry-to-stop distance. Null when either leg is missing or the
 * distance is degenerate — in which case no simulated P/L may be derived at all.
 */
export function plannedRiskDistance(args: {
  plannedEntryPrice: number | null;
  stopLoss: number | null;
}): number | null {
  if (!isNum(args.plannedEntryPrice) || !isNum(args.stopLoss)) return null;
  const d = Math.abs(args.plannedEntryPrice - args.stopLoss);
  return d > 0 ? d : null;
}

/**
 * Realised reward-to-risk of a simulated round trip. Uses the ACTUAL simulated
 * fill for the move and the PLANNED risk distance as the R unit, so the cost of
 * entering away from plan lands honestly in the R figure instead of vanishing.
 */
export function simulatedRMultiple(args: {
  side: SimulatedSide;
  entryPrice: number;
  exitPrice: number;
  riskDistance: number | null;
}): number | null {
  if (!isNum(args.entryPrice) || !isNum(args.exitPrice)) return null;
  if (!isNum(args.riskDistance) || args.riskDistance <= 0) return null;
  const move = args.side === "BUY" ? args.exitPrice - args.entryPrice : args.entryPrice - args.exitPrice;
  const r = move / args.riskDistance;
  return Number.isFinite(r) ? r : null;
}

/**
 * Simulated P/L in account currency, derived from the mission's own planned risk
 * (`riskAmount`) times the realised R. This deliberately avoids inventing a
 * contract size / pip value: if the plan risked X at the stop, a 1.5R simulated
 * outcome is +1.5·X. When either input is unknown the answer is null — an
 * unknown P/L is reported as unknown, never plugged with a zero.
 */
export function simulatedPnl(args: {
  rMultiple: number | null;
  riskAmount: number | null;
}): number | null {
  if (!isNum(args.rMultiple) || !isNum(args.riskAmount) || args.riskAmount <= 0) return null;
  const pnl = args.rMultiple * args.riskAmount;
  return Number.isFinite(pnl) ? pnl : null;
}

/**
 * The basis behind a body of closed-trade evidence. This label travels with the
 * promotion decision so a gate satisfied by internally modelled fills can never
 * be read as broker-reconciled performance.
 */
export type PromotionEvidenceBasis =
  /** No closed evidence at all. */
  | "NONE"
  /** Every closed trade is an internally modelled (paper/demo) fill. */
  | "SIMULATED"
  /** Every closed trade is broker-reconciled money. */
  | "BROKER_RECONCILED"
  /** Both kinds are present. */
  | "MIXED"
  /** The caller did not state a basis (older callers) — never treated as proven. */
  | "UNSTATED";

/** Compose the basis label from the two counts. Pure. */
export function evidenceBasisFor(args: {
  simulatedCount: number;
  brokerReconciledCount: number;
}): PromotionEvidenceBasis {
  const sim = args.simulatedCount > 0;
  const real = args.brokerReconciledCount > 0;
  if (sim && real) return "MIXED";
  if (sim) return "SIMULATED";
  if (real) return "BROKER_RECONCILED";
  return "NONE";
}

/** One-line, user-safe description of an evidence basis. Never overstates. */
export function describeEvidenceBasis(basis: PromotionEvidenceBasis): string {
  switch (basis) {
    case "SIMULATED":
      return "SIMULATED evidence — fills modelled from real quotes, not broker-reconciled money";
    case "MIXED":
      return "MIXED evidence — part broker-reconciled money, part SIMULATED fills modelled from real quotes";
    case "BROKER_RECONCILED":
      return "broker-reconciled evidence";
    case "NONE":
      return "no closed evidence yet";
    case "UNSTATED":
    default:
      return "evidence basis not stated — treated as unproven";
  }
}
