import { trailingIntervalsFromOpen } from "@workspace/domain/market";
// ARX Native Chart — Level 1: timeframe contract.
//
// The chart endpoints accept ONLY the canonical ARX timeframe codes below.
// Anything else is rejected cleanly at the zod boundary (generated from the
// OpenAPI enum). This module is the single source of truth for the allowed
// list and each timeframe's bar interval in seconds, used by the candle
// sequence validator (gap / staleness detection).

export const CHART_TIMEFRAMES = [
  "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
  "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1",
] as const;

export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];

const TIMEFRAME_SECONDS: Record<ChartTimeframe, number> = {
  M1: 60,
  M2: 2 * 60,
  M3: 3 * 60,
  M4: 4 * 60,
  M5: 5 * 60,
  M6: 6 * 60,
  M10: 10 * 60,
  M12: 12 * 60,
  M15: 15 * 60,
  M20: 20 * 60,
  M30: 30 * 60,
  H1: 60 * 60,
  H2: 2 * 60 * 60,
  H3: 3 * 60 * 60,
  H4: 4 * 60 * 60,
  H6: 6 * 60 * 60,
  H8: 8 * 60 * 60,
  H12: 12 * 60 * 60,
  D1: 24 * 60 * 60,
  W1: 7 * 24 * 60 * 60,
  // Month length varies 28-31d; the UPPER bound is the SAFE direction for
  // gap/staleness detection (avoids false gaps + false-stale on a fresh
  // monthly bar). Mirrors brokerCandleStore TIMEFRAME_MS (MN1 = 31d).
  MN1: 31 * 24 * 60 * 60,
};

export function isChartTimeframe(tf: string): tf is ChartTimeframe {
  return (CHART_TIMEFRAMES as readonly string[]).includes(tf);
}

// Lower-case / TradingView-style aliases the UI may send (e.g. the scanner's
// default "15m", "1h", "1d") mapped to the canonical ARX codes. Keyed on the
// UPPERCASED form so a single lookup table covers both casings. Chart
// intelligence and the candle-interval math are canonical-only, so a request
// that arrives in an alias form must be normalized at the entry point or it
// silently degrades to an INSUFFICIENT read (chart-timeframe normalization gap).
const TIMEFRAME_ALIASES: Record<string, ChartTimeframe> = {
  "1M": "M1", "2M": "M2", "3M": "M3", "4M": "M4", "5M": "M5", "6M": "M6",
  "10M": "M10", "12M": "M12", "15M": "M15", "20M": "M20", "30M": "M30",
  "1H": "H1", "2H": "H2", "3H": "H3", "4H": "H4", "6H": "H6", "8H": "H8",
  "12H": "H12",
  "1D": "D1", D: "D1",
  "1W": "W1", W: "W1",
  "1MN": "MN1", MN: "MN1", "1MO": "MN1", MO: "MN1", MONTH: "MN1",
};

/**
 * Normalize an arbitrary timeframe string to a canonical {@link ChartTimeframe},
 * accepting both the canonical codes ("M15") and common aliases ("15m", "1h").
 * Returns `null` when the string maps to no supported timeframe — callers must
 * treat `null` as an explicit, honest "unsupported timeframe", never silently
 * coerce it. DISPLAY/DATA-routing helper only; never an execution gate.
 */
export function normalizeChartTimeframe(raw: string): ChartTimeframe | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  const upper = t.toUpperCase();
  if (isChartTimeframe(upper)) return upper;
  return TIMEFRAME_ALIASES[upper] ?? null;
}

/** Bar interval in seconds for a canonical timeframe. */
export function timeframeSeconds(tf: ChartTimeframe): number {
  return TIMEFRAME_SECONDS[tf];
}

/** Bar interval in milliseconds for a canonical timeframe. */
export function timeframeMs(tf: ChartTimeframe): number {
  return TIMEFRAME_SECONDS[tf] * 1000;
}

/** Calendar-month boundaries, in the input bar's coordinate system. This
 * fixes interval geometry; it does not attest historical broker UTC mapping. */
export function advanceBarOpen(openMs: number, tf: ChartTimeframe, count = 1): number {
  if (!Number.isFinite(openMs) || !Number.isInteger(count)) return NaN;
  if (tf !== "MN1") return openMs + count * timeframeMs(tf);
  const d = new Date(openMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + count, 1);
}
export function barCloseMs(openMs: number, tf: ChartTimeframe): number {
  return advanceBarOpen(openMs, tf);
}
export function barIntervalDistance(fromMs: number, toMs: number, tf: ChartTimeframe): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return NaN;
  if (tf !== "MN1") return Math.round((toMs - fromMs) / timeframeMs(tf));
  const a = new Date(fromMs), b = new Date(toMs);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
}
export function calendarAwareTrailingIntervals(openMs: number, tf: ChartTimeframe, nowMs: number): number | null {
  if (!Number.isFinite(openMs) || !Number.isFinite(nowMs)) return null;
  return tf === "MN1" ? barIntervalDistance(openMs, nowMs, tf) : tf === "W1" ? Math.floor((nowMs - openMs) / timeframeMs(tf)) : trailingIntervalsFromOpen(openMs, timeframeMs(tf), nowMs);
}
