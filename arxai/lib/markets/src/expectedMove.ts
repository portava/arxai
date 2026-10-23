// Expected-move model — how far an instrument is likely to travel over a
// horizon, and how far it is likely to END from here. Pure functions, no state,
// no I/O, no clock.
//
// THE TWO NUMBERS ARE NOT THE SAME NUMBER
// ---------------------------------------
// Conflating them is the standard way to get a stop wrong. For a driftless
// random walk over horizon τ with σ_τ the standard deviation of the log return:
//
//   expectedRange — E[max − min], how far it TRAVELS. ≈ 1.596 · σ_τ · price.
//                   This is what a stop must survive.
//   expectedNet   — E[|end − start|], how far it ENDS from here.
//                   = √(2/π) · σ_τ · price ≈ 0.798 · σ_τ · price.
//                   This is what a target can reasonably ask for.
//
// The range is ~2× the net displacement (exactly 2×, since E[max−min] for a
// driftless Brownian motion is 2·√(2/π)·σ_τ). A system that sizes a stop off the
// net figure will be stopped out by ordinary noise roughly as often as it is
// right — the price wanders through twice that distance on its way to nowhere.
//
// VARIANCE HAS TWO SOURCES, AND THEY SCALE DIFFERENTLY
// ----------------------------------------------------
//   diffusion — accumulates per minute of OPEN market: σ_min² · μ, where μ comes
//               from the trading calendar, NOT from wall-clock elapsed.
//   gaps      — each session boundary crossed contributes σ_gap² once, whatever
//               the wall-clock length of the closure. Price discovery that
//               happened while the book was shut arrives in a single print.
//
// Adding them in variance (never in σ) is the whole point: σ_total = √(σ_d² +
// σ_g²), which is strictly less than σ_d + σ_g. Summing standard deviations
// would overstate risk and quietly shrink every position.
//
// SCOPE: this module imports NOTHING — not the calendar, not the dispatch/gate
// path, nothing. It is arithmetic over numbers the caller supplies, so it can be
// unit-tested exactly and can never place, size, or authorise a trade. Wiring it
// into live sizing is a separate, later work order.

/**
 * E[max − min] / (σ_τ · price) for a driftless Brownian motion.
 * Exactly 2·√(2/π) = 1.5957691…
 */
export const RANGE_COEFF = 2 * Math.sqrt(2 / Math.PI);

/**
 * E[|end − start|] / (σ_τ · price) — the mean absolute value of a centred
 * normal. Exactly √(2/π) = 0.7978845…
 */
export const NET_COEFF = Math.sqrt(2 / Math.PI);

/** Minutes in a 365-day year — the annualisation basis for a 24/7 instrument. */
export const MINUTES_PER_YEAR = 365 * 1440;

/**
 * Per-minute σ of a Deriv "Volatility N Index", in log-return terms.
 *
 * These instruments are not measured, they are DEFINED: the generator targets an
 * annualised volatility of exactly N% on a continuous 365-day year. So σ_1min is
 * a closed form of N, needs no market data, no estimation window, and no
 * provider — which makes it the one place in ARX where a volatility number
 * carries no estimation error at all. It is exact by construction:
 *
 *     σ_1min = (N/100) / √(365 · 1440)
 *
 * Round-tripping it is an identity: σ_1min · √(365·1440) === N/100 exactly.
 * V75 → 0.0010345… (0.10345% per minute), annualising back to exactly 0.75.
 *
 * Everything else (FX, metals, indices) must be MEASURED, and belongs behind an
 * EWMA/realised-vol estimator that carries its own provenance. There is no
 * closed form for those and inventing one would be fabrication.
 */
export function synthSigma1min(n: number): number {
  return n / 100 / Math.sqrt(MINUTES_PER_YEAR);
}

/**
 * Parse the N out of a Deriv synthetic name, or `null` if the instrument is not
 * a "Volatility N" family member.
 *
 * Returns `null` rather than a default, because a wrong N silently produces a
 * plausible σ — the exact failure mode this codebase exists to stop. A caller
 * with no N must fall back to a measured estimate or refuse to size.
 */
export function synthVolIndex(instrument: string): number | null {
  const s = instrument.trim().toUpperCase();
  const named = /VOLATILITY\s+(\d+)/.exec(s);
  if (named) return Number(named[1]);
  const short = /^R_(\d+)$/.exec(s);
  if (short) return Number(short[1]);
  return null;
}

/**
 * Total variance of the log return over a horizon: diffusion in trading time
 * plus one jump term per session boundary crossed.
 *
 * `muMinutes` must come from the trading calendar, not from wall-clock elapsed —
 * that substitution is what makes a Friday-evening FX position look like a
 * 60-hour risk when the market is shut for 48 of them.
 */
export function varOverHorizon(
  sigmaMin: number,
  muMinutes: number,
  gaps: number,
  sigmaGap: number,
): number {
  return sigmaMin * sigmaMin * muMinutes + sigmaGap * sigmaGap * gaps;
}

/** σ over the horizon — the √ of {@link varOverHorizon}. */
export function sigmaOverHorizon(
  sigmaMin: number,
  muMinutes: number,
  gaps: number,
  sigmaGap: number,
): number {
  return Math.sqrt(varOverHorizon(sigmaMin, muMinutes, gaps, sigmaGap));
}

/** E[max − min] over the horizon, in price units. What a stop must survive. */
export function expectedRange(sigmaTau: number, price: number): number {
  return RANGE_COEFF * sigmaTau * price;
}

/** E[|end − start|] over the horizon, in price units. What a target may ask. */
export function expectedNet(sigmaTau: number, price: number): number {
  return NET_COEFF * sigmaTau * price;
}

/** A ±k·σ band half-width in price units. `k = 1` by default. */
export function band(sigmaTau: number, price: number, k = 1): number {
  return k * sigmaTau * price;
}

/** Annualise a per-minute σ on the 365-day continuous basis. */
export function annualiseFromMinute(sigmaMin: number): number {
  return sigmaMin * Math.sqrt(MINUTES_PER_YEAR);
}
