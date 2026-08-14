// Build KK — Candle import validation.
//
// SAFETY: pure validation/normalization only. No I/O, no execution paths.

export interface RawCandle {
  time?: number | string | Date;
  t?: number | string | Date;
  open?: number; o?: number;
  high?: number; h?: number;
  low?: number; l?: number;
  close?: number; c?: number;
  volume?: number; v?: number;
}

export interface NormalizedCandle {
  time: Date; open: number; high: number; low: number; close: number; volume: number | null;
}

export interface DataQuality {
  status: "GOOD" | "DEGRADED" | "REJECTED";
  duplicateCount: number;
  gapCount: number;
  invalidOhlcCount: number;
  outOfOrderCount: number;
  outlierCount: number;
  warnings: string[];
  errors: string[];
}

export interface ValidationResult {
  ok: boolean;
  candles: NormalizedCandle[];
  rejected: { index: number; reason: string }[];
  quality: DataQuality;
  startTime: Date | null;
  endTime: Date | null;
}

const TF_MS: Record<string, number> = {
  M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000,
  H1: 3_600_000, H4: 14_400_000, D1: 86_400_000,
};

export function isSupportedTimeframe(tf: string): boolean {
  return tf in TF_MS;
}

function toMs(t: unknown): number | null {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number" && Number.isFinite(t)) return t > 1e12 ? t : t * 1000;
  if (typeof t === "string") {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(t);
    return Number.isFinite(d) ? d : null;
  }
  return null;
}

function pickN(o: RawCandle, a: keyof RawCandle, b: keyof RawCandle): number | null {
  const v = (o[a] ?? o[b]);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function validateAndNormalize(
  raw: unknown,
  timeframe: string,
): ValidationResult {
  const quality: DataQuality = {
    status: "GOOD", duplicateCount: 0, gapCount: 0, invalidOhlcCount: 0,
    outOfOrderCount: 0, outlierCount: 0, warnings: [], errors: [],
  };
  const rejected: { index: number; reason: string }[] = [];

  if (!Array.isArray(raw) || raw.length === 0) {
    quality.status = "REJECTED";
    quality.errors.push("candles array is empty");
    return { ok: false, candles: [], rejected, quality, startTime: null, endTime: null };
  }
  if (!isSupportedTimeframe(timeframe)) {
    quality.status = "REJECTED";
    quality.errors.push(`unsupported timeframe: ${timeframe}`);
    return { ok: false, candles: [], rejected, quality, startTime: null, endTime: null };
  }

  const expectedDelta = TF_MS[timeframe];
  const accepted: NormalizedCandle[] = [];

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as RawCandle;
    const tMs = toMs(c?.time ?? c?.t);
    const o = pickN(c, "open", "o");
    const h = pickN(c, "high", "h");
    const l = pickN(c, "low", "l");
    const cl = pickN(c, "close", "c");
    if (tMs == null) { rejected.push({ index: i, reason: "invalid time" }); continue; }
    if (o == null || h == null || l == null || cl == null) {
      rejected.push({ index: i, reason: "missing/non-numeric OHLC" });
      quality.invalidOhlcCount++;
      continue;
    }
    if (h < l || h < Math.max(o, cl) || l > Math.min(o, cl)) {
      rejected.push({ index: i, reason: "OHLC inconsistent (high<low or high<max(o,c) or low>min(o,c))" });
      quality.invalidOhlcCount++;
      continue;
    }
    const v = typeof c?.volume === "number" ? c.volume : (typeof c?.v === "number" ? c.v : null);
    accepted.push({ time: new Date(tMs), open: o, high: h, low: l, close: cl, volume: v });
  }

  // Sort + duplicate/gap/order detection.
  accepted.sort((a, b) => a.time.getTime() - b.time.getTime());
  const dedup: NormalizedCandle[] = [];
  let lastT = -Infinity;
  for (const k of accepted) {
    const t = k.time.getTime();
    if (t === lastT) { quality.duplicateCount++; continue; }
    if (lastT > -Infinity && t < lastT) { quality.outOfOrderCount++; continue; }
    if (lastT > -Infinity) {
      const delta = t - lastT;
      if (delta > expectedDelta * 1.5) {
        const missing = Math.round(delta / expectedDelta) - 1;
        if (missing > 0) quality.gapCount += missing;
      }
    }
    dedup.push(k);
    lastT = t;
  }

  // Outlier warn: any close that moves more than 25% vs prior close.
  for (let i = 1; i < dedup.length; i++) {
    const prev = dedup[i - 1].close;
    if (prev > 0 && Math.abs(dedup[i].close - prev) / prev > 0.25) {
      quality.outlierCount++;
    }
  }
  if (quality.outlierCount > 0) {
    quality.warnings.push(`${quality.outlierCount} extreme outlier candle(s) detected (>25% move vs prior close)`);
  }
  if (quality.duplicateCount > 0) quality.warnings.push(`${quality.duplicateCount} duplicate timestamp(s) removed`);
  if (quality.gapCount > 0) quality.warnings.push(`${quality.gapCount} timeframe gap(s) detected`);
  if (quality.outOfOrderCount > 0) quality.warnings.push(`${quality.outOfOrderCount} out-of-order candle(s) skipped`);
  if (quality.invalidOhlcCount > 0) quality.warnings.push(`${quality.invalidOhlcCount} candle(s) rejected for invalid OHLC`);

  // Status grading.
  if (dedup.length === 0) {
    quality.status = "REJECTED";
    quality.errors.push("no valid candles after validation");
  } else if (quality.invalidOhlcCount > 0 || quality.gapCount > 0 || quality.duplicateCount > 0 || quality.outlierCount > 0) {
    quality.status = "DEGRADED";
  }

  return {
    ok: dedup.length > 0,
    candles: dedup,
    rejected,
    quality,
    startTime: dedup[0]?.time ?? null,
    endTime: dedup[dedup.length - 1]?.time ?? null,
  };
}
