import type { ChartStudy } from "./chartStudies";

/** Built-in 20 and 50 period simple moving averages of the close, shown on the
 * price pane by default. Like MetaTrader, each is one solid line with a fixed
 * colour: the 20 (fast) is always blue, the 50 (slow) always red. The fast
 * line above the slow one reads bullish, below it bearish. They are display
 * studies: they never enter the user's study list, its count or its
 * persistence, and the "MA 20/50" toggle hides them. */
export const TREND_AVERAGE_FAST_COLOR = "#3b82f6";
export const TREND_AVERAGE_SLOW_COLOR = "#ef4444";
const PREFIX = "arx-trend-ma-";
export const TREND_AVERAGE_STUDIES: readonly ChartStudy[] = [
  { id: `${PREFIX}20`, kind: "sma", period: 20, color: TREND_AVERAGE_FAST_COLOR, source: "close" },
  { id: `${PREFIX}50`, kind: "sma", period: 50, color: TREND_AVERAGE_SLOW_COLOR, source: "close" },
];
export const isTrendAverage = (study: ChartStudy): boolean => !!study.id?.startsWith(PREFIX);
/** The studies the chart draws: the trend averages first, then the user's own. */
export function withTrendAverages(studies: ChartStudy[], enabled: boolean): ChartStudy[] {
  const own = studies.filter(study => !isTrendAverage(study));
  return enabled ? [...TREND_AVERAGE_STUDIES.map(study => ({ ...study })), ...own] : own;
}
