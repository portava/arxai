// ExpectedMoveService — the horizon-level composition the two modules below it
// deliberately refused to do for themselves.
//
// `calendar.ts` answers "how many open minutes and session boundaries does this
// horizon contain"; `expectedMove.ts` is arithmetic over numbers the caller
// supplies. This service is the ONE place they meet: instrument + instant +
// horizon + price in, an expected-move verdict out. It stays pure — no I/O, no
// clock reads (the caller passes `nowMs`), nothing from the dispatch/gate path —
// so it can be unit-tested exactly and can never place, size, or authorise a
// trade.
//
// WHERE σ COMES FROM (and why the answer can be "nowhere")
// --------------------------------------------------------
//   ANALYTIC — a Deriv "Volatility N Index" is DEFINED to target N% annualised
//              volatility on a continuous year, so σ_1min is a closed form of
//              the name. Exact, zero external data, zero estimation error.
//   MEASURED — everything else must be measured upstream (the feature path's
//              EWMA estimator) and passed in as `sigma1min`. This service never
//              measures anything itself.
//
// A caller with no σ gets `available: false` WITH a reason — never a guessed
// number. The same honesty applies to the two other inputs the math cannot do
// without:
//
//   - a venue with no honest calendar (EQUITY_RTH today) refuses rather than
//     borrowing another venue's window;
//   - a horizon that crosses session boundaries refuses when no measured
//     σ_gap is supplied, because silently dropping the gap term UNDERSTATES
//     risk — the dangerous direction for a stop.
//
// Horizons anchor FORWARD from `nowMs`: [nowMs, nowMs + horizon). Near the FX
// weekly close that anchoring decides whether the weekend gap is counted, so
// it is pinned in tests rather than left to intuition.

import {
  getTradingCalendar,
  venueOf,
  type Venue,
} from "./calendar.js";
import {
  band,
  expectedNet,
  expectedRange,
  sigmaOverHorizon,
  synthSigma1min,
  synthVolIndex,
} from "./expectedMove.js";

/** Which of the three honest "how far it moves" numbers the caller wants. */
export type ExpectedMoveFlavor = "range" | "net" | "sigma";

/** How σ_1min was established. */
export type SigmaProvenance = "ANALYTIC" | "MEASURED";

export type ExpectedMoveUnavailableReason =
  | "SIGMA_UNAVAILABLE" // non-synthetic and no measured σ supplied
  | "GAP_SIGMA_UNAVAILABLE" // horizon crosses session boundaries, no σ_gap
  | "CALENDAR_UNAVAILABLE" // venue has no honest calendar (EQUITY_RTH)
  | "INVALID_INPUT"; // non-finite / non-positive price or horizon

export interface ExpectedMoveQuery {
  instrument: string;
  /** Anchor instant (ms since epoch). The horizon runs FORWARD from here. */
  nowMs: number;
  /** Horizon length in wall-clock minutes. */
  horizonMinutes: number;
  /** Current price — every output is linear in it. */
  price: number;
  /** Which number `value` carries. Default "range" (what a stop must survive). */
  flavor?: ExpectedMoveFlavor;
  /**
   * Measured per-minute σ for a NON-synthetic instrument. Ignored for
   * synthetics — their closed form is exact and must not be overridden by an
   * estimate. `null`/absent + non-synthetic ⇒ honest refusal.
   */
  sigma1min?: number | null;
  /**
   * Measured per-boundary gap σ (log-return terms). Only required when the
   * horizon actually crosses a session boundary; a continuous venue never
   * needs it.
   */
  sigmaGap?: number | null;
  /** Force a venue (otherwise derived from the instrument name). */
  venue?: Venue;
}

export interface ExpectedMoveAvailable {
  available: true;
  /** The flavor-selected number, in price units. */
  value: number;
  flavor: ExpectedMoveFlavor;
  /** σ of the log return over the horizon (fraction, not price units). */
  sigmaTau: number;
  /** E[max − min] over the horizon, price units — what a stop must survive. */
  expectedRange: number;
  /** E[|end − start|] over the horizon, price units — what a target may ask. */
  expectedNet: number;
  /** ±1σ / ±2σ band half-widths in price units. */
  bandOneSigma: number;
  bandTwoSigma: number;
  /** Open minutes the calendar found inside the horizon. */
  muMinutes: number;
  /** Session boundaries the horizon crosses. */
  gaps: number;
  provenance: SigmaProvenance;
}

