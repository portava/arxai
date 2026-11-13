import type {
  ChartEngineAdapter,
  ChartEngineCapabilities,
  ChartEngineId,
} from "./types";
import { ArxCanvasAdapter } from "./arxCanvasAdapter";
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
export { ArxCanvasAdapter } from "./arxCanvasAdapter";
export const DEFAULT_CHART_ENGINE_ID: ChartEngineId = "arx-canvas";
export const CHART_ENGINE_DESCRIPTORS: Record<
  ChartEngineId,
  ChartEngineCapabilities
> = { "arx-canvas": new ArxCanvasAdapter().capabilities };
export function createChartEngineAdapter(
  id: ChartEngineId = DEFAULT_CHART_ENGINE_ID,
): ChartEngineAdapter {
  if (id !== "arx-canvas")
    throw new Error(`Unknown chart engine: ${String(id)}`);
  return new ArxCanvasAdapter();
}
