// A0 — ObjectiveKernel. What the system is actually trying to maximise.
//
// The objective is the EXPECTED LOG of terminal wealth, not expected wealth.
// This is not a stylistic preference; it is the only objective that survives
// compounding. Maximising expected wealth tells you to bet everything on any
// positive-edge wager, which maximises the mean of a distribution whose median
// is zero: almost every path goes bust while the average is carried by a
// vanishing set of astronomically rich ones. Log wealth is additive across
// sequential bets, so maximising its expectation maximises the growth rate that
// a single path — the only one this account will actually live through —
// actually experiences.
//
// The consequence that matters operationally: RUIN IS INFINITELY BAD. A fraction
// that can take wealth to zero scores −∞ here, not "a very poor score". No
// amount of upside anywhere else in the distribution can average it back up.
// That is why `expectedLogWealth` returns `-Infinity` on a bankrupting outcome
// rather than a large negative number — a finite penalty would let an optimiser
// trade a small ruin probability for enough upside, which is exactly the trade
// that ends accounts.
//
// SCOPE: pure arithmetic. Imports nothing — not the dispatch/gate path, not a
// clock, not a feed. Every input is supplied by the caller. This module cannot
// place, size, or authorise a trade.

/**
 * The growth-optimal fraction f* = μ/σ² for a continuous-time / small-edge
 * approximation.
 *
 * Returns 0 for a non-positive variance rather than dividing by it: an
 * instrument with no measured variance has no basis for a size, and `Infinity`
 * or `NaN` leaking into a size calculation is precisely the failure this
 * codebase exists to prevent. Fail to zero.
 */
export function kellyStar(mu: number, sigmaSq: number): number {
  return sigmaSq > 0 ? mu / sigmaSq : 0;
}

/**
 * The log-growth rate of betting fraction `f` against edge `mu` and variance
 * `sigmaSq`: g(f) = μf − ½σ²f².
 *
 * A downward parabola whose maximum sits exactly at f* = μ/σ². Note that g is
 * NEGATIVE for f > 2f* — betting more than twice the optimal fraction has a
 * worse growth rate than not betting at all, even with a genuine positive edge.
 * Over-sizing does not merely reduce the return; past 2f* it destroys wealth
 * that a flat account would have kept.
 */
export function logGrowthRate(f: number, mu: number, sigmaSq: number): number {
  return mu * f - 0.5 * sigmaSq * f * f;
}

/** One outcome of a discrete wager: return `r` with probability `p`. */
export interface Outcome {
  /** Simple return on the staked fraction, e.g. −1 loses the whole stake. */
  r: number;
  /** Probability of this outcome. */
  p: number;
}

/**
 * E[log(1 + f·r)] over a discrete outcome distribution — the exact objective,
 * with no small-edge approximation.
 *
 * Returns `-Infinity` the moment any reachable outcome drives wealth to zero or
 * below (1 + f·r <= 0). This is the correct answer, not a guard clause: an
 * account that can hit zero has no growth rate, and every subsequent bet is
 * moot. A finite penalty would let a search trade ruin probability against
 * upside; −∞ makes that trade unrepresentable.
 */
export function expectedLogWealth(f: number, dist: readonly Outcome[]): number {
  let s = 0;
  for (const { r, p } of dist) {
    const w = 1 + f * r;
    if (w <= 0) return -Infinity;
    s += p * Math.log(w);
  }
  return s;
}
