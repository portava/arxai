import {
  type DecisionRecord, type ConvictionReport, type ConvictionCalibration,
  clamp01,
} from "./decisionIntelligence.types";

// ═══════════════════════════════════════════════════════════════════════════
// Conviction Calibration — for resolved trade decisions, compare expressed
// confidence against realised hit rate per band.
//
//   • Bands: 0–0.1, 0.1–0.2, ..., 0.9–1.0 (10 buckets).
//   • Brier score: mean squared error between expressed confidence and
//     binary outcome (1 = win).
//   • overallCalibration01 = clamp01(1 − 4·Brier). 4× factor maps the
//     0..0.25 "useful" Brier range to 1..0.
//
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface ConvictionInput {
  records: ReadonlyArray<DecisionRecord>;
  bandCount?: number;       // default 10
  overconfidenceTolerance?: number;  // default 0.10
}

export function computeConvictionReport(input: ConvictionInput): ConvictionReport {
  const reasons: string[] = [];
  const N = Math.max(2, input.bandCount ?? 10);
  const tol = input.overconfidenceTolerance ?? 0.10;

  const resolved = input.records.filter((r) =>
    (r.kind === "ENTRY" || r.kind === "SCALE_IN" || r.kind === "SCALE_OUT" || r.kind === "EXIT")
    && r.outcome !== "PENDING"
    && typeof r.realizedR === "number");

  if (resolved.length === 0) {
    reasons.push(`no resolved trades — returning neutral report`);
    return {
      overallCalibration01: 0.5, brierScore: 0,
      bands: [], overconfidentBands: [], underconfidentBands: [], reasons,
    };
  }

  const buckets: { mid: number; n: number; wins: number; brier: number; label: string }[] = [];
  for (let i = 0; i < N; i++) {
    const lo = i / N; const hi = (i + 1) / N;
    buckets.push({ mid: (lo + hi) / 2, n: 0, wins: 0, brier: 0, label: `${lo.toFixed(2)}–${hi.toFixed(2)}` });
  }

  let totalBrier = 0;
  for (const r of resolved) {
    const c = clamp01(r.expressedConfidence01);
    const idx = Math.min(N - 1, Math.floor(c * N));
    const isWin = (r.realizedR ?? 0) > 0 ? 1 : 0;
    buckets[idx]!.n += 1;
    buckets[idx]!.wins += isWin;
    const sq = (c - isWin) ** 2;
    buckets[idx]!.brier += sq;
    totalBrier += sq;
  }
  const brier = totalBrier / resolved.length;

  const bands: ConvictionCalibration[] = buckets.map((b) => ({
    bandLabel: b.label,
    expressedMid01: b.mid,
    observedHitRate01: b.n > 0 ? clamp01(b.wins / b.n) : 0,
    brierContribution: b.n > 0 ? b.brier / b.n : 0,
    count: b.n,
  }));

  const overconfidentBands: string[] = [];
  const underconfidentBands: string[] = [];
  for (const b of bands) {
    if (b.count === 0) continue;
    const gap = b.expressedMid01 - b.observedHitRate01;
    if (gap >  tol) overconfidentBands.push(b.bandLabel);
    if (gap < -tol) underconfidentBands.push(b.bandLabel);
  }

  // Map Brier ∈ [0, 0.25] → calibration ∈ [1, 0]. Worse Brier than 0.25
  // (essentially anti-calibrated) clips to 0.
  const overallCalibration01 = clamp01(1 - 4 * brier);
  reasons.push(`Brier ${brier.toFixed(4)} · calibration ${overallCalibration01.toFixed(3)} · n=${resolved.length}`);
  if (overconfidentBands.length)  reasons.push(`overconfident bands: ${overconfidentBands.join(", ")}`);
  if (underconfidentBands.length) reasons.push(`underconfident bands: ${underconfidentBands.join(", ")}`);

  return {
    overallCalibration01, brierScore: brier,
    bands, overconfidentBands, underconfidentBands, reasons,
  };
}
