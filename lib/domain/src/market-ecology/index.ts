// ── Market Ecology Engine (capability #11) — pure ───────────────────────────
//
// Models the CURRENT market as COMPETING BEHAVIORAL HYPOTHESES about who is
// participating and why:
//
//   MOMENTUM_PARTICIPATION  — directional buyers/sellers pressing a move
//                             (persistent signed returns, positive lag-1
//                             autocorrelation, directional closes)
//   TWO_SIDED_LIQUIDITY     — balanced passive flow absorbing both sides
//                             (small bodies, balanced wicks, bounded range)
//   FORCED_MOVEMENT         — stops/liquidations being run (range expansion
//                             with one-sided extreme closes and long sweeps)
//   MEAN_REVERSION_PRESSURE — fading flow pulling price back (negative lag-1
//                             autocorrelation, closes rotating inside range)
//
// Each hypothesis produces a deterministic evidence score in [0,1] from real
// candles. Probabilities are then assigned by NORMALIZING scores across the
// hypotheses — but ONLY across hypotheses whose scorer has been VALIDATED on
// labeled historical fixtures (see validateEcologyHypothesis). VALIDATION
// CONTRACT (the honesty core of this capability):
//
//   * a hypothesis with no / failing validation reports status UNVALIDATED,
//     probability null, and CONTRIBUTES NOTHING to the normalization — it is
//     never a silent guess;
//   * too few candles → INSUFFICIENT_DATA for the whole read;
//   * zero validated hypotheses → NO_VALIDATED_HYPOTHESES with every
//     probability null. An empty answer is a correct answer.

export const ECOLOGY_HYPOTHESES = [
  "MOMENTUM_PARTICIPATION",
  "TWO_SIDED_LIQUIDITY",
  "FORCED_MOVEMENT",
  "MEAN_REVERSION_PRESSURE",
] as const;
export type EcologyHypothesisId = (typeof ECOLOGY_HYPOTHESES)[number];

export interface EcologyCandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

export const MIN_ECOLOGY_CANDLES = 30;

// ── Feature extraction (shared, deterministic) ──────────────────────────────

export interface EcologyFeatures {
  /** Lag-1 autocorrelation of close-to-close returns, [-1, 1]. */
  returnAutocorr1: number;
  /** Mean |body| / mean range — how directional individual bars are, [0,1]. */
  bodyDominance: number;
  /** |sum of signed returns| / sum of |returns| — net drift efficiency, [0,1]. */
  driftEfficiency: number;
  /** Recent-range / older-range expansion ratio (5 vs 15 bars), ≥ 0. */
  rangeExpansion: number;
  /** Mean wick imbalance |upper−lower| / range, [0,1]. */
  wickImbalance: number;
  /** Fraction of bars closing in the outer 20% of their own range, [0,1]. */
  extremeCloseShare: number;
  /** Fraction of adjacent return sign flips, [0,1] (1 = perfect alternation). */
  signFlipRate: number;
  candlesUsed: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function extractEcologyFeatures(candles: readonly EcologyCandle[]): EcologyFeatures | null {
  if (!Array.isArray(candles) || candles.length < MIN_ECOLOGY_CANDLES) return null;
  const usable = candles.filter(
    (c) =>
      Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close) &&
      c.high >= c.low,
  );
  if (usable.length < MIN_ECOLOGY_CANDLES) return null;

  const closes = usable.map((c) => c.close);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev !== 0) returns.push((closes[i]! - prev) / prev);
  }
  if (returns.length < 10) return null;

  // Lag-1 autocorrelation.
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < returns.length; i++) {
    const d = returns[i]! - mean;
    den += d * d;
    if (i > 0) num += d * (returns[i - 1]! - mean);
  }
  const returnAutocorr1 = den > 0 ? Math.max(-1, Math.min(1, num / den)) : 0;

  // Body dominance + wick imbalance + extreme closes.
  let bodySum = 0;
  let rangeSum = 0;
  let wickImbSum = 0;
  let wickBars = 0;
  let extremeCloses = 0;
  for (const c of usable) {
    const range = c.high - c.low;
    bodySum += Math.abs(c.close - c.open);
    rangeSum += range;
    if (range > 0) {
      const upper = c.high - Math.max(c.open, c.close);
      const lower = Math.min(c.open, c.close) - c.low;
      wickImbSum += Math.abs(upper - lower) / range;
      wickBars += 1;
      const pos = (c.close - c.low) / range;
      if (pos >= 0.8 || pos <= 0.2) extremeCloses += 1;
    }
  }
  const bodyDominance = rangeSum > 0 ? clamp01(bodySum / rangeSum) : 0;
  const wickImbalance = wickBars > 0 ? clamp01(wickImbSum / wickBars) : 0;
  const extremeCloseShare = usable.length > 0 ? extremeCloses / usable.length : 0;

  // Drift efficiency.
  const absSum = returns.reduce((a, b) => a + Math.abs(b), 0);
  const netSum = Math.abs(returns.reduce((a, b) => a + b, 0));
  const driftEfficiency = absSum > 0 ? clamp01(netSum / absSum) : 0;

  // Range expansion: mean bar range last 5 vs prior 15.
  const ranges = usable.map((c) => c.high - c.low);
  const recent = ranges.slice(-5);
  const older = ranges.slice(-20, -5);
  const meanOf = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const olderMean = meanOf(older);
  const rangeExpansion = olderMean > 0 ? meanOf(recent) / olderMean : 1;

  // Sign-flip rate.
  let flips = 0;
  let pairs = 0;
  for (let i = 1; i < returns.length; i++) {
    const a = returns[i - 1]!;
    const b = returns[i]!;
    if (a !== 0 && b !== 0) {
      pairs += 1;
      if ((a > 0) !== (b > 0)) flips += 1;
    }
  }
  const signFlipRate = pairs > 0 ? flips / pairs : 0;

  return {
    returnAutocorr1,
    bodyDominance,
    driftEfficiency,
    rangeExpansion,
    wickImbalance,
    extremeCloseShare,
    signFlipRate,
    candlesUsed: usable.length,
  };
}

