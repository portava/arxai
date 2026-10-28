// ── ONE candle-freshness rule for every board (server and dashboard) ─────────
//
// "Is this candle series current?" is answered by the trailing-interval gap:
// how many timeframe intervals the newest bar's OPEN trails the current
// epoch-aligned bar. A provider that serves only CLOSED bars naturally trails
// by 1 (its newest bar closed at the start of the current interval), so:
//
//   gap <= 1 → clean   (no bar is overdue)
//   gap == 2 → delayed (one closed bar is overdue)
//   gap >= 3 → stale
//
// The server (lib/data/freshness.ts, candleNormalization.trailingIntervalGap)
// and the dashboard scanner truth (lib/scannerTruth.ts) both use this module.
// Before it existed the dashboard used a wall-clock budget of ~1.2–1.5× the
// interval from the newest bar's open, so for most of every interval a
// healthy closed-bar feed read "Live" on the chart and "Stale" on the scanner.
//
// The gap only changes at an interval boundary, so `candleLiveUntilMs` gives
// the exact instant a "clean" series stops being clean without a new bar.
//
// Pure, display/analysis truth only — it never touches an execution gate.

export const LIVE_TRAILING_INTERVALS = 1;
export const DELAYED_TRAILING_INTERVALS = 2;
export const STALE_TRAILING_INTERVALS = 3;

export type CandleTrailingFreshness = "clean" | "delayed" | "stale";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Interval length (ms) for a timeframe token in either spelling the platform
 * uses: server ("M15", "H1", "D1", "W1", "MN1") or dashboard ("15m", "1h",
 * "1d", "1w", "1mo"). MN1 is 31 days (same as the server's timeframes table).
 * Unknown → null (callers fail closed).
 */
export function candleIntervalMs(timeframe: string | null | undefined): number | null {
  const raw = (timeframe ?? "").trim();
  if (!raw) return null;
  if (raw === "1M" || raw.toLowerCase() === "mn1" || raw.toLowerCase() === "1mo") return 31 * DAY_MS;
  const t = raw.toLowerCase();
  let m = /^([mhdw])(\d+)$/.exec(t);
  let unit: string | undefined;
  let n: number | undefined;
  if (m) { unit = m[1]; n = Number(m[2]); }
  else {
    m = /^(\d+)([mhdw])$/.exec(t);
    if (m) { n = Number(m[1]); unit = m[2]; }
  }
  if (!unit || !n || !Number.isFinite(n) || n <= 0) return null;
  const base = unit === "m" ? MIN_MS : unit === "h" ? HOUR_MS : unit === "d" ? DAY_MS : 7 * DAY_MS;
  return n * base;
}

/**
 * Trailing-interval gap of a series whose newest bar OPENED at `newestOpenMs`.
 * Same math as the server chart contract: round((floor(now/iv)·iv − open)/iv).
 * null when any input is unusable.
 */
export function trailingIntervalsFromOpen(newestOpenMs: number, intervalMs: number, nowMs: number): number | null {
  if (!Number.isFinite(newestOpenMs) || !Number.isFinite(nowMs) || !(intervalMs > 0)) return null;
  const expectedLatestOpen = Math.floor(nowMs / intervalMs) * intervalMs;
  return Math.round((expectedLatestOpen - newestOpenMs) / intervalMs);
}

/** clean / delayed / stale from a gap; null when the gap is unknown. */
export function classifyTrailingIntervals(trailingIntervals: number | null | undefined): CandleTrailingFreshness | null {
  if (trailingIntervals == null || !Number.isFinite(trailingIntervals)) return null;
  if (trailingIntervals >= STALE_TRAILING_INTERVALS) return "stale";
  if (trailingIntervals >= DELAYED_TRAILING_INTERVALS) return "delayed";
  return "clean";
}

/**
 * The first interval boundary at which a series whose newest bar opened at
 * `newestOpenMs` trails by DELAYED_TRAILING_INTERVALS (is no longer clean)
 * without a newer bar. NaN when inputs are unusable (callers fail closed).
 */
export function candleLiveUntilMs(newestOpenMs: number, intervalMs: number): number {
  if (!Number.isFinite(newestOpenMs) || !(intervalMs > 0)) return Number.NaN;
  // round(x) >= 2  ⇔  x >= 1.5 (Math.round rounds .5 up).
  return Math.ceil((newestOpenMs + 1.5 * intervalMs) / intervalMs) * intervalMs;
}
