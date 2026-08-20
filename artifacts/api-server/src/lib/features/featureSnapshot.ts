// Feature Snapshot adapter — R7 step 4 (ONE FEATURE PATH).
//
// WHAT THIS FILE IS
// -----------------
// The api-server side of the shared feature engine seam. `@workspace/features`
// owns the feature MATH (`computeFeatures`, versioned by `FEATURE_SET_ID`) as a
// pure function of `(instrument, asOf, PointInTimeReader)`. This adapter does
// exactly one job: turn the candle series the api-server ALREADY fetched (the
// scanner's routed window; shadow mode's series) into a `PointInTimeReader`,
// run the IDENTICAL engine backtest/shadow/live all share, and hand back a
// stamped, persistable snapshot. There is deliberately NO second sigma formula
// here — reimplementing the math in the api-server is the train/serve skew the
// package exists to prevent.
//
// WHAT A SNAPSHOT IS FOR
// ----------------------
// Research/replay must be able to reproduce a decision's EXACT feature
// assumptions (Part IV). So a snapshot is either the full `FeatureVector`
// (with `featureSetId` + `dataSnapshotHash` provenance) or an HONEST refusal:
//
//   INSUFFICIENT_DATA — the candles could not establish the features
//                       (too few closed bars, degenerate closes, no window).
//   LOOKAHEAD_REFUSED — the engine detected that the only available data was
//                       not knowable at `asOf`. This is a refusal, never a
//                       silent fallback: a snapshot built on future data would
//                       be hindsight dressed as evidence.
//
// UNKNOWN/refused is a VALID outcome. Nothing here fabricates a vector.
//
// CONSTRAINT — LookaheadError handling: `LookaheadError` is caught by exact
// `instanceof` and surfaced as a typed `LOOKAHEAD_REFUSED` refusal. It must
// NEVER be swallowed by a generic catch — a generic swallow would convert a
// lookahead bug into a missing-data path, which is a different and much
// harder-to-notice failure (see the PointInTimeReader contract in
// lib/features/src/index.ts). Any NON-lookahead error is rethrown untouched:
// it is a defect, not a data condition, and hiding it would be dishonest.

import {
  computeFeatures,
  FEATURE_SET_ID,
  LookaheadError,
  type FeatureVector,
  type PointInTimeFact,
  type PointInTimeReader,
} from "@workspace/features";

// Re-exported so in-scope consumers (marketScanner, shadowMode) stamp the ONE
// engine version constant instead of importing the package a second time.
export { FEATURE_SET_ID, LookaheadError };
export type { FeatureVector };

/**
 * Minimal structural candle the adapter needs. Both the router's `Candle`
 * (lib/data/types.ts) and the strategy engine's `Candle` (strategyEngine.ts)
 * satisfy it, so scanner and shadow mode adapt WITHOUT copying bars.
 * `time` is the bar OPEN time (the repo-wide open-time basis — see
 * rawTrailingIntervalGap's contract in the chart feed-status path).
 */
export interface FeatureCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * Floor for a measured σ estimate. With n log-returns the standard error of a
 * σ estimate is ≈ σ/√(2n); below ~19 returns that error exceeds ~16% of σ, at
 * which point the number is noise wearing a decimal point. Returning `null`
 * (→ INSUFFICIENT_DATA) is more honest than a plausible-looking guess.
 * The scanner's routed window (SCAN_ROUTED_LIMIT = 60) clears this floor.
 */
export const MIN_SIGMA_CANDLES = 20;

/** Cap on the estimation window: at most this many newest eligible bars. */
export const SIGMA_WINDOW = 60;

const MS_PER_MINUTE = 60_000;

/**
 * Infer the bar interval (minutes) from the candles themselves: the median of
 * the positive gaps between consecutive parseable open times. Median, not
 * mean, so one missing bar (a doubled gap) cannot skew the interval.
 * `null` when fewer than two parseable timestamps exist or every gap is
 * degenerate — an interval that cannot be established must not be guessed,
 * because it scales σ to per-minute terms (wrong interval ⇒ wrong σ, silently).
 */
