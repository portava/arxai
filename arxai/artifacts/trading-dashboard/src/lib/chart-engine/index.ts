import type {
  ChartEngineAdapter,
  ChartEngineCapabilities,
  ChartEngineId,
} from "./types";
import { LightweightChartsAdapter } from "./lightweightChartsAdapter";

export type {
  ChartEngineAdapter,
  ChartEngineCandle,
  ChartEngineCapabilities,
  ChartEngineFeedState,
  ChartEngineInitOptions,
  ChartEngineId,
  ChartStructureLine,
  ChartStructureMarker,
} from "./types";
export { LightweightChartsAdapter } from "./lightweightChartsAdapter";

// The engine the Smart Chart Shell renders through by default. lightweight-charts
// v5 is the only currently-licensed/bundled engine (see
// docs/TRADINGVIEW_ADVANCED_CHARTS_LICENSING.md).
export const DEFAULT_CHART_ENGINE_ID: ChartEngineId = "lightweight-charts";

/**
 * Static descriptors for every engine the Shell knows about — used to label the
 * active engine and to advertise which are actually `available` in this build.
 * The TradingView Advanced Charts entry is intentionally `available: false`:
 * that library is gated behind a private TradingView license we do not hold, so
 * lightweight-charts v5 stays the labeled, real fallback.
 */
export const CHART_ENGINE_DESCRIPTORS: Record<ChartEngineId, ChartEngineCapabilities> = {
  "lightweight-charts": new LightweightChartsAdapter().capabilities,
  "tradingview-advanced": {
    id: "tradingview-advanced",
    label: "TradingView Advanced Charts (not licensed)",
    available: false,
    candles: true,
    priceLines: true,
    markers: true,
    zones: true,
    coordinateApi: true,
    drawingTools: true,
    draggableOrders: true,
  },
};

/**
 * Factory for a chart-engine adapter. Only `available` engines can be created;
 * requesting an unavailable engine (e.g. the unlicensed TradingView Advanced
 * Charts) throws rather than silently degrading, so a mis-wire is loud.
 */
export function createChartEngineAdapter(
  id: ChartEngineId = DEFAULT_CHART_ENGINE_ID,
): ChartEngineAdapter {
  switch (id) {
    case "lightweight-charts":
      return new LightweightChartsAdapter();
    case "tradingview-advanced":
      throw new Error(
        "TradingView Advanced Charts is not licensed/bundled in this build. " +
          "Use 'lightweight-charts' (see docs/TRADINGVIEW_ADVANCED_CHARTS_LICENSING.md).",
      );
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unknown chart engine: ${String(_exhaustive)}`);
    }
  }
}
