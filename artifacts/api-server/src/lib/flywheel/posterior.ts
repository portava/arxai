// ── B2 — Cohort posteriors: Normal-Inverse-Gamma over B1 rewards (pure) ─────
//
// Per strategy × regime × instrument cohort, the flywheel keeps a conjugate
// Normal-Inverse-Gamma posterior over the net-log-return distribution:
//
//   (mean, variance) ~ NIG(mu, kappa, alpha, beta)
//
// HONEST PRIORS: mu0 = 0 — no cohort is presumed to have ANY directional edge
// until reconciled evidence says so (the platform's standing "synthetics have
// no directional edge" ruling, applied to every cohort). kappa0 = 1 (the prior
// mean is worth one pseudo-observation, easily displaced by real evidence),
// alpha0 = 2 (the weakest shape with a finite prior variance), beta0 sized for
// a per-trade log-return spread near 1% — conservative for retail cohorts and
// quickly dominated by data either way.
//
// INSUFFICIENT_SAMPLE: below FLYWHEEL_MIN_COHORT_SAMPLE reconciled rewards the
// posterior's status says so, and downstream (the bandit) treats the cohort as
// having NO measured edge — mirroring kellyCapGovernor's no-edge rule: an
// unmeasured edge is an unknown one, and the honest allocation for an unknown
// edge is nothing.
//
// FLYWHEEL INVARIANT: pure math — no IO, no clock, randomness only through an
// INJECTED rng (deterministic in tests), no import from any gate/floor/stop/
// dispatch path.

export interface NigPosterior {
  mu: number;
  kappa: number;
  alpha: number;
  beta: number;
  /** Reconciled rewards folded in. */
  n: number;
}

export type PosteriorStatus = "OK" | "INSUFFICIENT_SAMPLE";

/** Minimum RECONCILED rewards before a cohort posterior may claim anything. */
export const FLYWHEEL_MIN_COHORT_SAMPLE = 10;

export const FLYWHEEL_NIG_PRIOR: Readonly<NigPosterior> = Object.freeze({
  mu: 0,       // no presumed edge
  kappa: 1,
  alpha: 2,
  beta: 0.0001, // prior scale ≈ (1% per-trade log-return)² — conservative
  n: 0,
});

export function posteriorStatus(n: number): PosteriorStatus {
  return Number.isInteger(n) && n >= FLYWHEEL_MIN_COHORT_SAMPLE ? "OK" : "INSUFFICIENT_SAMPLE";
}

/**
 * PURE — exact conjugate NIG batch update from the prior. Non-finite rewards
 * are refused (dropped with no effect on the count) rather than absorbed.
 */
export function nigUpdate(prior: NigPosterior, rewards: readonly number[]): NigPosterior {
  const xs = rewards.filter((r) => Number.isFinite(r));
  const n = xs.length;
  if (n === 0) return { ...prior };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const ss = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  const kappaN = prior.kappa + n;
  const muN = (prior.kappa * prior.mu + n * mean) / kappaN;
  const alphaN = prior.alpha + n / 2;
  const betaN =
    prior.beta +
    ss / 2 +
    (prior.kappa * n * (mean - prior.mu) * (mean - prior.mu)) / (2 * kappaN);
  return { mu: muN, kappa: kappaN, alpha: alphaN, beta: betaN, n: prior.n + n };
}

/**
 * PURE — exponential forgetting toward the prior (the bandit's discounting,
 * B3). gamma ∈ (0,1]; steps = how many discount intervals have elapsed. The
 * EVIDENCE mass (kappa−kappa0, alpha−alpha0, beta−beta0, n) decays by
 * gamma^steps while the prior floor is kept intact, so a cohort that stops
 * producing evidence drifts honestly back toward "no measured edge" — it can
 * only LOSE claimed knowledge with time, never gain it.
 */
export function discountPosterior(
  post: NigPosterior,
  gamma: number,
  steps: number,
  prior: NigPosterior = FLYWHEEL_NIG_PRIOR,
): NigPosterior {
  const g = Number.isFinite(gamma) && gamma > 0 && gamma <= 1 ? gamma : 1;
  const s = Number.isFinite(steps) && steps > 0 ? steps : 0;
  const f = Math.pow(g, s);
  const evidenceMass = post.kappa - prior.kappa;
  const kappa = prior.kappa + evidenceMass * f;
  // Discounted mean pull: post.mu already mixes the prior with the evidence
  // mean, so first RECOVER the evidence mean the posterior implies
  // (post.mu = (κ0·μ0 + M·x̄)/(κ0+M) ⇒ x̄), then re-mix it at the reduced
  // mass M·f. At f=1 this is exactly the identity; as f→0 it is exactly μ0.
  const evidenceMean =
    evidenceMass > 0 ? (post.mu * post.kappa - prior.kappa * prior.mu) / evidenceMass : prior.mu;
  const mu = kappa > 0 ? (prior.kappa * prior.mu + evidenceMass * f * evidenceMean) / kappa : prior.mu;
  return {
    mu,
    kappa,
    alpha: prior.alpha + (post.alpha - prior.alpha) * f,
    beta: prior.beta + (post.beta - prior.beta) * f,
    n: post.n, // the raw observation COUNT is history, not belief — kept honest
  };
}

// ── Sampling (Thompson's draw) — all randomness through the injected rng ────

export type Rng = () => number;

/** Deterministic 32-bit PRNG (mulberry32) — tests and journal-only sampling. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleNormal01(rng: Rng): number {
  // Box–Muller; clamp u away from 0 so log stays finite.
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Marsaglia–Tsang Gamma(shape, rate=1) sampler with the shape<1 boost. */
function sampleGamma(shape: number, rng: Rng): number {
  if (!(shape > 0)) return 0;
  if (shape < 1) {
    const u = Math.max(rng(), 1e-12);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 1000; i++) {
    const x = sampleNormal01(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
  return d; // pathological rng — deterministic conservative fallback
}

/**
 * PURE — one Thompson draw of the cohort's MEAN reward from the NIG posterior:
 * precision λ ~ Gamma(alpha, rate beta), mean ~ Normal(mu, 1/(kappa·λ)).
 */
export function samplePosteriorMean(post: NigPosterior, rng: Rng): number {
  const lambda = sampleGamma(post.alpha, rng) / Math.max(post.beta, 1e-300);
  const sd = 1 / Math.sqrt(Math.max(post.kappa * lambda, 1e-300));
  return post.mu + sd * sampleNormal01(rng);
}

/** Posterior mean point estimate (no sampling). */
export function posteriorMean(post: NigPosterior): number {
  return post.mu;
}

export function cohortKeyOf(strategyId: string, regimeLabel: string, instrument: string): string {
  return `${strategyId}|${regimeLabel}|${instrument}`;
}
