// Calibration fit cache — the synchronous read side of the calibration engine.
//
// No DB import: payload builders (strategy engine, scanner, AI review) read
// from here on their hot path. The refit worker (refitWorker.ts) fills it from
// the persisted, versioned fits in calibration_fits. An empty cache (preview,
// cold start, no graded outcomes yet) reads as "unmeasured" with N, never as a
// number.

import {
  readScoped,
  rankByCalibration,
  type CalibrationFit,
  type FitLookup,
  type ScopedReading,
} from "@workspace/domain/calibration";

interface CachedFit {
  fit: CalibrationFit;
  version: number;
  source: string;
  fittedAt: string;
}

const fits = new Map<string, CachedFit>();
let loadedAt: string | null = null;

export const calibrationLookup: FitLookup = {
  get: (key) => fits.get(key),
};

export function replaceCalibrationCache(entries: Iterable<[string, CachedFit]>): void {
  fits.clear();
  for (const [k, v] of entries) fits.set(k, v);
  loadedAt = new Date().toISOString();
}

export function clearCalibrationCache(): void {
  fits.clear();
  loadedAt = null;
}

export function calibrationCacheEntries(): [string, CachedFit][] {
  return [...fits.entries()];
}

export function calibrationCacheLoadedAt(): string | null {
  return loadedAt;
}

/** The calibration fields a payload carries next to its raw score. */
export interface CalibrationStamp {
  /** Measured probability (0-1) the call works, or null when unmeasured. */
  probability: number | null;
  status: "measured" | "unmeasured";
  /** Graded outcomes behind the number (or behind the attempt). Always present. */
  n: number;
  /** exact | timeframe_fallback:<tf> | pooled_symbols | pooled_all | none */
  scope: string;
  model: "isotonic" | "base_rate" | "none";
  fitKey: string | null;
  fitVersion: number | null;
  baseRate: number | null;
  /** True only when the score beat the base rate out of sample. */
  edgeDetected: boolean;
  /** Ready-to-render text: "62% (N=143)" or "unmeasured (N=12)". */
  label: string;
  reason: string | null;
}

export function formatCalibrationLabel(probability: number | null, n: number): string {
  return probability == null
    ? `unmeasured (N=${n})`
    : `${Math.round(probability * 100)}% (N=${n})`;
}

export function toCalibrationStamp(r: ScopedReading): CalibrationStamp {
  return {
    probability: r.probability,
    status: r.status,
    n: r.n,
    scope: r.scope,
    model: r.model,
    fitKey: r.fitKey,
    fitVersion: r.fitVersion,
    baseRate: r.baseRate,
    edgeDetected: r.edgeDetected,
    label: formatCalibrationLabel(r.probability, r.n),
    reason: r.reason,
  };
}

/** Calibrated reading for one raw score. Sync, never throws. */
export function calibrate(
  strategy: string,
  symbol: string,
  timeframe: string,
  rawScore: number,
): CalibrationStamp {
  return toCalibrationStamp(readScoped(calibrationLookup, strategy, symbol, timeframe, rawScore));
}

export { rankByCalibration };

/** Calibration key for a strategy-engine strategy name. */
export function strategyCalibrationKey(strategyName: string): string {
  return `strategy:${strategyName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
}

export const SCANNER_CALIBRATION_KEY = "scanner";
export const ELEANOR_CALIBRATION_KEY = "eleanor";
export const AI_REVIEW_CALIBRATION_KEY = "ai_review";
export function agentCalibrationKey(agentKey: string): string {
  return `agent:${agentKey}`;
}
