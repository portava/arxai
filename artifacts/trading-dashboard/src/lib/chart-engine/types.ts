import type { ChartOverlay } from "@/lib/chart-overlays";

// ─────────────────────────────────────────────────────────────────────────────
// ARX Smart Chart — swappable chart-engine adapter contract (Task #373).
//
// The Smart Chart Shell (live-chart page) owns ALL chart state and intelligence.
// The actual on-screen RENDERER lives behind this adapter interface, so the
// engine can be swapped (lightweight-charts today; a licensed TradingView
// Advanced Charts engine, or another renderer, later) WITHOUT the Shell ever
// touching engine-specific code.
//
// HONESTY / SAFETY:
//  - This contract is purely a VIEW contract. No adapter may place, modify, or
//    close a trade. Trade actions stay in the gated instant-trade router.
//  - Overlays are typed as the existing `ChartOverlay` model so every engine
//    consumes the same read-only overlay shape (lines / zones / markers / P/L).
//  - Candles are pre-normalized by the Shell from the /api/chart/candles
//    contract. An adapter never fabricates bars.
// ─────────────────────────────────────────────────────────────────────────────

export type ChartEngineId = "lightweight-charts" | "tradingview-advanced";

/** A single OHLC bar, normalized to Unix SECONDS (engine-agnostic). */
export interface ChartEngineCandle {
  /** Bar open time, Unix seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Feed truth the engine needs to render honestly. Today this is just the
 * live-price affordance verdict (whether the last-value label and dashed "Last"
 * price line may be shown). Richer feed/source truth stays in the React shell as
 * badges/banners — the engine only needs to know whether it may imply a live
 * current price.
 */
export interface ChartEngineFeedState {
  /**
   * When false the engine MUST suppress live-price affordances (candlestick
   * last-value label + the dashed "Last" price line). A frozen / delayed /
   * composite feed must never look more live than it is (shared honesty rule).
   */
  livePriceAffordance: boolean;
}

export interface ChartEngineInitOptions {
  /** DOM element the engine renders into. The engine owns its contents. */
  container: HTMLElement;
  /** Chart pixel height. */
  height: number;
  /** Default visible candle count on desktop (smart initial range / reset). */
  visibleDesktop?: number;
  /** Default visible candle count on mobile (<768px). */
  visibleMobile?: number;
}

/**
 * Static capability descriptor for an engine. The Shell reads this to label the
 * active engine and to know which features are real vs. staged-but-unbuilt
 * (e.g. drawing tools / draggable orders arrive in later tasks). `available`
 * reflects whether the engine can actually be instantiated in THIS build.
 */
export interface ChartEngineCapabilities {
  id: ChartEngineId;
  label: string;
  /** True when this engine is usable in the current build (licensing/bundling). */
  available: boolean;
  candles: boolean;
  /** Horizontal price lines (entry / SL / TP / plan levels). */
  priceLines: boolean;
  /** Direction markers anchored to bars. */
  markers: boolean;
  /** Zone overlays (min/max bands). */
  zones: boolean;
  /** Price↔coordinate API for DOM overlays (e.g. floating P/L bubbles). */
  coordinateApi: boolean;
  /** User drawing tools (trendlines, rays, etc.). Staged — not built yet. */
  drawingTools: boolean;
  /** Draggable order/SL/TP handles. Staged — not built yet. */
  draggableOrders: boolean;
}

/**
 * A read-only structural line segment (detected trendline / channel rail) drawn
 * diagonally on the chart's time scale. Display-only — NEVER a trade affordance.
 * Both endpoints are real time/price anchors supplied by the Chart Intelligence
 * trendline overlay; the engine never fabricates geometry.
 */
export interface ChartStructureLine {
  /** Stable key (channel rails suffix the base id with ":rail"). */
  id: string;
  /** Earlier endpoint (Unix seconds + price). */
  start: { time: number; price: number };
  /** Later endpoint (Unix seconds + price). */
  end: { time: number; price: number };
  color: string;
  dashed: boolean;
  width: number;
}

/**
 * A read-only structural event marker (break / retest / reclaim / false-break)
 * anchored to a bar. Display-only.
 */
export interface ChartStructureMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  label: string;
}

/**
 * The renderer-agnostic engine contract. The Smart Chart Shell drives the chart
 * ONLY through these methods. lightweight-charts is the first implementation;
 * any future engine implements the same surface.
 */
export interface ChartEngineAdapter {
  readonly capabilities: ChartEngineCapabilities;

  /** Mount the engine into the container. Resets all internal render state. */
  init(options: ChartEngineInitOptions): void;
  /** Tear the engine down and release the container. Safe to call repeatedly. */
  destroy(): void;
  /** Re-measure / re-fit to the container width (driven by a ResizeObserver). */
  resize(width?: number): void;

  /** Update the live-price affordance verdict. Re-applies on the next paint. */
  setFeedState(state: ChartEngineFeedState): void;
  /** Replace the candle series. Preserves the user's zoom/pan after first fit. */
  setCandles(candles: ChartEngineCandle[]): void;
  /**
   * Draw the read-only overlay set (lines / zones / markers). `latestBarTime` is
   * the Unix-seconds time of the most recent bar (markers anchor to it); null
   * when there is no bar yet.
   */
  setOverlays(overlays: ChartOverlay[], latestBarTime: number | null): void;
  /**
   * Draw read-only structural overlays (detected trendlines / channel rails +
   * break/retest/reclaim markers) on a SEPARATE channel from `setOverlays` (which
   * owns trade-plan price lines). Pass empty arrays to clear. Display-only — never
   * a trade affordance. Optional so engines can feature-detect support.
   */
  setStructureLines?(
    lines: ChartStructureLine[],
    markers: ChartStructureMarker[],
  ): void;
  /** Restore the default visible range (last N candles). */
  resetScale(): void;
  /** Map a price to a Y pixel coordinate (for DOM overlays); null if off-scale. */
  priceToCoordinate(price: number): number | null;

  // ── Optional / staged. Present so the Shell can feature-detect support. ──────
  /** Update only the most-recent (forming) bar — for future tick streaming. */
  updateActiveCandle?(candle: ChartEngineCandle): void;
  /** Informational: the symbol currently shown (engine may relabel/no-op). */
  setSymbol?(symbol: string): void;
  /** Informational: the timeframe currently shown (engine may relabel/no-op). */
  setTimeframe?(timeframe: string): void;
  /**
   * Register a callback that fires when the user scrolls the time scale near the
   * OLDEST loaded bar (within `thresholdBars`), so the Shell can request deeper
   * history. Pass null to clear. The handler may fire repeatedly; the Shell must
   * guard against concurrent loads. View-only — fetching history places no trade.
   */
  setReachStartHandler?(handler: (() => void) | null, thresholdBars?: number): void;
}
