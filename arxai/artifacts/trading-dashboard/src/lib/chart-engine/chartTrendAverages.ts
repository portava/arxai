import type { ChartStudy } from "./chartStudies";

/** Built-in 20 and 50 period simple moving averages of the close, shown on the
 * price pane by default. Each segment is blue where the average rises (bull)
 * and red where it falls (bear). They are display studies: they never enter the
 * user's study list, its count or its persistence, and the Volume-style toggle
 * hides them. */
export const TREND_AVERAGE_BULL = "#3b82f6";
export const TREND_AVERAGE_BEAR = "#ef4444";
const PREFIX = "arx-trend-ma-";
export const TREND_AVERAGE_STUDIES: readonly ChartStudy[] = [
  { id: `${PREFIX}20`, kind: "sma", period: 20, color: TREND_AVERAGE_BULL, source: "close" },
  { id: `${PREFIX}50`, kind: "sma", period: 50, color: TREND_AVERAGE_BULL, source: "close", lineStyles: [{ width: 2 }] },
];
export const isTrendAverage = (study: ChartStudy): boolean => !!study.id?.startsWith(PREFIX);
/** The studies the chart draws: the trend averages first, then the user's own. */
export function withTrendAverages(studies: ChartStudy[], enabled: boolean): ChartStudy[] {
  const own = studies.filter(study => !isTrendAverage(study));
  return enabled ? [...TREND_AVERAGE_STUDIES.map(study => ({ ...study })), ...own] : own;
}
/** Colour of the segment ending at `value`: rising or flat is bull, falling is bear.
 * The first defined value has no direction yet and takes the bull colour. */
export function trendAverageColor(value: number, previous: number | null | undefined): string {
  return previous == null || !Number.isFinite(previous) || value >= previous ? TREND_AVERAGE_BULL : TREND_AVERAGE_BEAR;
}
