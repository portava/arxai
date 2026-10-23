// 8b — FDRController: Benjamini–Hochberg over the WHOLE trial family.
//
// WHY A PER-TEST p-VALUE IS MEANINGLESS HERE
// ------------------------------------------
// "p < 0.05" means: if this were the only test I ran, I would be wrong 5% of the
// time. Run 200 tests on nothing and about 10 of them clear that bar — every one
// of them a false discovery, and every one of them reportable as "significant at
// the 5% level" without saying anything untrue.
//
// Benjamini–Hochberg changes the guarantee from a per-test error rate to a
// FAMILY-WIDE one: of everything you end up calling a discovery, at most q is
// expected to be false. That is the number a promotion decision actually needs,
// because a promotion decision is made about the survivors, not about a test.
//
// THE DENOMINATOR IS THE WHOLE GAME
// ---------------------------------
// BH's guarantee is only as honest as `m`, the family size. Understating m —
// counting the parameter sweep but not the twelve instruments you swept it over,
// counting the strategies you kept but not the ones you discarded — inflates
// every threshold and quietly restores the multiple-testing problem the
// procedure exists to solve. So `m` is an explicit, required argument here, and
// `controlFdr` REFUSES to run when m is smaller than the number of p-values
// supplied: that combination is arithmetically impossible and is the signature
// of a family whose size was computed after some trials were dropped.
//
// Pure arithmetic. No I/O, no clock, no randomness.

export interface FdrTest {
  /** Stable identifier of the trial this p-value came from. */
  key: string;
  /** The trial's p-value under the null. */
  p: number;
}

export interface FdrDecision extends FdrTest {
  /** Rank of this p-value among the sorted family, 1-based. */
  rank: number;
  /** The BH critical value for this rank: (rank/m)·q. */
  critical: number;
  /** True ⇒ certified as a discovery at family FDR q. */
  rejected: boolean;
}

export interface FdrResult {
  /** q — the family-wide false-discovery rate being controlled. */
  q: number;
  /** m — the FULL family size, niche-selection trials included. */
  familySize: number;
  /** How many hypotheses were certified. */
  rejections: number;
  /** The largest p-value that cleared its critical value, or null. */
  threshold: number | null;
  decisions: FdrDecision[];
  detail: string;
}

/**
 * Benjamini–Hochberg step-up over a family of p-values.
 *
 * Sort ascending, find the LARGEST k with p_(k) ≤ (k/m)·q, and reject everything
 * up to and including rank k. Rejecting the whole prefix — not just the tests
 * that individually clear their own critical value — is the step-up rule and is
 * what makes the FDR guarantee hold; rejecting only individually-clearing tests
 * would be conservative in a way that silently changes the guarantee.
 *
 * `familySize` MUST be the full trial count including niche-selection trials.
 */
export function controlFdr(tests: readonly FdrTest[], q: number, familySize: number): FdrResult {
  if (!(q > 0 && q < 1)) throw new Error(`controlFdr: q must be in (0,1), got ${q}`);
  if (!Number.isInteger(familySize) || familySize < 1) {
    throw new Error(`controlFdr: familySize must be a positive integer, got ${familySize}`);
  }
  if (familySize < tests.length) {
    // Arithmetically impossible, and the signature of a denominator computed
    // after some trials were dropped from the record.
    throw new Error(
      `controlFdr: familySize ${familySize} is smaller than the ${tests.length} p-values supplied — ` +
        "the family size must include EVERY trial, niche-selection trials included",
    );
  }

  // A non-finite p-value is treated as 1 (no evidence) rather than dropped:
  // dropping it would shrink the effective family and inflate every threshold.
  const clean = tests.map((t) => ({
    ...t,
    p: Number.isFinite(t.p) ? Math.min(1, Math.max(0, t.p)) : 1,
  }));

  const sorted = [...clean].sort((a, b) => a.p - b.p);

  let maxK = 0;
  for (let k = 1; k <= sorted.length; k++) {
    if (sorted[k - 1]!.p <= (k / familySize) * q) maxK = k;
  }

  const decisions: FdrDecision[] = sorted.map((t, i) => ({
    key: t.key,
    p: t.p,
    rank: i + 1,
    critical: ((i + 1) / familySize) * q,
    rejected: i + 1 <= maxK,
  }));

  const threshold = maxK > 0 ? sorted[maxK - 1]!.p : null;

  return {
    q,
    familySize,
    rejections: maxK,
    threshold,
    decisions,
    detail:
      `BH at q=${q} over m=${familySize} (${tests.length} p-values supplied): ` +
      `${maxK} rejection(s)` +
      (threshold === null ? ", no threshold cleared" : `, threshold p=${threshold.toExponential(3)}`),
  };
}

/**
 * One-sided p-value for an observed Sharpe under the null of no edge.
 *
 * Under the null, the Sharpe estimate is approximately normal with standard
 * error 1/√T, so p = 1 − Φ(SR·√T). Approximate, and stated as such: it ignores
 * the skew/kurtosis correction that the Deflated Sharpe applies. BH runs on
 * these p-values to control the family rate; DSR is the separate, stricter veto
 * that accounts for the return distribution's shape. Neither replaces the other.
 */
export function sharpePValue(observedSharpe: number, trackLength: number): number {
  if (!Number.isFinite(observedSharpe) || !(trackLength > 1)) return 1;
  const z = observedSharpe * Math.sqrt(trackLength);
  return 1 - normalCdfLocal(z);
}

/** Local Φ (A&S 26.2.17, |ε| < 7.5e-8) — kept local so this package imports nothing. */
function normalCdfLocal(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}
