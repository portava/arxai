import type { ChartStyle } from "./chartWorkspace";

/** ARX-owned, view-only overlay contracts. No renderer object or trading API. */
export interface ScannerOverlayHandle { dispose(): void }
export interface ScannerPriceLine {
  price: number;
  color: string;
  lineWidth: 1 | 2;
  lineStyle: "solid" | "dashed";
  axisLabelVisible: boolean;
  title: string;
}
export interface ScannerEventMarker {
  /** Epoch seconds anchored to an actual displayed bar, not milliseconds. */
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowDown" | "circle";
  text: string;
}
/** A lease on one renderer/series/context. Disposal revokes retained callbacks
 * and releases only this lease's overlays. Repeated disposal is harmless. */
export interface ScannerOverlaySurface {
  readonly container: HTMLElement;
  priceToCoordinate(price: number): number | null;
  coordinateToPrice(coordinate: number): number | null;
  createPriceLine(options: ScannerPriceLine): ScannerOverlayHandle | null;
  createMarkers(markers: readonly ScannerEventMarker[]): ScannerOverlayHandle | null;
  dispose(): void;
}
export interface ScannerChartSurface extends ScannerOverlaySurface {
  symbol: string;
  timeframe: string;
  context: string;
  style: ChartStyle;
}
