// 7d — PBOEstimator: Probability of Backtest Overfitting, via CSCV.
//
// THE QUESTION PBO ANSWERS
// ------------------------
// Deflated Sharpe asks "is this one strategy's result better than chance would
// give me". PBO asks a different and in some ways harsher question about the
// SELECTION PROCEDURE itself: "when I pick the best strategy in-sample, how often
// does it turn out to be below-median out-of-sample?"
//
// If your search procedure is finding real structure, the in-sample winner
// should tend to stay good. If it is finding noise, the in-sample winner is
// simply the strategy that got the luckiest, and luck does not persist — its
// out-of-sample rank lands uniformly, so it falls below the median about half
// the time. PBO ≈ 0.5 means "your selection carries no information at all."
//
// This is why PBO ≈ 0.5 on pure noise is a PASS for the estimator and an alarm
// for the strategy set. An estimator that reported a comfortable PBO of 0.05 on
// noise would be broken in the most dangerous possible direction, and the test
// suite asserts against exactly that.
//
// CSCV (Combinatorially Symmetric Cross-Validation): split the track into S
// disjoint blocks, and for every way of choosing S/2 of them as in-sample (with
// the complement as out-of-sample), record the out-of-sample rank of the
// in-sample winner. Symmetric because every partition also appears reversed, so
// no in-sample period is privileged.
//
// Pure arithmetic. No I/O, no clock, no randomness.

import { combinations, sharpe } from "./stats.js";

export interface PboResult {
  /** Probability of backtest overfitting, in [0, 1]. ≈ 0.5 ⇒ selection is noise. */
  pbo: number;
  /** How many CSCV partitions were evaluated. */
  combinations: number;
  /** Median out-of-sample rank of the in-sample winner, in [0, 1]. */
  medianOosRank: number;
  /** The logit of each partition's OOS rank; PBO is the fraction below zero. */
  logits: number[];
  detail: string;
}

/**
 * Estimate PBO from a matrix of per-observation returns.
 *
 * `returnsByStrategy[i][t]` is strategy i's return at observation t. Every row
 * must be the same length — a ragged matrix means the strategies were not
 * evaluated over the same period, and comparing their ranks would be
 * meaningless.
 *
 * `nBlocks` must be even (CSCV halves it) and is capped in practice by C(S,S/2):
 * S=10 gives 252 partitions, S=16 gives 12,870.
 */
export function estimatePbo(
  returnsByStrategy: readonly (readonly number[])[],
  nBlocks = 10,
): PboResult {
  const nStrategies = returnsByStrategy.length;
  if (nStrategies < 2) {
    return {
      pbo: NaN, combinations: 0, medianOosRank: NaN, logits: [],
      detail: "INSUFFICIENT_STRATEGIES: PBO compares a winner against a field; need at least 2.",
    };
  }
  const t = returnsByStrategy[0]!.length;
  if (returnsByStrategy.some((r) => r.length !== t)) {
    throw new Error("estimatePbo: all strategies must span the same observations");
  }
  if (nBlocks % 2 !== 0) throw new Error(`estimatePbo: nBlocks must be even (got ${nBlocks})`);
  if (t < nBlocks * 2) {
    return {
      pbo: NaN, combinations: 0, medianOosRank: NaN, logits: [],
      detail: `INSUFFICIENT_OBSERVATIONS: ${t} observations across ${nBlocks} blocks is too few to rank.`,
    };
  }

  // Contiguous blocks — the data are a time series, so blocks are periods.
  const bounds: Array<[number, number]> = [];
  const base = Math.floor(t / nBlocks);
  const extra = t % nBlocks;
  let start = 0;
  for (let b = 0; b < nBlocks; b++) {
    const len = base + (b < extra ? 1 : 0);
    bounds.push([start, start + len]);
    start += len;
  }

  const half = nBlocks / 2;
  const logits: number[] = [];
  const ranks: number[] = [];

  for (const isBlocks of combinations(nBlocks, half)) {
    const inIs = new Set(isBlocks);
    const isIdx: number[] = [];
    const oosIdx: number[] = [];
    for (let b = 0; b < nBlocks; b++) {
      const [lo, hi] = bounds[b]!;
      const target = inIs.has(b) ? isIdx : oosIdx;
      for (let i = lo; i < hi; i++) target.push(i);
    }

    const isPerf = returnsByStrategy.map((r) => sharpe(isIdx.map((i) => r[i]!)));
    const oosPerf = returnsByStrategy.map((r) => sharpe(oosIdx.map((i) => r[i]!)));

    // The in-sample winner.
    let best = 0;
    for (let i = 1; i < nStrategies; i++) if (isPerf[i]! > isPerf[best]!) best = i;

    // Its out-of-sample rank, as a fraction in (0, 1). The (N+1) denominator
    // keeps the logit finite even when the winner ranks first or last.
    let below = 0;
    for (let i = 0; i < nStrategies; i++) if (oosPerf[i]! < oosPerf[best]!) below++;
    const omega = (below + 1) / (nStrategies + 1);
    ranks.push(omega);
    logits.push(Math.log(omega / (1 - omega)));
  }

  // PBO = fraction of partitions where the in-sample winner landed BELOW the
  // out-of-sample median, i.e. a non-positive logit.
  const pbo = logits.filter((l) => l <= 0).length / logits.length;
  const sortedRanks = [...ranks].sort((a, b) => a - b);
  const medianOosRank =
    sortedRanks.length % 2 === 1
      ? sortedRanks[(sortedRanks.length - 1) / 2]!
      : (sortedRanks[sortedRanks.length / 2 - 1]! + sortedRanks[sortedRanks.length / 2]!) / 2;

  return {
    pbo,
    combinations: logits.length,
    medianOosRank,
    logits,
    detail:
      `PBO=${pbo.toFixed(4)} over ${logits.length} CSCV partitions; ` +
      `median OOS rank of the in-sample winner = ${medianOosRank.toFixed(4)} ` +
      "(≈0.5 ⇒ the selection procedure carries no information)",
  };
}