export function inferBarMinutes(candles: readonly FeatureCandle[]): number | null {
  const times = candles
    .map((c) => Date.parse(c.time))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const medianMs = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return medianMs / MS_PER_MINUTE;
}

/**
 * The CLOSE time of the newest candle (open time + inferred interval), as ISO.
 *
 * This is the honest `asOf` anchor for a snapshot computed from a candle
 * series: every bar in the series is closed (knowable) at that instant, and —
 * unlike a wall-clock read — replaying the SAME candles reproduces the
 * byte-identical snapshot. `null` when no interval can be established (0 or 1
 * parseable bars): with no anchor there is no instant the snapshot could
 * honestly claim to describe, so callers must refuse rather than stamp one.
 */
export function latestCloseIso(candles: readonly FeatureCandle[]): string | null {
  const barMinutes = inferBarMinutes(candles);
  if (barMinutes === null) return null;
  let latestOpen = Number.NEGATIVE_INFINITY;
  for (const c of candles) {
    const t = Date.parse(c.time);
    if (Number.isFinite(t) && t > latestOpen) latestOpen = t;
  }
  if (!Number.isFinite(latestOpen)) return null;
  return new Date(latestOpen + barMinutes * MS_PER_MINUTE).toISOString();
}

/**
 * A bitemporal `PointInTimeReader` over a closed-candle series.
 *
 * A bar opened at T with interval Δ becomes a KNOWABLE fact at its close,
 * T+Δ — using a still-forming bar would be intra-bar lookahead. So for any
 * `asOf`, only bars with `openTime + Δ <= asOf` may contribute, whatever the
 * caller passed in.
 *
 * CONSTRAINT (PointInTimeReader contract): when candles exist but every one
 * of them closes AFTER `asOf`, this reader THROWS `LookaheadError` — it never
 * returns `null` for that case, because "the data wasn't knowable yet" and
 * "there is no data" are different failures and only the second may look like
 * missing data. Exported (not inlined) precisely so tests can pin the throw.
 */
export function candlePointInTimeReader(candles: readonly FeatureCandle[]): PointInTimeReader {
  return {
    latestFact<T>(key: string, asOfIso: string): PointInTimeFact<T> | null {
      if (candles.length === 0) return null;
      const asOfMs = Date.parse(asOfIso);
      if (!Number.isFinite(asOfMs)) {
        // An unparseable asOf makes knowability unprovable. Fail CLOSED the
        // same way lib/features' own assertNotAhead does for unparseable
        // timestamps: refuse as lookahead, never proceed on a guess.
        throw new LookaheadError(`${key} (unparseable asOf)`, asOfIso, asOfIso);
      }
      const barMinutes = inferBarMinutes(candles);
      if (barMinutes === null) return null; // interval unknowable ⇒ no honest fact
      const barMs = barMinutes * MS_PER_MINUTE;

      const stamped = candles
        .map((c) => ({ c, openMs: Date.parse(c.time) }))
        .filter((x): x is { c: FeatureCandle; openMs: number } => Number.isFinite(x.openMs))
        .sort((a, b) => a.openMs - b.openMs);
      if (stamped.length === 0) return null; // garbage timestamps ⇒ no fact, not lookahead

      const eligible = stamped.filter((x) => x.openMs + barMs <= asOfMs);
      if (eligible.length === 0) {
        // Data EXISTS but none of it was knowable at asOf — the contract-
        // mandated throw (see the CONSTRAINT note above).
        const earliestKnowable = new Date(stamped[0].openMs + barMs).toISOString();
        throw new LookaheadError(key, asOfIso, earliestKnowable);
      }
      if (eligible.length < MIN_SIGMA_CANDLES) return null;

      const window = eligible.slice(-SIGMA_WINDOW);
      const closes = window.map((x) => x.c.close);
      if (closes.some((p) => !Number.isFinite(p) || p <= 0)) return null;

      // Sample stddev of close-to-close log returns, scaled from per-bar to
      // per-minute in VARIANCE terms (σ_1min = σ_bar / √Δ_minutes) — the same
      // diffusion scaling lib/markets' expectedMove model assumes.
      const returns: number[] = [];
      for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const varSum = returns.reduce((a, b) => a + (b - mean) * (b - mean), 0);
      const sigmaBar = Math.sqrt(varSum / (returns.length - 1));
      const sigma1min = sigmaBar / Math.sqrt(barMinutes);

      const lastClose = new Date(window[window.length - 1].openMs + barMs).toISOString();
      return {
        // The measurement became true AND knowable when its newest bar closed.
        validTimeIso: lastClose,
        ingestionTimeIso: lastClose,
        value: sigma1min as T,
      };
    },
  };
}

