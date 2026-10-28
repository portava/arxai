/** Fixed-duration chart intervals whose candle-close contract is supported by
 * the native chart, reader, replay and cross-view links. Provider availability
 * is separate: offering an interval never fabricates or resamples its candles. */
export const CHART_INTERVALS = [
  "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
  "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1",
] as const;
export type ChartInterval = typeof CHART_INTERVALS[number];
export const CHART_QUICK_INTERVALS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
export type ChartRequestedInterval = ChartInterval | "W1" | "MN1";
export const WEEKLY_CHART_LIMITATION = "Weekly charts are unavailable until source-verified week boundaries are supported. Provider weeks cannot be aligned by a fixed epoch offset.";
export const MONTHLY_CHART_LIMITATION = "Monthly charts are unavailable until source-verified calendar-month boundaries are supported. A month is not a fixed 30 or 31 days.";
const SECONDS: Record<ChartInterval, number> = {
  M1:60, M2:120, M3:180, M4:240, M5:300, M6:360, M10:600, M12:720, M15:900, M20:1200, M30:1800,
  H1:3600, H2:7200, H3:10800, H4:14400, H6:21600, H8:28800, H12:43200, D1:86400,
};
export function isChartInterval(value: unknown): value is ChartInterval {
  return typeof value === "string" && (CHART_INTERVALS as readonly string[]).includes(value);
}
/** Never guess a duration, including for the calendar-month API code MN1. */
export function chartIntervalSeconds(value: unknown): number | null {
  return isChartInterval(value) ? SECONDS[value] : null;
}

/** Preserve recognized unavailable requests so saved workspaces explain their
 * limitation instead of silently displaying a different interval. */
export function restoreChartInterval(value: unknown, fallback: ChartRequestedInterval = "M15"): ChartRequestedInterval {
  return parseChartInterval(value) ?? fallback;
}
export function chartIntervalLimitation(value: unknown): string | null {
  return value === "W1" ? WEEKLY_CHART_LIMITATION : value === "MN1" ? MONTHLY_CHART_LIMITATION : null;
}

/** Accept recognized native/API codes and Scanner display IDs without the
 * query helper's unknown-to-M5 fallback. Preserve 1M (month) versus 1m (minute). */
export function parseChartInterval(value: unknown): ChartRequestedInterval | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "1M") return "MN1";
  const code = raw.toUpperCase();
  if (isChartInterval(code) || code === "W1" || code === "MN1") return code;
  const match = /^(\d+)(mo|m|h|d|w)$/i.exec(raw);
  if (!match) return null;
  const candidate = match[2]!.toLowerCase() === "mo" ? `MN${match[1]}` : `${match[2]!.toUpperCase()}${match[1]}`;
  return isChartInterval(candidate) || candidate === "W1" || candidate === "MN1" ? candidate : null;
}

/** Scanner storage/events use display IDs; native/API context stays uppercase. */
export function chartIntervalDisplayId(timeframe: ChartRequestedInterval): string {
  return timeframe === "MN1" ? "1mo" : `${timeframe.slice(1)}${timeframe[0]!.toLowerCase()}`;
}
