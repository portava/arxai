import type {
  ChartEngineAdapter,
  ChartEngineCapabilities,
  ChartEngineId,
} from "./types";
import { NativeChartsAdapter } from "./nativeChartsAdapter";

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
export { NativeChartsAdapter } from "./nativeChartsAdapter";

// App consumers use only ARX's renderer. Legacy comparisons have a separate
// offline entry (./comparison) so they cannot add an engine to the app bundle.
// This source default does not claim deployment or competitor parity.
export const DEFAULT_CHART_ENGINE_ID: ChartEngineId = "arx-native";

// Descriptors describe availability in the app, not the offline comparison tool.
export const CHART_ENGINE_DESCRIPTORS: Record<ChartEngineId, ChartEngineCapabilities> = {
  "arx-native": new NativeChartsAdapter().capabilities,
  "lightweight-charts": {
    id: "lightweight-charts", label: "Legacy renderer (offline comparison only)",
    available: false, candles: false, priceLines: false, markers: false,
    zones: false, coordinateApi: false, drawingTools: false, draggableOrders: false,
  },
  "tradingview-advanced": {
    id: "tradingview-advanced",
    label: "TradingView Advanced Charts (not licensed)",
    available: false,
    candles: false,
    priceLines: false,
    markers: false,
    zones: false,
    coordinateApi: false,
    drawingTools: false,
    draggableOrders: false,
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
    case "arx-native":
      return new NativeChartsAdapter();
    case "lightweight-charts":
      throw new Error("Legacy renderer is available only through the offline comparison entry.");
    case "tradingview-advanced":
      throw new Error(
        "TradingView Advanced Charts is not licensed/bundled in this build. " +
          "Use the ARX native renderer.",
      );
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unknown chart engine: ${String(_exhaustive)}`);
    }
  }
}
