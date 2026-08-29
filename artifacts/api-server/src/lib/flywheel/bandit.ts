// ── B3 — RegimeBanditAllocator: discounted Thompson sampling, SHADOW-ONLY ───
//
// Per pass, the allocator draws one Thompson sample of each cohort's mean
// reward from its (discounted) NIG posterior and turns the draws into a
// SHADOW allocation-weight journal record. The record is a learning intention,
// not an instruction:
//
//   * mode "SHADOW", authority "NONE" — there is NO apply path from this
//     module (or anywhere in the flywheel) to sizing, gates, floors, stops, or
//     dispatch. kellyCapGovernor independently holds real size at EXACTLY 0
//     without a measured edge_OOS.
//   * PROMOTED-ELIGIBLE ONLY (gate #20 STRATEGY_NOT_LIVE_PROMOTED semantics):
//     an arm whose strategy the owner has not live-promoted journals weight 0
//     — its Thompson draw is recorded as hypotheticalWeight so learning is
//     visible, but the shadow weight itself is zero until the owner-gated
//     promotion machinery says otherwise.
//   * CLAMPED (gate #21 CAPITAL_TIER_EXCEEDED semantics): per-arm shadow
//     weights are capped at FLYWHEEL_MAX_ARM_WEIGHT (the quarter-Kelly
//     humility cap applied to allocation) and the total is capped at
//     FLYWHEEL_MAX_TOTAL_WEIGHT — a tier-style ceiling, never a floor.
//   * INSUFFICIENT_SAMPLE or decayed (B4/B5) cohorts journal 0 — an
//     unmeasured or decayed edge allocates nothing.
//   * Negative draws journal 0 — allocation cannot go short a strategy.
//
// FLYWHEEL INVARIANT: pure — no IO, no clock, randomness only via injected
// rng; imports only the local posterior module.

import {
  type NigPosterior,
  type Rng,
  discountPosterior,
  posteriorStatus,
  samplePosteriorMean,
} from "./posterior.js";

/** Per-arm cap — quarter-Kelly humility applied to allocation weights. */
export const FLYWHEEL_MAX_ARM_WEIGHT = 0.25;
/** Total shadow allocation cap (capital-tier-style ceiling). */
export const FLYWHEEL_MAX_TOTAL_WEIGHT = 1.0;
/** Default per-pass exponential forgetting factor. */
export const FLYWHEEL_DISCOUNT_GAMMA = 0.98;

export interface BanditArm {
  strategyId: string;
  cohortKey: string;
  posterior: NigPosterior | null;
  /** Owner-promoted for live (gate #20 semantics). False journals weight 0. */
  promotedEligible: boolean;
  /** B4/B5 decay verdict for this cohort. True forces shadow weight 0. */
  decayed: boolean;
  /** Discount intervals since the posterior last absorbed evidence. */
  stalenessSteps: number;
}

export interface ArmWeightRecord {
  strategyId: string;
  cohortKey: string;
  /** The journaled SHADOW weight (0 unless promoted-eligible AND measured). */
  weight: number;
  /** What Thompson sampling would allocate were the arm promoted — a learning
   *  record only; nothing reads it as an instruction. */
  hypotheticalWeight: number;
  sampledMean: number | null;
  reasons: string[];
}

export interface ShadowAllocationRecord {
  mode: "SHADOW";
  authority: "NONE";
  /** There is deliberately no `apply`/`execute`/`dispatch` field on this type. */
  weights: ArmWeightRecord[];
  clamp: {
    maxArmWeight: number;
    maxTotalWeight: number;
    gamma: number;
    gateSemantics: string[];
  };
  posteriorsUsed: number;
}

interface Draw {
  arm: BanditArm;
  sampledMean: number | null;
  measurable: boolean;
  reasons: string[];
}

/**
 * PURE — one allocation pass over the arms. Deterministic given the rng.
 */
