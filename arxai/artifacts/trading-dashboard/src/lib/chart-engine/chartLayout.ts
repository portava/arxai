import { exactChartSymbol } from "./chartAnalysisCatalogue";
import { restoreChartInterval, type ChartInterval, type ChartRequestedInterval } from "./chartIntervals";
export { CHART_INTERVALS, isChartInterval, type ChartInterval, type ChartRequestedInterval } from "./chartIntervals";

export const SCANNER_CHART_LAYOUT_KEY = "arx.scanner.chart.layout.v1";
export const CHART_LAYOUT_KEY = "arx.chart.layout.v2";
export interface ComparisonView { symbol: string | null; timeframe: ChartRequestedInterval; followPrimaryInterval?: boolean }
export interface ChartLayoutState {
  count: 1 | 2 | 4;
  comparisons: ComparisonView[];
  crosshair: boolean;
  range: boolean;
}
const DEFAULT_INTERVALS: ChartInterval[] = ["H1", "H4", "D1"];
export function validateChartLayout(value: unknown): ChartLayoutState {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const comparisons = DEFAULT_INTERVALS.map((fallback, index): ComparisonView => {
    const raw = Array.isArray(v.comparisons) ? v.comparisons[index] : null;
    const row = raw && typeof raw === "object" ? raw : {};
    const tf = row.timeframe ?? (index === 0 ? v.timeframe : null);
    const symbol = typeof row.symbol === "string" && row.symbol.length <= 100 ? exactChartSymbol(row.symbol, "chart-analysis")?.canonicalSymbol ?? null : null;
    return { symbol, timeframe: restoreChartInterval(tf, fallback), ...(row.followPrimaryInterval === true ? {followPrimaryInterval:true} : {}) };
  });
  return { count:v.count === 2 || v.count === 4 ? v.count : 1, comparisons, crosshair:v.crosshair === true, range:v.range === true };
}

/** Display-only follow: never updates the primary or replaces a held calendar
 * interval with an apparently supported fallback. */
export function comparisonInterval(view: ComparisonView, primary?: ChartRequestedInterval): ChartRequestedInterval {
  return view.followPrimaryInterval && primary !== undefined ? primary : view.timeframe;
}
