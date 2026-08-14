// Pure, unit-tested display helpers for the Scanner chart header (Task #524).
// Kept out of ScannerChartPanel.tsx (which imports lightweight-charts + the whole
// component tree) so these can be tested in isolation, mirroring the
// scannerCandleAdapter.ts pattern. NOTHING here touches data sources, the
// candles/tick-stream contract, or any execution path — it is display-only.

import type { ChartDisplayStatus } from "@/lib/chart-display-status";

export type Timeframe = { id: string; label: string };

// Fixed timeframe chips. EXACTLY these nine render as always-visible buttons, in
// this order. The backend candles contract still accepts the full 21 MT5
// timeframes via toApiTimeframe — this only constrains which chips the user can
// pick.
export const PRIMARY_TIMEFRAMES: Timeframe[] = [
  { id: "1m", label: "1m" },
  { id: "5m", label: "5m" },
  { id: "15m", label: "15m" },
  { id: "30m", label: "30m" },
  { id: "1h", label: "1h" },
  { id: "4h", label: "4h" },
  { id: "8h", label: "8h" },
  { id: "1d", label: "1D" },
  { id: "1w", label: "1W" },
];

export const FALLBACK_TIMEFRAME = "15m";
const VISIBLE_TIMEFRAME_IDS = new Set(PRIMARY_TIMEFRAMES.map((t) => t.id));

// Coerce any persisted / bus / deep-link timeframe to one of the nine visible
// chips. An unknown value (e.g. a previously-selectable exotic timeframe like
// "1mo" or "6h") falls back to FALLBACK_TIMEFRAME so the chart, the highlighted
// chip, and the shared scanner truth never disagree.
export function coerceVisibleTimeframe(raw: string): string {
  return VISIBLE_TIMEFRAME_IDS.has(raw) ? raw : FALLBACK_TIMEFRAME;
}

// Format the time remaining until the current candle closes, scaled to the
// timeframe:
//   • minute/hour intraday (1m–1h) → m:ss
//   • 4h / 8h                       → h:mm
//   • 1D / 1W                       → d hh:mm
export function formatCandleCountdown(remainingMs: number, timeframe: string): string {
  const totalSec = Math.max(0, Math.floor(remainingMs / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (timeframe === "1d" || timeframe === "1w") {
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${d}d ${pad(h)}:${pad(m)}`;
  }
  if (timeframe === "4h" || timeframe === "8h") {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}:${pad(m)}`;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${pad(s)}`;
}

// ── Economic-event chart marker helpers (Task #628) ─────────────────────────
//
// The Scanner chart can draw economic-calendar events (the same honest, real-or-
// absent Trading Economics feed the market-truth snapshot already serves) as
// vertical markers on the price time axis. These pure helpers decide WHEN a
// marker may show and WHERE it sits, so the chart-honesty + timeframe-window
// rules are locked by unit tests. They touch no data source and no execution
// path — display-only.

// Forward look-ahead (in bars) for economic-event chart markers: the marker
// window is the loaded candle history plus this many bars of the current
// timeframe, so an imminent high-impact event surfaces near the right edge while
// far-future / pre-history events stay off the chart.
export const NEWS_MARKER_LOOKAHEAD_BARS = 24;

// Economic-event markers sit ON the candle time axis, so they may only render
// when the chart's own feed is CONFIRMED — i.e. LIVE or DELAYED
// (FALLBACK_COMPOSITE). A STALE / ANALYSIS_ONLY / UNAVAILABLE feed has no
// trustworthy time axis to anchor an event onto, so the chart draws nothing
// rather than pin a marker onto an unconfirmed chart.
export function isFeedConfirmedForEventMarkers(status: ChartDisplayStatus): boolean {
  return status === "LIVE" || status === "FALLBACK_COMPOSITE";
}

// Bar interval (seconds) inferred from the last two candle times (epoch ms).
// Falls back to 60s when there aren't two candles to measure the spacing from.
export function inferBarSeconds(candleTimesMs: number[]): number {
  const n = candleTimesMs.length;
  if (n < 2) return 60;
  return Math.max(1, Math.floor((candleTimesMs[n - 1]! - candleTimesMs[n - 2]!) / 1000));
}

// Resolve where (if at all) an economic event should be marked on the chart.
// Given the loaded candle window [firstSec, lastSec] and a forward look-ahead
// horizon (windowEndSec), returns the marker time in epoch SECONDS (the
// lightweight-charts unit), or null when the event falls outside the chart's
// window (before the loaded history, or beyond the look-ahead horizon — never
// clamped onto the edges). A near-future in-window event has no candle to sit on
// yet, so it anchors to the right edge (lastSec); an in-history event sits at its
// true time.
export function resolveEventMarkerSec(
  eventMs: number,
  firstSec: number,
  lastSec: number,
  windowEndSec: number,
): number | null {
  if (!Number.isFinite(eventMs)) return null; // never place a marker without a real time
  const evSec = Math.floor(eventMs / 1000);
  if (evSec < firstSec || evSec > windowEndSec) return null;
  return Math.min(evSec, lastSec);
}

// Snap an arbitrary epoch-second onto a real candle bar present in the series.
// Canonical implementation now lives in the chart-engine boundary guard module
// (candleSanitize.ts) so the LightweightChartsAdapter can use the SAME snap
// when it re-anchors structure markers after the candle window slides — the
// re-export keeps this module the scanner-side import point (and its tests).
// Economic events land at arbitrary timestamps that almost never align to a
// fixed candle interval, so every marker is anchored to the bar whose open-time
// contains it; a marker whose time does not exactly match a loaded bar makes
// lightweight-charts' findBar() return null and the candlestick colorer throw
// "Value is null" on every repaint (SeriesBarColorer.Candlestick → ensureNotNull).
export { snapSecToCandle } from "@/lib/chart-engine/candleSanitize";