export function computeShadowAllocation(
  arms: readonly BanditArm[],
  rng: Rng,
  opts: { gamma?: number } = {},
): ShadowAllocationRecord {
  const gamma = opts.gamma ?? FLYWHEEL_DISCOUNT_GAMMA;

  // 1. Draw for every arm with a measurable posterior (learning is journaled
  //    for all arms; authority-shaped zeros are applied afterwards).
  const draws: Draw[] = arms.map((arm) => {
    const reasons: string[] = [];
    if (arm.posterior === null) {
      reasons.push("NO_POSTERIOR: cohort has no posterior yet — no measured edge, weight 0");
      return { arm, sampledMean: null, measurable: false, reasons };
    }
    if (posteriorStatus(arm.posterior.n) !== "OK") {
      reasons.push(
        `INSUFFICIENT_SAMPLE: ${arm.posterior.n} reconciled rewards below the floor — an unmeasured edge allocates nothing`,
      );
      return { arm, sampledMean: null, measurable: false, reasons };
    }
    const discounted = discountPosterior(arm.posterior, gamma, arm.stalenessSteps);
    const sampled = samplePosteriorMean(discounted, rng);
    return { arm, sampledMean: sampled, measurable: true, reasons };
  });

  // 2. Thompson weights over POSITIVE draws (softmax-free: proportional to the
  //    positive sampled mean — a draw at or below zero allocates nothing).
  const positive = draws.filter((d) => d.measurable && (d.sampledMean ?? 0) > 0);
  const sumPositive = positive.reduce((s, d) => s + (d.sampledMean ?? 0), 0);

  const weights: ArmWeightRecord[] = draws.map((d) => {
    const reasons = [...d.reasons];
    let raw = 0;
    if (d.measurable) {
      const m = d.sampledMean ?? 0;
      if (m > 0 && sumPositive > 0) {
        raw = m / sumPositive;
      } else {
        reasons.push("NONPOSITIVE_DRAW: sampled mean ≤ 0 — allocation cannot go short a strategy; weight 0");
      }
    }
    // Per-arm clamp (quarter-Kelly humility on allocation).
    let hypothetical = Math.min(Math.max(raw, 0), FLYWHEEL_MAX_ARM_WEIGHT);
    if (raw > FLYWHEEL_MAX_ARM_WEIGHT) {
      reasons.push(`ARM_CAP: raw ${raw.toFixed(4)} clamped to ${FLYWHEEL_MAX_ARM_WEIGHT}`);
    }

    let weight = hypothetical;
    if (d.arm.decayed) {
      weight = 0;
      hypothetical = 0;
      reasons.push("EDGE_DECAYED: change-point decay verdict — shadow weight forced to 0 (B4/B5)");
    }
    if (!d.arm.promotedEligible) {
      weight = 0;
      reasons.push(
        "STRATEGY_NOT_LIVE_PROMOTED: gate #20 semantics — weight journals 0 until the owner-gated promotion machinery promotes this strategy",
      );
    }
    return {
      strategyId: d.arm.strategyId,
      cohortKey: d.arm.cohortKey,
      weight,
      hypotheticalWeight: hypothetical,
      sampledMean: d.sampledMean,
      reasons,
    };
  });

  // 3. Total ceiling (gate #21-style tier cap): scale DOWN only, never up.
  const total = weights.reduce((s, w) => s + w.weight, 0);
  if (total > FLYWHEEL_MAX_TOTAL_WEIGHT) {
    const scale = FLYWHEEL_MAX_TOTAL_WEIGHT / total;
    for (const w of weights) {
      if (w.weight > 0) {
        w.weight *= scale;
        w.reasons.push(`TOTAL_CAP: scaled by ${scale.toFixed(4)} to honor the total ceiling`);
      }
    }
  }

  return {
    mode: "SHADOW",
    authority: "NONE",
    weights,
    clamp: {
      maxArmWeight: FLYWHEEL_MAX_ARM_WEIGHT,
      maxTotalWeight: FLYWHEEL_MAX_TOTAL_WEIGHT,
      gamma,
      gateSemantics: ["STRATEGY_NOT_LIVE_PROMOTED(#20)", "CAPITAL_TIER_EXCEEDED(#21)"],
    },
    posteriorsUsed: draws.filter((d) => d.measurable).length,
  };
}