// ── Per-hypothesis evidence scoring ─────────────────────────────────────────

export function scoreEcologyHypothesis(
  id: EcologyHypothesisId,
  f: EcologyFeatures,
): number {
  switch (id) {
    case "MOMENTUM_PARTICIPATION":
      // Persistent one-directional pressure: positive autocorrelation, high
      // drift efficiency, directional bodies, few sign flips.
      return clamp01(
        0.3 * clamp01((f.returnAutocorr1 + 0.2) / 0.7) +
          0.3 * f.driftEfficiency +
          0.2 * f.bodyDominance +
          0.2 * clamp01(1 - f.signFlipRate),
      );
    case "TWO_SIDED_LIQUIDITY":
      // Absorption: no drift, small bodies, no expansion, balanced wicks.
      return clamp01(
        0.3 * clamp01(1 - f.driftEfficiency) +
          0.25 * clamp01(1 - f.bodyDominance) +
          0.25 * clamp01(1 - Math.abs(f.rangeExpansion - 1)) +
          0.2 * clamp01(1 - f.wickImbalance),
      );
    case "FORCED_MOVEMENT":
      // Stops being run: sharp expansion + one-sided extreme closes + imbalance.
      return clamp01(
        0.4 * clamp01((f.rangeExpansion - 1) / 1.5) +
          0.3 * f.extremeCloseShare +
          0.3 * f.wickImbalance,
      );
    case "MEAN_REVERSION_PRESSURE":
      // Fading flow: negative autocorrelation, high sign-flip rate, no drift.
      return clamp01(
        0.4 * clamp01(-f.returnAutocorr1 / 0.7) +
          0.35 * clamp01((f.signFlipRate - 0.5) / 0.5) +
          0.25 * clamp01(1 - f.driftEfficiency),
      );
  }
}

// ── Validation on labeled historical fixtures ───────────────────────────────

export interface LabeledEcologyFixture {
  /** The behavioral hypothesis this window is a genuine historical example of. */
  label: EcologyHypothesisId;
  candles: EcologyCandle[];
}

export type EcologyValidationRecord =
  | {
      status: "VALIDATED";
      hypothesis: EcologyHypothesisId;
      fixtures: number;
      /** Fraction of matching-labeled fixtures where this hypothesis outranked
       *  ALL rival hypotheses. */
      hitRate: number;
      minHitRate: number;
    }
  | {
      status: "UNVALIDATED";
      hypothesis: EcologyHypothesisId;
      fixtures: number;
      reason: string;
    };

export const ECOLOGY_VALIDATION_MIN_FIXTURES = 8;
export const ECOLOGY_VALIDATION_MIN_HIT_RATE = 0.6;

/**
 * Validate ONE hypothesis's scorer against labeled historical fixtures: on
 * windows labeled with the hypothesis, its score must outrank every rival on
 * at least minHitRate of them, over at least minFixtures windows. Too few
 * fixtures or a failing hit rate → UNVALIDATED with the reason. There is no
 * pass-by-default path.
 */
