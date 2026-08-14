// ChartOverlay — Level 4 trade-overlay FOUNDATION contract.
//
// A feed-agnostic description of something to draw ON TOP of an ARXNativeChart:
// a horizontal price line, a price zone, or an anchored marker. Overlays are
// PURE VISUALIZATION — they carry no execution capability and the renderer
// never places, modifies, or closes a trade. Trade actions always route through
// the existing gated instant-trade path (executeInstantTrade, source:"chart").
//
// This contract is intentionally generic so Level 5 (Ruby / scanner / agent
// overlays) can reuse the same renderer without changing ARXNativeChart: a
// signal zone, an AI target, or a risk band are all just ChartOverlay rows with
// a different `source`/`severity`. Level 4 only emits `source:"position"` and
// `source:"pending"` overlays, built from the existing per-user live-position
// source.

export type ChartOverlayType = "line" | "zone" | "marker";

/** Visual intent. Maps to a default colour; an overlay may override via `color`. */
export type ChartOverlaySeverity =
  | "info" // entries, neutral references
  | "success" // take-profit / favourable
  | "danger" // stop-loss / invalidation
  | "warning" // caution (pending, degraded)
  | "neutral"; // marks, generic

/**
 * Where the overlay originated. Level 4 uses position/pending only. Level 6
 * (Task #374) adds "preview" — an AI/Ruby SETUP DRAWING (entry/SL/TP, risk and
 * reward zones, invalidation). A "preview" overlay is a visual reasoning aid
 * ONLY: it carries no execution capability and never becomes an order.
 */
export type ChartOverlaySource =
  | "position"
  | "pending"
  | "plan"
  | "signal"
  | "ruby"
  | "agent"
  | "preview";

export type ChartOverlayLineStyle = "solid" | "dashed";

export type ChartOverlayMarkerSide = "BUY" | "SELL";

export interface ChartOverlay {
  /** Stable per-overlay id (used as React key + diff key). */
  id: string;
  type: ChartOverlayType;
  /** Symbol this overlay belongs to (bare/normalised by the producer). */
  symbol: string;
  /** Optional timeframe scoping — when set, render only on a matching chart. */
  timeframe?: string;

  /** line / marker anchor price. */
  price?: number | null;
  /** zone bounds (inclusive). */
  priceMin?: number | null;
  priceMax?: number | null;

  /** Optional time anchor (unix seconds). marker falls back to latest bar. */
  startTime?: number | null;
  endTime?: number | null;

  /** Short human label drawn on the axis / marker. */
  label: string;
  severity?: ChartOverlaySeverity;
  source: ChartOverlaySource;
  /** 0..1 confidence, when known (drives opacity / future styling). */
  confidence?: number | null;

  /** Explicit colour override (hex). Falls back to severity colour. */
  color?: string;
  /** line/zone-border style. */
  style?: ChartOverlayLineStyle;
  lineWidth?: number;

  /** marker-only directional hint. */
  marker?: { side: ChartOverlayMarkerSide };

  /** Free-form producer metadata (brokerTicket, pnl, side, mode, …). */
  metadata?: Record<string, unknown>;
}

const SEVERITY_COLORS: Record<ChartOverlaySeverity, string> = {
  info: "#3b82f6",
  success: "#10b981",
  danger: "#ef4444",
  warning: "#f59e0b",
  neutral: "#a1a1aa",
};

/** Resolve the draw colour for an overlay (explicit override wins). */
export function overlayColor(o: Pick<ChartOverlay, "color" | "severity">): string {
  if (o.color) return o.color;
  return SEVERITY_COLORS[o.severity ?? "neutral"];
}

/** Read a finite number off `metadata`, else null. Tolerates unknown shapes. */
export function overlayMetaNumber(
  o: ChartOverlay,
  key: string,
): number | null {
  const v = o.metadata?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Read a string off `metadata`, else null. */
export function overlayMetaString(o: ChartOverlay, key: string): string | null {
  const v = o.metadata?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