export interface ExpectedMoveUnavailable {
  available: false;
  reason: ExpectedMoveUnavailableReason;
  detail: string;
}

export type ExpectedMoveResult = ExpectedMoveAvailable | ExpectedMoveUnavailable;

/**
 * Resolve σ_1min for an instrument: closed form for a "Volatility N" synthetic,
 * the caller's measured value otherwise, `null` when neither exists. Exported
 * so consumers that only need σ (not a full horizon verdict) share the one
 * resolution order instead of re-implementing it.
 */
export function resolveSigma1min(
  instrument: string,
  measuredSigma1min?: number | null,
): { sigma1min: number; provenance: SigmaProvenance } | null {
  const n = synthVolIndex(instrument);
  if (n != null) return { sigma1min: synthSigma1min(n), provenance: "ANALYTIC" };
  if (
    measuredSigma1min != null &&
    Number.isFinite(measuredSigma1min) &&
    measuredSigma1min > 0
  ) {
    return { sigma1min: measuredSigma1min, provenance: "MEASURED" };
  }
  return null;
}

/**
 * Expected move of an instrument over a forward horizon, or an honest refusal.
 * Pure: same inputs, same answer — no clock, no I/O, no fabrication.
 */
export function expectedMoveOverHorizon(q: ExpectedMoveQuery): ExpectedMoveResult {
  const flavor: ExpectedMoveFlavor = q.flavor ?? "range";

  if (
    !Number.isFinite(q.nowMs) ||
    !Number.isFinite(q.horizonMinutes) || q.horizonMinutes <= 0 ||
    !Number.isFinite(q.price) || q.price <= 0
  ) {
    return {
      available: false,
      reason: "INVALID_INPUT",
      detail:
        `expected move needs a finite anchor, a positive horizon and a positive ` +
        `price (got nowMs=${q.nowMs}, horizonMinutes=${q.horizonMinutes}, price=${q.price})`,
    };
  }

  const calendar = getTradingCalendar(q.instrument, q.venue);
  if (calendar === null) {
    return {
      available: false,
      reason: "CALENDAR_UNAVAILABLE",
      detail:
        `no honest trading calendar exists for ${q.instrument} ` +
        `(venue ${q.venue ?? venueOf(q.instrument)}) — refusing rather than ` +
        `borrowing another venue's schedule`,
    };
  }

  const sigma = resolveSigma1min(q.instrument, q.sigma1min);
  if (sigma === null) {
    return {
      available: false,
      reason: "SIGMA_UNAVAILABLE",
      detail:
        `${q.instrument} is not a Volatility-N synthetic and no measured ` +
        `sigma1min was supplied — a volatility cannot be guessed`,
    };
  }

  const endMs = q.nowMs + q.horizonMinutes * 60_000;
  const muMinutes = calendar.muMinutes(q.nowMs, endMs);
  const gaps = calendar.gapsBetween(q.nowMs, endMs);

  let sigmaGap = 0;
  if (gaps > 0) {
    if (q.sigmaGap == null || !Number.isFinite(q.sigmaGap) || q.sigmaGap < 0) {
      // Dropping the gap term would UNDERSTATE risk over exactly the horizons
      // (weekend-crossing) where the gap is the risk. Refuse instead.
      return {
        available: false,
        reason: "GAP_SIGMA_UNAVAILABLE",
        detail:
          `the horizon crosses ${gaps} session boundar${gaps === 1 ? "y" : "ies"} ` +
          `and no measured sigmaGap was supplied — omitting the gap term would ` +
          `understate risk`,
      };
    }
    sigmaGap = q.sigmaGap;
  }

  const sigmaTau = sigmaOverHorizon(sigma.sigma1min, muMinutes, gaps, sigmaGap);
  const range = expectedRange(sigmaTau, q.price);
  const net = expectedNet(sigmaTau, q.price);
  const oneSigma = band(sigmaTau, q.price, 1);

  return {
    available: true,
    value: flavor === "range" ? range : flavor === "net" ? net : oneSigma,
    flavor,
    sigmaTau,
    expectedRange: range,
    expectedNet: net,
    bandOneSigma: oneSigma,
    bandTwoSigma: band(sigmaTau, q.price, 2),
    muMinutes,
    gaps,
    provenance: sigma.provenance,
  };
}
