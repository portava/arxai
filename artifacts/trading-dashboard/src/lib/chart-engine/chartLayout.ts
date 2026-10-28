import { resolveSymbol } from "@/lib/symbolRegistry";

export const CHART_LAYOUT_KEY = "arx.chart.layout.v2";
export const CHART_INTERVALS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
export type ChartInterval = typeof CHART_INTERVALS[number];
export interface ComparisonView { symbol: string | null; timeframe: ChartInterval }
export interface ChartLayoutState {
  count: 1 | 2 | 4;
  comparisons: ComparisonView[];
  crosshair: boolean;
  range: boolean;
}
export function isChartInterval(value: unknown): value is ChartInterval { return CHART_INTERVALS.includes(value as ChartInterval); }
const DEFAULT_INTERVALS: ChartInterval[] = ["H1", "H4", "D1"];
export function validateChartLayout(value: unknown): ChartLayoutState {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const comparisons = DEFAULT_INTERVALS.map((fallback, index): ComparisonView => {
    const raw = Array.isArray(v.comparisons) ? v.comparisons[index] : null;
    const row = raw && typeof raw === "object" ? raw : {};
    const tf = row.timeframe ?? (index === 0 ? v.timeframe : null);
    const symbol = typeof row.symbol === "string" && row.symbol.length <= 100 ? resolveSymbol(row.symbol)?.canonicalSymbol ?? null : null;
    return { symbol, timeframe: isChartInterval(tf) ? tf : fallback };
  });
  return { count:v.count === 2 || v.count === 4 ? v.count : 1, comparisons, crosshair:v.crosshair === true, range:v.range === true };
}
