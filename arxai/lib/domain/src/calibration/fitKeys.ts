// Fit keys, the cross-timeframe fallback chain and calibrated ranking. PURE.
//
// A fit is keyed `strategy|symbol|timeframe`; "*" pools a dimension. A reading
// for (strategy, symbol, timeframe) walks a fixed chain and stops at the first
// MEASURED fit:
//   1. strategy|symbol|timeframe                       scope "exact"
//   2. strategy|symbol|<nearest other timeframe>      scope "timeframe_fallback:<tf>"
//   3. strategy|*|timeframe                            scope "pooled_symbols"
//   4. strategy|*|*                                    scope "pooled_all"
// The scope travels with the number, so a borrowed calibration is never shown
// as if it were measured on the exact market and timeframe.

import {
  readCalibration,
  unmeasuredReading,
  type CalibratedReading,
  type CalibrationFit,
} from "./calibration.engine";

/** Every timeframe the chart can show, shortest first. */
export const CALIBRATION_TIMEFRAMES = [
  "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
  "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1",
] as const;

export const POOLED = "*";

export function fitKey(strategy: string, symbol: string, timeframe: string): string {
  return `${strategy}|${symbol || POOLED}|${timeframe || POOLED}`;
}

/** Other timeframes ordered by distance on the chart ladder (ties → shorter). */
export function timeframesByDistance(timeframe: string): string[] {
  const ladder = CALIBRATION_TIMEFRAMES as readonly string[];
  const at = ladder.indexOf(timeframe);
  if (at < 0) return [];
  return ladder
    .map((tf, i) => ({ tf, d: Math.abs(i - at), i }))
    .filter((x) => x.tf !== timeframe)
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.tf);
}

export interface ScopedReading extends CalibratedReading {
  fitKey: string | null;
  scope: string;
  fitVersion: number | null;
}

export interface FitLookup {
  get(key: string): { fit: CalibrationFit; version: number } | undefined;
}

export function readScoped(
  lookup: FitLookup,
  strategy: string,
  symbol: string,
  timeframe: string,
  score: number,
): ScopedReading {
  const chain: { key: string; scope: string }[] = [
    { key: fitKey(strategy, symbol, timeframe), scope: "exact" },
    ...timeframesByDistance(timeframe).map((tf) => ({
      key: fitKey(strategy, symbol, tf),
      scope: `timeframe_fallback:${tf}`,
    })),
    { key: fitKey(strategy, POOLED, timeframe), scope: "pooled_symbols" },
    { key: fitKey(strategy, POOLED, POOLED), scope: "pooled_all" },
  ];
  let mostSpecificN = 0;
  let sawAny = false;
  for (const step of chain) {
    const hit = lookup.get(step.key);
    if (!hit) continue;
    if (!sawAny) {
      mostSpecificN = hit.fit.n;
      sawAny = true;
    }
    if (hit.fit.status !== "measured") continue;
    return { ...readCalibration(hit.fit, score), fitKey: step.key, scope: step.scope, fitVersion: hit.version };
  }
  return { ...unmeasuredReading(mostSpecificN), fitKey: null, scope: "none", fitVersion: null };
}

// ── Ranking ────────────────────────────────────────────────────────────────

export interface RankInput {
  rawScore: number;
  reading: Pick<CalibratedReading, "probability">;
}

export type RankBasis = "calibrated_probability" | "unmeasured_raw_order";

/**
 * Order rows by calibrated probability. Measured rows always rank above
 * unmeasured ones (an unmeasured number is not allowed to outrank a measured
 * one); ties and the unmeasured tail fall back to the raw score, and the basis
 * of each position is returned with it.
 */
export function rankByCalibration<T extends RankInput>(rows: readonly T[]): (T & { rank: number; rankBasis: RankBasis })[] {
  const measured = rows.filter((r) => r.reading.probability != null);
  const unmeasured = rows.filter((r) => r.reading.probability == null);
  measured.sort(
    (a, b) => (b.reading.probability as number) - (a.reading.probability as number) || b.rawScore - a.rawScore,
  );
  unmeasured.sort((a, b) => b.rawScore - a.rawScore);
  return [
    ...measured.map((r) => ({ ...r, rankBasis: "calibrated_probability" as const })),
    ...unmeasured.map((r) => ({ ...r, rankBasis: "unmeasured_raw_order" as const })),
  ].map((r, i) => ({ ...r, rank: i + 1 }));
}
