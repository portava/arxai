// ── Chart feed-status truth contract (shared) ───────────────────────────────
//
// Single source of truth for HOW honest a chart must be about its own data
// feed. Extracted from the Scanner chart (Task #347) so EVERY chart surface in
// the app resolves "live vs delayed vs stale vs analysis-only vs unavailable"
// identically and can never show a more-live state than the feed actually is
// (Task #349).
//
// HONESTY: we never upgrade the backend's own verdict. quality / isLive / stale
// / source / aiUsable come from the GET /api/chart/candles feedStatus contract;
// this module only maps them onto a safe display state. Anything not positively
// LIVE (clean + isLive) must not render as LIVE.

// Mirrors the ChartFeedStatus shape returned by GET /api/chart/candles.
export type FeedStatus = {
  isLive: boolean;
  stale: boolean;
  quality: "clean" | "delayed" | "stale" | "partial" | "invalid" | "empty" | "unavailable";
  source: string | null;
  aiUsable: boolean;
  warning: string | null;
  message: string;
  lastCandleTime: string | null;
};

export type ChartDisplayStatus =
  | "LIVE"
  | "FALLBACK_COMPOSITE"
  | "STALE"
  | "ANALYSIS_ONLY"
  | "UNAVAILABLE";

// Broker-native feed sources. Any other non-null source is a third-party /
// composite provider (TwelveData, Polygon, AlphaVantage, …) routed through the
// composite chain — never a broker-native live tick.
export const BROKER_NATIVE_SOURCES = new Set(["mt5_broker", "mt5"]);

export function isCompositeSource(source: string | null): boolean {
  if (!source) return false;
  return !BROKER_NATIVE_SOURCES.has(source.toLowerCase());
}

// Safest-state-wins resolver: UNAVAILABLE > ANALYSIS_ONLY > STALE > FALLBACK_COMPOSITE > LIVE.
// Anything not positively LIVE (clean + isLive) must not render as LIVE.
export function resolveDisplayStatus(fs: FeedStatus | null, hasCandles: boolean): ChartDisplayStatus {
  if (!fs) return hasCandles ? "ANALYSIS_ONLY" : "UNAVAILABLE";
  const { quality, isLive, stale, source, aiUsable } = fs;
  if (quality === "empty" || quality === "unavailable") return "UNAVAILABLE";
  if (quality === "invalid" || quality === "partial") return "ANALYSIS_ONLY";
  if (quality === "stale" || stale) return "STALE";
  if (quality === "delayed") return "FALLBACK_COMPOSITE";
  if (quality === "clean" && isLive) return "LIVE";
  // Not positively LIVE. Third-party/composite candles that aren't AI-usable are
  // delayed composite data → FALLBACK_COMPOSITE (badge "Delayed market data");
  // any other not-LIVE shape degrades to the safer ANALYSIS_ONLY.
  if (!isLive && !aiUsable && isCompositeSource(source)) return "FALLBACK_COMPOSITE";
  return "ANALYSIS_ONLY";
}

// Enforce header agreement: the chart must never show a more-live state than
// the header. When the header reports feed unavailable (ok === false), cap
// the chart at ANALYSIS_ONLY regardless of what feedStatus says.
export function applyHeaderCap(status: ChartDisplayStatus, headerOk: boolean | null): ChartDisplayStatus {
  if (headerOk === false && (status === "LIVE" || status === "FALLBACK_COMPOSITE" || status === "STALE")) {
    return "ANALYSIS_ONLY";
  }
  return status;
}

// True only when the chart may render a live-price affordance (the latest-price
// line / last-value label / a "live" price badge). Every non-LIVE state must
// suppress it so a frozen or delayed feed never masquerades as a live tick.
export function isLivePriceDisplay(status: ChartDisplayStatus): boolean {
  return status === "LIVE";
}
