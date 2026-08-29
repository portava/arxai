// @workspace/features — the ONE feature path.
//
// WHY THERE IS EXACTLY ONE
// ------------------------
// Train/serve skew is the quiet killer of trading systems: the backtest computes
// a feature one way, the live path computes it another, and the difference is
// indistinguishable from alpha until real money finds out otherwise. The usual
// cause is not carelessness — it is that backtest and live read data from
// completely different places, so they end up as different code.
//
// The fix here is a seam, not a discipline. `computeFeatures` is a pure function
// of `(instrument, asOf, reader)`. Backtest (replaying `event_log`), shadow, and
// live each supply their own `PointInTimeReader`; the IDENTICAL `computeFeatures`
// runs over all three. There is no second implementation to drift.
//
// WHY THE READER MUST THROW
// -------------------------
// The other quiet killer is lookahead: a backtest reading a fact that, at the
// simulated moment, had not yet been INGESTED. The value was true at that time —
// that is what makes it so convincing — but nobody could have known it yet. A
// reader that silently returns such a fact produces a backtest that cannot be
// reproduced live, and the resulting "edge" is pure hindsight.
//
// So the seam is bitemporal: a fact qualifies only when BOTH its validTime and
// its ingestionTime are at or before `asOf`. A reader that can only satisfy a
// key with a future-ingested fact must THROW `LookaheadError` rather than return
// it, and `computeFeatures` re-checks the timestamps of whatever it is handed —
// a reader that forgets to enforce the rule is caught here rather than trusted.

import { synthSigma1min, synthVolIndex } from "@workspace/markets";
import { sha256Hex, stableStringify } from "./eventChain.js";

export * from "./eventChain.js";

/**
 * Thrown when the only data available for a key was ingested after `asOf`.
 *
 * A distinct error type, not a generic one, so a backtest harness can never
 * catch-and-continue past it by accident: lookahead invalidates the whole run,
 * not just the one feature.
 */
export class LookaheadError extends Error {
  constructor(
    readonly key: string,
    readonly asOfIso: string,
    readonly ingestionTimeIso: string,
  ) {
    super(
      `LookaheadError: fact ${JSON.stringify(key)} was ingested at ${ingestionTimeIso}, ` +
        `after asOf ${asOfIso} — it could not have been known yet`,
    );
    this.name = "LookaheadError";
  }
}

export interface PointInTimeFact<T> {
  /** When the fact became TRUE in the world. */
  validTimeIso: string;
  /** When the system first LEARNED it. */
  ingestionTimeIso: string;
  value: T;
}

export interface PointInTimeReader {
  /**
   * The latest fact for `key` with BOTH `ingestionTime <= asOf` AND
   * `validTime <= asOf`, or `null` when no such fact exists.
   *
   * MUST throw {@link LookaheadError} if the only data for the key is
   * future-ingested — returning `null` in that case would silently turn a
   * lookahead bug into a missing-data path, which is a different and much
   * harder-to-notice failure.
   */
  latestFact<T>(key: string, asOfIso: string): PointInTimeFact<T> | null;
}

/**
 * Bumped whenever the feature MATH changes — never for a comment, a rename, or
 * a refactor that leaves the numbers identical.
 *
 * It feeds `lineage.featureCodeHash` on every `event_log` row, so a model
 * trained under `fset_v1` can be told apart from one trained under `fset_v2`
 * even if both ran over the same data. Without it, a silent formula change makes
 * every historical decision uninterpretable.
 *
 * v1 → v2: the measured-σ estimator behind `sigma1min:<sym>` changed from a
 * flat 60-bar sample stdev to a RiskMetrics EWMA (λ = 0.94) over the same
 * window — see candlePointInTimeReader in the api-server adapter. The closed
 * form for synthetics is untouched (it is a definition, not an estimate), but
 * a measured vector computed after the change is a different function of the
 * same bars, so rows must be distinguishable.
 */
export const FEATURE_SET_ID = "fset_v2";

export interface FeatureVector {
  featureSetId: string;
  instrument: string;
  asOfIso: string;
  /**
   * Per-minute σ. `null` when it could not be established — never 0, which is a
   * VALID volatility meaning "this instrument does not move" and would size
   * positions as though risk were absent.
   */
  expectedMoveSigma1min: number | null;
  /** Hash of exactly the inputs used, so the vector's provenance is checkable. */
  dataSnapshotHash: string;
}

/** Feed key for a measured per-minute volatility. */
export function sigmaFeedKey(instrument: string): string {
  return `sigma1min:${instrument}`;
}

/**
 * Compute the feature vector for an instrument as of an instant.
 *
 * Deterministic: no clock read, no network, no randomness. Given the same reader
 * and the same `asOf`, the output is byte-identical — which is what makes the
 * golden-vector test meaningful and what lets a backtest be replayed.
 *
 * For a Deriv "Volatility N" synthetic, σ is a CLOSED FORM of N and needs no
 * market read at all, so the vector is asOf-invariant. That is the property the
 * golden anchor relies on: any drift in it is a code change, never a data change.
 */
export function computeFeatures(
  instrument: string,
  asOfIso: string,
  reader: PointInTimeReader,
): FeatureVector {
  const n = synthVolIndex(instrument);

  let sigma: number | null;
  let inputs: Record<string, unknown>;

  if (n != null) {
    // Closed form — no read, so nothing to look ahead at.
    sigma = synthSigma1min(n);
    inputs = { kind: "SYNTHETIC_CLOSED_FORM", instrument, volIndex: n };
  } else {
    const key = sigmaFeedKey(instrument);
    const fact = reader.latestFact<number>(key, asOfIso);
    if (fact === null) {
      sigma = null;
      inputs = { kind: "MEASURED", instrument, key, fact: null };
    } else {
      // Defense in depth: re-check the seam rather than trusting the reader.
      // A reader that forgets to enforce bitemporality is caught HERE, not in
      // six months when a backtested edge fails to reproduce.
      assertNotAhead(key, asOfIso, fact.ingestionTimeIso, "ingestionTime");
      assertNotAhead(key, asOfIso, fact.validTimeIso, "validTime");
      sigma = Number.isFinite(fact.value) && fact.value > 0 ? fact.value : null;
      inputs = {
        kind: "MEASURED",
        instrument,
        key,
        validTimeIso: fact.validTimeIso,
        ingestionTimeIso: fact.ingestionTimeIso,
        value: fact.value,
      };
    }
  }

  return {
    featureSetId: FEATURE_SET_ID,
    instrument,
    asOfIso,
    expectedMoveSigma1min: sigma,
    dataSnapshotHash: sha256Hex(stableStringify(inputs)),
  };
}

function assertNotAhead(key: string, asOfIso: string, tIso: string, which: string): void {
  const t = Date.parse(tIso);
  const asOf = Date.parse(asOfIso);
  if (!Number.isFinite(t) || !Number.isFinite(asOf)) {
    throw new LookaheadError(`${key} (unparseable ${which})`, asOfIso, tIso);
  }
  if (t > asOf) throw new LookaheadError(`${key} (${which})`, asOfIso, tIso);
}
