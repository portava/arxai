import type {
  ChartEngineAdapter,
  ChartEngineCapabilities,
  ChartEngineId,
} from "./types";
import { LightweightChartsAdapter } from "./lightweightChartsAdapter";
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
export { LightweightChartsAdapter } from "./lightweightChartsAdapter";
export { NativeChartsAdapter } from "./nativeChartsAdapter";

// Ordinary app consumers share ARX's own renderer. The legacy adapter remains
// explicitly selectable for comparisons; it is never a silent fallback.
// This source default does not claim deployment or competitor parity.
export const DEFAULT_CHART_ENGINE_ID: ChartEngineId = "arx-native";

/**
 * Static descriptors for every engine the Shell knows about — used to label the
 * active engine and to advertise which are actually `available` in this build.
 * The TradingView Advanced Charts entry is intentionally `available: false`:
 * that library is gated behind a private TradingView license we do not hold, so
 * the explicit legacy adapter stays accurately attributed when selected.
 */
export const CHART_ENGINE_DESCRIPTORS: Record<ChartEngineId, ChartEngineCapabilities> = {
  "arx-native": new NativeChartsAdapter().capabilities,
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
    case "arx-native":
      return new NativeChartsAdapter();
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