export type FeatureSnapshotRefusalReason = "INSUFFICIENT_DATA" | "LOOKAHEAD_REFUSED";

export interface FeatureSnapshotAvailable {
  available: true;
  /** The engine version that produced `features` — always `FEATURE_SET_ID`. */
  featureSetId: string;
  /**
   * Mirrors `asOf`, NOT a clock read: the snapshot is a pure function of
   * (candles, asOf), and a wall-clock stamp would make two byte-identical
   * computations look different — killing replay determinism for a timestamp
   * that carries no information the persistence layer doesn't already record.
   */
  computedAt: string;
  features: FeatureVector;
}

export interface FeatureSnapshotRefused {
  available: false;
  /** Stamped on refusals too — a refusal records WHICH engine version refused. */
  featureSetId: string;
  computedAt: string;
  reason: FeatureSnapshotRefusalReason;
  /** Human-readable why — surfaced verbatim from the engine for lookahead. */
  detail: string;
}

/**
 * Either the exact feature assumptions a decision saw, or an honest refusal.
 * Persisted verbatim (shadow rows; later calibration inputs) so research and
 * replay can reproduce the decision — Part IV: exact feature assumptions.
 */
export type FeatureSnapshot = FeatureSnapshotAvailable | FeatureSnapshotRefused;

/**
 * Build the feature snapshot for `symbol` as of `asOfIso`, from candles the
 * caller ALREADY holds. Deterministic: same candles + same asOf ⇒ identical
 * snapshot, byte for byte (including `features.dataSnapshotHash`).
 *
 * Prefer `latestCloseIso(candles)` as the `asOf` anchor — it is the newest
 * instant at which every supplied bar is honestly knowable.
 */
export function buildFeatureSnapshot(
  symbol: string,
  candles: readonly FeatureCandle[],
  asOfIso: string,
): FeatureSnapshot {
  const reader = candlePointInTimeReader(candles);
  try {
    const features = computeFeatures(symbol, asOfIso, reader);
    if (features.expectedMoveSigma1min === null) {
      // The engine ran but could not establish σ (null is its honest "could
      // not be established" — never 0). A vector whose only feature is
      // unestablished pins no reproducible assumption, so refuse honestly
      // instead of stamping an empty claim.
      return {
        available: false,
        featureSetId: FEATURE_SET_ID,
        computedAt: asOfIso,
        reason: "INSUFFICIENT_DATA",
        detail:
          `sigma(1min) could not be established for ${symbol} from ` +
          `${candles.length} candle(s) as of ${asOfIso}`,
      };
    }
    return {
      available: true,
      featureSetId: FEATURE_SET_ID,
      computedAt: asOfIso,
      features,
    };
  } catch (err) {
    // CONSTRAINT: exact-type surfacing only. LookaheadError becomes a typed
    // refusal; EVERYTHING else is rethrown untouched. A generic catch here
    // would let a lookahead bug (or a real defect) masquerade as missing
    // data — the failure mode lib/features' distinct error type exists to
    // make impossible.
    if (err instanceof LookaheadError) {
      return {
        available: false,
        featureSetId: FEATURE_SET_ID,
        computedAt: asOfIso,
        reason: "LOOKAHEAD_REFUSED",
        detail: err.message,
      };
    }
    throw err;
  }
}
