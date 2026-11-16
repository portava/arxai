// Calibration fit cache — the synchronous read side of the calibration engine.
//
// No DB import: payload builders (strategy engine, scanner, AI review) read
// from here on their hot path. The refit worker (refitWorker.ts) fills it from
// the persisted, versioned fits in calibration_fits. An empty cache (preview,
// cold start, no graded outcomes yet) reads as "unmeasured" with N, never as a
// number.

import {
  readScoped,
  CALIBRATION_METHOD,
  rankByCalibration,
  type CalibrationFit,
  type FitLookup,
  type ScopedReading,
} from "@workspace/domain/calibration";
import { toStampProvenance, type FitProvenance, type StampProvenance } from "./provenance.js";

export interface CachedFit {
  fit: CalibrationFit;
  version: number;
  source: string;
  fittedAt: string;
  /** Evidence behind N; null for fits persisted before provenance existed. */
  provenance?: FitProvenance | null;
}

const fits = new Map<string, CachedFit>();
let loadedAt: string | null = null;

export const calibrationLookup: FitLookup = {
  get: (key) => {
    const entry = fits.get(key);
    return entry ? structuredClone(entry) : undefined;
  },
};

export function replaceCalibrationCache(entries: Iterable<[string, CachedFit]>): void {
  fits.clear();
  for (const [k, v] of entries) if (v.fit.method === CALIBRATION_METHOD) fits.set(k, structuredClone(v));
  loadedAt = new Date().toISOString();
}

export function clearCalibrationCache(): void {
  fits.clear();
  loadedAt = null;
}

export function calibrationCacheEntries(): [string, CachedFit][] {
  return structuredClone([...fits.entries()]);
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
  /** Where N came from: the fit's source ("historical_replay", "eleanor_outcomes",
   *  "historical_replay+strategy_replay", ...) or "none" when no fit was read. */
  source: string;
  /** The evidence behind N: live vs replay counts, the fixtures (id + dataset
   *  hash) a replay ran on, and the precedence rule. Always present. */
  provenance: StampProvenance;
}

export function formatCalibrationLabel(probability: number | null, n: number): string {
  return probability == null
    ? `unmeasured (N=${n})`
    : `${Math.round(probability * 100)}% (N=${n})`;
}

export function toCalibrationStamp(
  r: ScopedReading,
  entry?: Pick<CachedFit, "source" | "provenance"> | null,
): CalibrationStamp {
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
    source: entry?.source ?? "none",
    provenance: toStampProvenance(entry?.provenance),
  };
}

/** Calibrated reading for one raw score. Sync, never throws. */
export function calibrate(
  strategy: string,
  symbol: string,
  timeframe: string,
  rawScore: number,
): CalibrationStamp {
  const r = readScoped(calibrationLookup, strategy, symbol, timeframe, rawScore);
  return toCalibrationStamp(r, r.fitKey ? fits.get(r.fitKey) : null);
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
