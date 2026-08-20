// ── expectancy/probabilityEngine: conservative P(win) + EV lower bound ──────
//
// R7 step 5 core (intel-engine.md §2 #18 — "Probability & Expectancy Engine"):
// the single largest gap between the vision and the runtime. This module is
// the PURE core only: it turns a recorded outcome sample into a conservative
// win-probability bound and a cost-inclusive conservative EV, and refuses to
// extrapolate from thin samples.
//
// Constraints this module enforces:
//   - Pure and deterministic. No IO, no clock, no imports outside this package.
//   - NEVER EXTRAPOLATE: fewer than MIN_DECISION_SAMPLE (30) recorded outcomes
//     is INSUFFICIENT_SAMPLE, full stop — no smoothing, no prior, no borrowed
//     confidence. The numbers are still reported (they are honest arithmetic
//     over what exists) but the verdict forbids treating them as decision-grade.
//   - CONSERVATIVE BY CONSTRUCTION: pWin.lower95 is the lower endpoint of the
//     Wilson score interval (Wilson, E. B., 1927, "Probable inference, the law
//     of succession, and statistical inference", J. Amer. Statist. Assoc.
//     22(158): 209–212) at two-sided 95% (z = Φ⁻¹(0.975) ≈ 1.95996) —
//     equivalently a one-sided 97.5% lower confidence bound. Wilson (not the
//     normal/Wald approximation) because it stays inside [0,1], never returns
//     a bound above the sample proportion, and behaves sanely at small n and
//     extreme proportions — 0 wins yields a bound of exactly 0.
//   - EV uses the DECLARED trade geometry: win pays targetR, loss costs 1R.
//     Each sample's realized rMultiple is accepted (it is part of the durable
//     outcome record and future calibration will consume it) but deliberately
//     NOT averaged into this EV — realized-R means on small samples flatter,
//     and the conservative question is "does the declared geometry survive the
//     probability lower bound after costs".
//   - Costs are REQUIRED (assertCostInputs) — see costModel.ts.
//   - conservativeEv <= 0 ⇒ WAIT. WAIT is a success state, not a failure state.
//
// NOT WIRED to any gate in this slice: deterministic risk outranks this engine
// forever, and nothing here touches dispatch gates or scanner truth caps.

import { assertCostInputs, type CostInputs } from "./costModel";

/** One recorded outcome. `won` is the target-before-stop truth; `rMultiple` is
 *  the realized R multiple when known (null when the trade record cannot state
 *  it honestly — never fabricated). */
export interface OutcomeSample {
  won: boolean;
  rMultiple: number | null;
}

export interface EstimateOutcomeInput {
  samples: OutcomeSample[];
  /** Declared reward of a win, in R units (entry-to-target / entry-to-stop).
   *  Must be finite > 0. */
  targetR: number;
  /** REQUIRED explicit costs — see costModel.ts. */
  costs: CostInputs;
}

export type OutcomeVerdict = "POSITIVE" | "WAIT" | "INSUFFICIENT_SAMPLE";

export interface OutcomeEstimate {
  pWin: {
    /** Sample proportion wins/n (0 when n = 0 — no evidence claims nothing). */
    point: number;
    /** Wilson score interval lower endpoint at two-sided 95% (see header). */
    lower95: number;
  };
  /** lower95 · targetR − (1 − lower95) · 1 − costs.totalR.
   *  Reported for every input (honest arithmetic), but decision-grade ONLY
   *  when the verdict is POSITIVE. */
  conservativeEv: number;
  sampleSize: number;
  verdict: OutcomeVerdict;
}

/** Minimum recorded outcomes before any verdict other than
 *  INSUFFICIENT_SAMPLE is possible. Below this, never extrapolate. */
export const MIN_DECISION_SAMPLE = 30;

/** z = Φ⁻¹(0.975): two-sided 95% normal quantile used by the Wilson interval. */
export const WILSON_Z_95 = 1.959963984540054;

export const EXPECTANCY_INPUT_INVALID = "EXPECTANCY_INPUT_INVALID" as const;

/** Typed refusal for malformed estimate inputs (bad samples / targetR). */
export class ExpectancyInputError extends Error {
  readonly code = EXPECTANCY_INPUT_INVALID;
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`${EXPECTANCY_INPUT_INVALID}: ${field} — ${detail}`);
    this.name = "ExpectancyInputError";
    this.field = field;
  }
}

