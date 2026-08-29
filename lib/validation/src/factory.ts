// 7e — ValidationFactory: compose CPCV, Deflated Sharpe and PBO into one verdict.
//
// THE FACTORY'S JOB IS TO SAY NO
// ------------------------------
// A validation stack is not a scoring system; it is a series of veto points. A
// candidate must survive ALL of them, and each one has independent grounds to
// kill it:
//
//   CPCV  — is the out-of-sample result still there once training samples whose
//           labels overlap the test period are purged and embargoed?
//   DSR   — is the Sharpe better than the best I should expect from this many
//           trials on nothing, given the return distribution's skew and tails?
//   PBO   — does picking the in-sample winner actually predict out-of-sample
//           performance, or is the selection procedure itself noise?
//
// They are combined with AND, never averaged. Averaging would let a spectacular
// DSR carry a PBO of 0.6 — that is, let one strong-looking number outvote direct
// evidence that the selection process is uninformative. Every veto is absolute.
//
// The report is hash-chained into the Black Box with the canonicaliser shared by
// the event log, so a validation result cannot be quietly restated later.
//
// Pure: no I/O, no clock, no randomness of its own. Nothing here places, sizes,
// or authorises a trade — the factory produces a VERDICT, and Phase 8 decides
// what to do with it.

import { createHash } from "node:crypto";
import { sharpe, skewness, kurtosis, stdev } from "./stats.js";
import { cpcvSplits, type CpcvOptions } from "./cpcv.js";
import { deflatedSharpe, type DeflatedSharpeResult } from "./deflatedSharpe.js";
import { estimatePbo, type PboResult } from "./pbo.js";
import type { CostEvidence } from "./costModel.js";

/** Thresholds a candidate must clear. Every one is a veto. */
export interface ValidationThresholds {
  /** Minimum Deflated Sharpe (a probability). 0.95 is the conventional bar. */
  minDsr: number;
  /** Maximum Probability of Backtest Overfitting. Above this, selection is noise. */
  maxPbo: number;
}

export const DEFAULT_THRESHOLDS: ValidationThresholds = {
  minDsr: 0.95,
  maxPbo: 0.5,
};

export interface TrialResult {
  /** Stable identifier of the strategy variant. */
  key: string;
  familyKey: string;
  /** Per-observation returns over the whole track. */
  returns: number[];
}

export type ValidationVerdict = "PASS" | "REJECT";

export interface CandidateReport {
  key: string;
  familyKey: string;
  verdict: ValidationVerdict;
  observedSharpe: number;
  oosSharpe: number;
  dsr: number;
  pbo: number;
  /** Every veto that fired. Empty only for a PASS. */
  vetoes: string[];
}

export interface SignedValidationReport {
  familyKey: string;
  /** Trials in the family — the multiplicity the DSR was charged for. */
  nTrials: number;
  thresholds: ValidationThresholds;
  candidates: CandidateReport[];
  /** Candidates that survived every veto. */
  survivors: CandidateReport[];
  /** SHA-256 over the canonical report — chains it into the Black Box. */
  reportHash: string;
  prevHash: string;
  /**
   * The cost evidence this family was evaluated under, or null for a
   * gross-only run (in which case every candidate carries the
   * NET_OF_COSTS_REQUIRED veto and there are no survivors).
   *
   * Deliberately OUTSIDE the hashed body: the body's shape is frozen because
   * edgePromotion.ts (api-server) verifies reports by structurally mirroring
   * `finalise`'s canonical body, and the enforcement itself lives in the
   * hashed verdicts. The cost model is separately hash-stamped by
   * `evidence.modelHash` and chained by the transfer-proof harness.
   */
  costs: CostEvidence | null;
  detail: string;
}

/**
 * Out-of-sample Sharpe over purged, embargoed combinatorial splits.
 *
 * Returns are pooled across every split's test set, so the figure reflects many
 * paths through the data rather than one walk-forward run — a single path is one
 * sample of a very noisy statistic, and treating it as "the" answer is how a
 * methodologically honest-looking backtest still overfits.
 */
export function cpcvOosSharpe(returns: readonly number[], opts: Omit<CpcvOptions, "nObs">): number {
  const splits = cpcvSplits({ ...opts, nObs: returns.length });
  const pooled: number[] = [];
  for (const s of splits) for (const i of s.testIdx) pooled.push(returns[i]!);
  return sharpe(pooled);
}

/**
 * Validate a family of trials.
 *
 * `nTrials` is taken from the trial list itself, so it CANNOT be understated —
 * the most common way a backtest lies is by reporting the number of strategies
 * finally examined rather than the number actually tried.
 */
