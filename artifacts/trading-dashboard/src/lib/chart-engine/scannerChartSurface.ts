import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import type { ChartStyle } from "./chartWorkspace";

/** Temporary view-only bridge for Scanner's existing owned-position, annotation
 * and event overlays. The Smart Chart remains the only owner of candle writes,
 * stream reconciliation, navigation and chart/series lifetime. Never execute
 * orders or replace series data through this bridge. A null callback revokes it
 * before a context/style change; consumers must release their own overlays. */
export interface ScannerChartSurface {
  chart: IChartApi;
  series: ISeriesApi<SeriesType>;
  container: HTMLElement;
  symbol: string;
  timeframe: string;
  context: string;
  style: ChartStyle;
}