export function validateEcologyHypothesis(
  hypothesis: EcologyHypothesisId,
  fixtures: readonly LabeledEcologyFixture[],
  opts: { minFixtures?: number; minHitRate?: number } = {},
): EcologyValidationRecord {
  const minFixtures = opts.minFixtures ?? ECOLOGY_VALIDATION_MIN_FIXTURES;
  const minHitRate = opts.minHitRate ?? ECOLOGY_VALIDATION_MIN_HIT_RATE;

  const matching = fixtures.filter((fx) => fx.label === hypothesis);
  let scored = 0;
  let hits = 0;
  for (const fx of matching) {
    const f = extractEcologyFeatures(fx.candles);
    if (!f) continue; // an unusable fixture is not evidence either way
    scored += 1;
    const own = scoreEcologyHypothesis(hypothesis, f);
    const rivals = ECOLOGY_HYPOTHESES.filter((h) => h !== hypothesis).map((h) =>
      scoreEcologyHypothesis(h, f),
    );
    if (rivals.every((r) => own > r)) hits += 1;
  }

  if (scored < minFixtures) {
    return {
      status: "UNVALIDATED",
      hypothesis,
      fixtures: scored,
      reason: `${scored} usable labeled fixtures < required ${minFixtures}`,
    };
  }
  const hitRate = hits / scored;
  if (hitRate < minHitRate) {
    return {
      status: "UNVALIDATED",
      hypothesis,
      fixtures: scored,
      reason: `hit rate ${hitRate.toFixed(3)} < required ${minHitRate}`,
    };
  }
  return { status: "VALIDATED", hypothesis, fixtures: scored, hitRate, minHitRate };
}

/** Validate all four hypotheses against one fixture library. */
export function validateEcologyHypotheses(
  fixtures: readonly LabeledEcologyFixture[],
  opts: { minFixtures?: number; minHitRate?: number } = {},
): Record<EcologyHypothesisId, EcologyValidationRecord> {
  const out = {} as Record<EcologyHypothesisId, EcologyValidationRecord>;
  for (const h of ECOLOGY_HYPOTHESES) out[h] = validateEcologyHypothesis(h, fixtures, opts);
  return out;
}

// ── The competing-hypotheses read ───────────────────────────────────────────

export interface EcologyHypothesisReading {
  hypothesis: EcologyHypothesisId;
  status: "VALIDATED" | "UNVALIDATED";
  /** Raw evidence score [0,1] — always reported for the journal. */
  evidenceScore01: number;
  /** Normalized probability across VALIDATED hypotheses only; null when this
   *  hypothesis is UNVALIDATED (it contributes nothing — never a guess). */
  probability: number | null;
  reason: string | null;
}

export type MarketEcologyRead =
  | {
      status: "OK";
      readings: EcologyHypothesisReading[];
      dominant: EcologyHypothesisId;
      dominantProbability: number;
      validatedCount: number;
      candlesUsed: number;
    }
  | {
      status: "NO_VALIDATED_HYPOTHESES";
      readings: EcologyHypothesisReading[];
      validatedCount: 0;
      candlesUsed: number;
    }
  | { status: "INSUFFICIENT_DATA"; reason: string };

/**
 * Read the current market as competing behavioral hypotheses. Probabilities
 * are normalized ONLY over hypotheses whose validation record is VALIDATED —
 * an UNVALIDATED hypothesis is reported (score + reason) but has probability
 * null and no weight in the normalization.
 */
export function readMarketEcology(
  candles: readonly EcologyCandle[],
  validations: Record<EcologyHypothesisId, EcologyValidationRecord>,
): MarketEcologyRead {
  const f = extractEcologyFeatures(candles);
  if (!f) {
    return {
      status: "INSUFFICIENT_DATA",
      reason: `need ≥ ${MIN_ECOLOGY_CANDLES} usable candles`,
    };
  }

  const scored = ECOLOGY_HYPOTHESES.map((h) => ({
    hypothesis: h,
    validation: validations[h],
    score: scoreEcologyHypothesis(h, f),
  }));

  const validated = scored.filter((s) => s.validation?.status === "VALIDATED");
  const totalValidatedScore = validated.reduce((a, s) => a + s.score, 0);

  const readings: EcologyHypothesisReading[] = scored.map((s) => {
    if (s.validation?.status !== "VALIDATED") {
      return {
        hypothesis: s.hypothesis,
        status: "UNVALIDATED",
        evidenceScore01: s.score,
        probability: null,
        reason: s.validation
          ? (s.validation as { reason?: string }).reason ?? "unvalidated"
          : "no validation record",
      };
    }
    return {
      hypothesis: s.hypothesis,
      status: "VALIDATED",
      evidenceScore01: s.score,
      probability:
        totalValidatedScore > 0 ? s.score / totalValidatedScore : 1 / validated.length,
      reason: null,
    };
  });

  if (validated.length === 0) {
    return {
      status: "NO_VALIDATED_HYPOTHESES",
      readings,
      validatedCount: 0,
      candlesUsed: f.candlesUsed,
    };
  }

  const withProb = readings.filter((r) => r.probability !== null);
  const dominant = withProb.reduce((a, b) =>
    (b.probability as number) > (a.probability as number) ? b : a,
  );

  return {
    status: "OK",
    readings,
    dominant: dominant.hypothesis,
    dominantProbability: dominant.probability as number,
    validatedCount: validated.length,
    candlesUsed: f.candlesUsed,
  };
}