export function validateFamily(
  familyKey: string,
  trials: readonly TrialResult[],
  opts: {
    cpcv: Omit<CpcvOptions, "nObs">;
    thresholds?: ValidationThresholds;
    pboBlocks?: number;
    prevHash?: string;
    /**
     * Trials to charge the multiple-testing correction for. Defaults to the
     * number supplied, but Phase 8 passes the FULL family size including
     * niche-selection trials — choosing where to look is itself multiplicity.
     */
    chargedTrials?: number;
    /**
     * REQUIRED FOR CERTIFICATION. The evidence that every trial's returns are
     * NET of the CostSlippageModel (spread + slippage + commission — see
     * costModel.ts `netReturns`). When absent, or structurally hollow (a zero
     * per-side cost, a malformed model hash), every candidate is vetoed with
     * NET_OF_COSTS_REQUIRED: a gross-only evaluation can measure, but it
     * cannot certify — a gross "edge" smaller than its own round-trip cost is
     * a loss wearing a plus sign.
     */
    costs?: CostEvidence;
  },
): SignedValidationReport {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const prevHash = opts.prevHash ?? "0".repeat(64);
  const nTrials = opts.chargedTrials ?? trials.length;

  // The gross-only check names WHY the evidence fails, so the veto string in
  // the report explains itself instead of demanding archaeology.
  const costs = opts.costs ?? null;
  const grossOnlyReason =
    costs === null
      ? "no cost evidence supplied"
      : costs.applied !== true
        ? "cost evidence not marked applied"
        : !(costs.perSideCostFrac > 0)
          ? `zero/invalid perSideCostFrac (${costs.perSideCostFrac}) — a zero-cost model is gross in disguise`
          : !/^[0-9a-f]{64}$/.test(costs.modelHash)
            ? "cost model hash is not a sha256"
            : null;

  if (trials.length === 0) {
    return finalise(familyKey, 0, thresholds, [], prevHash, costs, "NO_TRIALS");
  }

  const inSampleSharpes = trials.map((t) => sharpe(t.returns));
  const trialSharpeSd = stdev(inSampleSharpes);

  // PBO is a property of the SELECTION over the whole field, computed once.
  const pboResult: PboResult = estimatePbo(
    trials.map((t) => t.returns),
    opts.pboBlocks ?? 10,
  );

  const candidates: CandidateReport[] = trials.map((t, i) => {
    const vetoes: string[] = [];
    const observedSharpe = inSampleSharpes[i]!;
    const oosSharpe = cpcvOosSharpe(t.returns, opts.cpcv);

    const dsrResult: DeflatedSharpeResult = deflatedSharpe({
      observedSharpe: oosSharpe,
      trackLength: t.returns.length,
      skew: skewness(t.returns),
      kurtosis: kurtosis(t.returns),
      nTrials,
      trialSharpeSd,
    });

    // Every veto is absolute; they are ANDed, never averaged.
    if (grossOnlyReason !== null) {
      vetoes.push(`NET_OF_COSTS_REQUIRED (${grossOnlyReason})`);
    }
    if (!(oosSharpe > 0)) {
      vetoes.push(`CPCV_OOS_NOT_POSITIVE (${oosSharpe.toFixed(4)})`);
    }
    if (!(dsrResult.dsr >= thresholds.minDsr)) {
      vetoes.push(`DSR_BELOW_THRESHOLD (${dsrResult.dsr.toFixed(4)} < ${thresholds.minDsr})`);
    }
    // A NaN PBO (too few strategies or observations to rank) is a veto, not a
    // pass — an unmeasurable overfitting probability is not a low one.
    if (!(pboResult.pbo <= thresholds.maxPbo)) {
      vetoes.push(`PBO_ABOVE_THRESHOLD (${String(pboResult.pbo)} > ${thresholds.maxPbo})`);
    }

    return {
      key: t.key,
      familyKey: t.familyKey,
      verdict: vetoes.length === 0 ? "PASS" : "REJECT",
      observedSharpe,
      oosSharpe,
      dsr: dsrResult.dsr,
      pbo: pboResult.pbo,
      vetoes,
    };
  });

  return finalise(
    familyKey,
    nTrials,
    thresholds,
    candidates,
    prevHash,
    grossOnlyReason === null ? costs : null,
    pboResult.detail,
  );
}

function finalise(
  familyKey: string,
  nTrials: number,
  thresholds: ValidationThresholds,
  candidates: CandidateReport[],
  prevHash: string,
  costs: CostEvidence | null,
  detail: string,
): SignedValidationReport {
  const survivors = candidates.filter((c) => c.verdict === "PASS");
  const body = {
    familyKey,
    nTrials,
    thresholds,
    candidates: candidates.map((c) => ({
      key: c.key,
      verdict: c.verdict,
      oosSharpe: round(c.oosSharpe),
      dsr: round(c.dsr),
      pbo: round(c.pbo),
    })),
  };
  const reportHash = createHash("sha256")
    .update(`${JSON.stringify(body)}|${prevHash}`, "utf8")
    .digest("hex");

  return {
    familyKey,
    nTrials,
    thresholds,
    candidates,
    survivors,
    reportHash,
    prevHash,
    costs,
    detail:
      `${survivors.length}/${candidates.length} survived` +
      (costs === null ? " (GROSS-ONLY: nothing can certify)" : " (net of costs)") +
      `. ${detail}`,
  };
}

/** Fixed-precision rounding so the report hash is stable across platforms. */
function round(x: number): number | string {
  return Number.isFinite(x) ? Number(x.toFixed(10)) : String(x);
}