/**
 * Lower endpoint of the Wilson score interval for a binomial proportion at
 * two-sided 95% confidence (Wilson 1927; see module header for the citation
 * and why Wilson over Wald).
 *
 *   lower = ( p̂ + z²/2n − z·√( (p̂(1−p̂) + z²/4n) / n ) ) / ( 1 + z²/n )
 *
 * Returns 0 for n = 0 (no evidence supports no bound above zero).
 */
export function wilsonLower95(wins: number, n: number): number {
  if (!Number.isInteger(wins) || wins < 0) {
    throw new ExpectancyInputError("wins", `must be a non-negative integer (got ${wins})`);
  }
  if (!Number.isInteger(n) || n < 0) {
    throw new ExpectancyInputError("n", `must be a non-negative integer (got ${n})`);
  }
  if (wins > n) {
    throw new ExpectancyInputError("wins", `cannot exceed n (got ${wins} > ${n})`);
  }
  if (n === 0) return 0;
  const z = WILSON_Z_95;
  const z2 = z * z;
  const pHat = wins / n;
  const numerator = pHat + z2 / (2 * n) - z * Math.sqrt((pHat * (1 - pHat) + z2 / (4 * n)) / n);
  const lower = numerator / (1 + z2 / n);
  // Guard floating error at the edges; the true bound is always within [0, p̂].
  return Math.min(Math.max(lower, 0), pHat);
}

function validateSamples(samples: unknown): OutcomeSample[] {
  if (!Array.isArray(samples)) {
    throw new ExpectancyInputError("samples", "must be an array of recorded outcomes");
  }
  samples.forEach((s, i) => {
    if (s === null || s === undefined || typeof s !== "object") {
      throw new ExpectancyInputError(`samples[${i}]`, "must be an outcome object");
    }
    const rec = s as Record<string, unknown>;
    if (typeof rec.won !== "boolean") {
      throw new ExpectancyInputError(`samples[${i}].won`, `must be a boolean (got ${String(rec.won)})`);
    }
    if (rec.rMultiple !== null && (typeof rec.rMultiple !== "number" || !Number.isFinite(rec.rMultiple))) {
      throw new ExpectancyInputError(
        `samples[${i}].rMultiple`,
        `must be a finite number or null (got ${String(rec.rMultiple)})`,
      );
    }
  });
  return samples as OutcomeSample[];
}

/**
 * Conservative outcome estimate over a recorded sample. See the module header
 * for every rule this function enforces (Wilson lower bound, declared-geometry
 * EV, required costs, the 30-sample floor, EV<=0 ⇒ WAIT).
 */
export function estimateOutcome(input: EstimateOutcomeInput): OutcomeEstimate {
  if (input === null || input === undefined || typeof input !== "object") {
    throw new ExpectancyInputError("input", "estimate input object is REQUIRED");
  }
  const samples = validateSamples(input.samples);
  if (typeof input.targetR !== "number" || !Number.isFinite(input.targetR) || input.targetR <= 0) {
    throw new ExpectancyInputError("targetR", `must be a finite number > 0 (got ${String(input.targetR)})`);
  }
  // Costs are REQUIRED — a missing/invalid cost object is a typed refusal,
  // never a silent zero (costModel.ts owns the rule).
  assertCostInputs(input.costs);

  const sampleSize = samples.length;
  const wins = samples.reduce((acc, s) => acc + (s.won ? 1 : 0), 0);
  const point = sampleSize > 0 ? wins / sampleSize : 0;
  const lower95 = wilsonLower95(wins, sampleSize);

  // Declared geometry, probability lower bound, explicit costs — in R units.
  const conservativeEv = lower95 * input.targetR - (1 - lower95) * 1 - input.costs.totalR;

  // Verdict precedence: the sample floor outranks a positive EV — a thin
  // sample with a great-looking bound is still not evidence (never extrapolate).
  let verdict: OutcomeVerdict;
  if (sampleSize < MIN_DECISION_SAMPLE) {
    verdict = "INSUFFICIENT_SAMPLE";
  } else if (conservativeEv <= 0) {
    verdict = "WAIT";
  } else {
    verdict = "POSITIVE";
  }

  return {
    pWin: { point, lower95 },
    conservativeEv,
    sampleSize,
    verdict,
  };
}
