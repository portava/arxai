// 7b — CPCVEngine: combinatorial purged cross-validation.
//
// WHY PLAIN K-FOLD IS WORSE THAN USELESS ON FINANCIAL DATA
// --------------------------------------------------------
// K-fold assumes observations are independent. Financial labels are not: a label
// at time t is usually computed over a FORWARD WINDOW [t, t+horizon), so the
// labels at t and t+1 share almost all of the same price path. Split naively and
// a training sample at t−1 carries the same outcome as a test sample at t. The
// model does not need to generalise; it can recall. The resulting "out-of-sample"
// Sharpe is inflated, and the inflation is invisible because the split LOOKS
// clean — no observation appears in both sets.
//
// Two corrections, and both are needed:
//
//   PURGING  — drop any training observation whose label window overlaps the
//              test period at all. This removes the shared-outcome samples.
//   EMBARGO  — additionally drop a band of training observations immediately
//              AFTER each test block. Serial correlation in features (not just
//              labels) leaks across the boundary even once labels are purged;
//              the embargo is the buffer that stops it.
//
// COMBINATORIAL, not sequential: with N groups and p test groups per split there
// are C(N,p) distinct train/test partitions instead of N. Many paths through the
// data, not one — a single walk-forward path is one sample of a very noisy
// statistic, and treating it as "the" out-of-sample result is how a backtest
// with an honest-looking methodology still overfits.
//
// Pure index arithmetic. No data, no I/O, no clock.

import { combinations } from "./stats.js";

export interface CpcvSplit {
  /** Indices in the test set, ascending. */
  testIdx: number[];
  /** Indices in the training set after purging and embargo, ascending. */
  trainIdx: number[];
  /** Which group numbers formed the test set. */
  testGroups: number[];
  /** Training observations removed because their label window overlapped test. */
  purgedCount: number;
  /** Training observations removed by the post-test embargo band. */
  embargoedCount: number;
}

export interface CpcvOptions {
  nObs: number;
  /** Number of contiguous groups to partition the observations into. */
  nGroups: number;
  /** How many groups form the test set in each split. */
  p: number;
  /** Label window length: the label at t is computed over [t, t+horizon). */
  horizon: number;
  /** Observations to drop immediately after each test block. */
  embargo: number;
}

/**
 * Build every purged, embargoed combinatorial split.
 *
 * Returns C(nGroups, p) splits. Groups are contiguous index blocks, because the
 * data are a time series — shuffling observations into groups would destroy the
 * very adjacency this function exists to defend against.
 */
export function cpcvSplits(opts: CpcvOptions): CpcvSplit[] {
  const { nObs, nGroups, p, horizon, embargo } = opts;
  if (nGroups < 2 || p < 1 || p >= nGroups) {
    throw new Error(`cpcvSplits: need 2 ≤ nGroups and 1 ≤ p < nGroups (got nGroups=${nGroups}, p=${p})`);
  }
  if (nObs < nGroups) throw new Error(`cpcvSplits: nObs ${nObs} < nGroups ${nGroups}`);

  // Contiguous, near-equal blocks. Remainder goes to the earliest groups so the
  // partition is deterministic rather than depending on rounding luck.
  const base = Math.floor(nObs / nGroups);
  const extra = nObs % nGroups;
  const bounds: Array<[number, number]> = [];
  let start = 0;
  for (let g = 0; g < nGroups; g++) {
    const len = base + (g < extra ? 1 : 0);
    bounds.push([start, start + len]);
    start += len;
  }

  const splits: CpcvSplit[] = [];
  for (const testGroups of combinations(nGroups, p)) {
    const inTest = new Uint8Array(nObs);
    const blocks: Array<[number, number]> = [];
    for (const g of testGroups) {
      const [lo, hi] = bounds[g]!;
      blocks.push([lo, hi]);
      for (let i = lo; i < hi; i++) inTest[i] = 1;
    }

    const testIdx: number[] = [];
    for (let i = 0; i < nObs; i++) if (inTest[i]) testIdx.push(i);

    // Embargo band: the `embargo` observations immediately after each test block.
    const embargoed = new Uint8Array(nObs);
    for (const [, hi] of blocks) {
      for (let i = hi; i < Math.min(nObs, hi + embargo); i++) embargoed[i] = 1;
    }

    const trainIdx: number[] = [];
    let purgedCount = 0;
    let embargoedCount = 0;
    for (let i = 0; i < nObs; i++) {
      if (inTest[i]) continue;

      // PURGE: does this training observation's label window [i, i+horizon)
      // touch ANY test observation? If so its outcome is partly the test set's
      // outcome, and training on it is training on the answer.
      let overlaps = false;
      for (let j = i; j < Math.min(nObs, i + horizon); j++) {
        if (inTest[j]) { overlaps = true; break; }
      }
      if (overlaps) { purgedCount++; continue; }

      if (embargoed[i]) { embargoedCount++; continue; }

      trainIdx.push(i);
    }

    splits.push({ testIdx, trainIdx, testGroups, purgedCount, embargoedCount });
  }
  return splits;
}

/**
 * The leakage a split still admits: the closest gap, in observations, between
 * any training index and any test index, measured against the label horizon.
 *
 * Zero means at least one training observation's label window still touches the
 * test set — the split leaks. A correctly purged split returns a gap of at least
 * `horizon`, which is what makes the purge verifiable rather than asserted.
 */
export function minTrainTestGap(split: CpcvSplit): number {
  if (split.trainIdx.length === 0 || split.testIdx.length === 0) return Infinity;
  const test = split.testIdx;
  let best = Infinity;
  for (const t of split.trainIdx) {
    // Binary search for the nearest test index.
    let lo = 0;
    let hi = test.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (test[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    for (const k of [lo - 1, lo, lo + 1]) {
      if (k >= 0 && k < test.length) best = Math.min(best, Math.abs(test[k]! - t));
    }
  }
  return best;
}
