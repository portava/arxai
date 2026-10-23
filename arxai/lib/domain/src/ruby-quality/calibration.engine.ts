// Calibration roll-up over resolved Ruby signal outcomes. PURE.
//
// Answers: "when Ruby said it was N% confident on timeframe X, how often was it
// actually right?" — a confidence-tier × timeframe grid of predicted confidence
// vs realized accuracy. OBSERVATION ONLY. No IO/DB/HTTP, no execution path.
//
// HONESTY CONTRACTS:
//  - The accuracy denominator is EXACTLY graded directional outcomes (WIN+LOSS).
//    PENDING / UNRESOLVED (and EXPIRED / no-trade verdicts) NEVER enter it. They
//    are reported separately for transparency but can never inflate a rate.
//  - A cell whose graded directional sample is below `minSample` is flagged
//    `insufficientSample` and its `accuracy` / `calibrationGap` are null — never a
//    fabricated rate off a tiny sample.
//  - Each row lands in EXACTLY ONE confidence tier: half-open [lo, hi) intervals
//    with the top tier inclusive of its upper edge. No boundary double-counting.

import type { SignalOutcomeStatus } from "./rubyQuality.types";

export interface CalibrationSampleRow {
  timeframe: string;
  confidenceScore: number;
  outcomeStatus: SignalOutcomeStatus;
}

export interface CalibrationCell {
  timeframe: string;
  confidenceTier: string; // e.g. "75-90"
  tierLow: number;
  tierHigh: number;
  total: number;          // all rows in this cell (any status)
  resolved: number;       // not PENDING / UNRESOLVED
  pending: number;        // PENDING + UNRESOLVED (never in the denominator)
  wins: number;
  losses: number;
  breakeven: number;      // resolved but non-directional; excluded from accuracy
  sample: number;         // wins + losses — the accuracy denominator
  accuracy: number | null;       // wins / sample, null when insufficientSample
  avgConfidence: number | null;  // mean confidenceScore over the sampled rows
  calibrationGap: number | null; // avgConfidence/100 - accuracy, null if insufficient
  insufficientSample: boolean;   // sample < minSample
}

export interface CalibrationTotals {
  tracked: number;           // all rows considered
  resolved: number;          // not PENDING / UNRESOLVED
  pending: number;           // PENDING + UNRESOLVED
  graded: number;            // WIN + LOSS + BREAKEVEN
  directionalGraded: number; // WIN + LOSS (the calibration basis)
}

export interface RubyCalibrationRollup {
  minSample: number;
  tierEdges: number[];
  totals: CalibrationTotals;
  cells: CalibrationCell[];
}

export const DEFAULT_CALIBRATION_TIER_EDGES: readonly number[] = [0, 60, 75, 90, 100];
export const DEFAULT_CALIBRATION_MIN_SAMPLE = 20;

const isPending = (s: SignalOutcomeStatus): boolean =>
  s === "PENDING" || s === "UNRESOLVED";

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function normalizeTimeframe(tf: string | null | undefined): string {
  const t = (tf ?? "").trim();
  return t.length ? t : "unspecified";
}

// Assign a confidence value to exactly one tier: [lo, hi) for every tier except
// the top one, which is inclusive of its upper edge. Values outside the edge
// range clamp to the first / last tier.
function tierIndexFor(v: number, edges: number[]): number {
  const last = edges.length - 2;
  if (v <= edges[0]) return 0;
  if (v >= edges[edges.length - 1]) return last;
  for (let i = 0; i < last; i++) {
    if (v >= edges[i] && v < edges[i + 1]) return i;
  }
  return last;
}

interface CellAcc {
  timeframe: string;
  tierIndex: number;
  total: number;
  resolved: number;
  pending: number;
  wins: number;
  losses: number;
  breakeven: number;
  confSum: number; // sum of confidenceScore over directional (WIN/LOSS) rows
}

export function computeRubyCalibration(
  rows: CalibrationSampleRow[],
  opts?: { minSample?: number; tierEdges?: number[] },
): RubyCalibrationRollup {
  const tierEdges =
    opts?.tierEdges && opts.tierEdges.length >= 2
      ? [...opts.tierEdges]
      : [...DEFAULT_CALIBRATION_TIER_EDGES];
  const minSample = Math.max(
    1,
    Math.floor(opts?.minSample ?? DEFAULT_CALIBRATION_MIN_SAMPLE),
  );

  const tierLabels: { label: string; lo: number; hi: number }[] = [];
  for (let i = 0; i < tierEdges.length - 1; i++) {
    tierLabels.push({ label: `${tierEdges[i]}-${tierEdges[i + 1]}`, lo: tierEdges[i], hi: tierEdges[i + 1] });
  }

  const totals: CalibrationTotals = {
    tracked: rows.length,
    resolved: 0,
    pending: 0,
    graded: 0,
    directionalGraded: 0,
  };

  const cells = new Map<string, CellAcc>();

  for (const r of rows) {
    const status = r.outcomeStatus;
    const tf = normalizeTimeframe(r.timeframe);
    const ti = tierIndexFor(r.confidenceScore, tierEdges);
    const key = `${tf}\u0000${ti}`;
    let acc = cells.get(key);
    if (!acc) {
      acc = { timeframe: tf, tierIndex: ti, total: 0, resolved: 0, pending: 0, wins: 0, losses: 0, breakeven: 0, confSum: 0 };
      cells.set(key, acc);
    }

    acc.total++;
    if (isPending(status)) {
      acc.pending++;
      totals.pending++;
    } else {
      acc.resolved++;
      totals.resolved++;
    }

    if (status === "WIN" || status === "LOSS" || status === "BREAKEVEN") totals.graded++;
    if (status === "WIN") {
      acc.wins++;
      acc.confSum += r.confidenceScore;
      totals.directionalGraded++;
    } else if (status === "LOSS") {
      acc.losses++;
      acc.confSum += r.confidenceScore;
      totals.directionalGraded++;
    } else if (status === "BREAKEVEN") {
      acc.breakeven++;
    }
  }

  const out: CalibrationCell[] = [];
  for (const acc of cells.values()) {
    const sample = acc.wins + acc.losses;
    const insufficientSample = sample < minSample;
    const avgConfidence = sample > 0 ? round3(acc.confSum / sample) : null;
    const accuracy = insufficientSample ? null : round3(acc.wins / sample);
    const calibrationGap =
      accuracy === null || avgConfidence === null
        ? null
        : round3(avgConfidence / 100 - accuracy);
    const t = tierLabels[acc.tierIndex];
    out.push({
      timeframe: acc.timeframe,
      confidenceTier: t.label,
      tierLow: t.lo,
      tierHigh: t.hi,
      total: acc.total,
      resolved: acc.resolved,
      pending: acc.pending,
      wins: acc.wins,
      losses: acc.losses,
      breakeven: acc.breakeven,
      sample,
      accuracy,
      avgConfidence,
      calibrationGap,
      insufficientSample,
    });
  }

  out.sort((a, b) =>
    a.timeframe < b.timeframe ? -1 : a.timeframe > b.timeframe ? 1 : a.tierLow - b.tierLow,
  );

  return { minSample, tierEdges, totals, cells: out };
}
