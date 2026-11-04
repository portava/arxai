// Pure, unit-tested display helpers for the Scanner chart header (Task #524).
// Kept out of ScannerChartPanel.tsx (which imports lightweight-charts + the whole
// component tree) so these can be tested in isolation, mirroring the
// scannerCandleAdapter.ts pattern. NOTHING here touches data sources, the
// candles/tick-stream contract, or any execution path — it is display-only.

import type { ChartDisplayStatus } from "@/lib/chart-display-status";
import { chartIntervalDisplayId, chartIntervalLimitation, parseChartInterval, restoreChartInterval } from "@/lib/chart-engine/chartIntervals";
import { candleIntervalMs } from "@workspace/domain/market";

export type Timeframe = { id: string; label: string };

// Legacy quick chips. Their presence must not limit the shared Scanner bus:
// Smart Chart offers additional supported intervals through its compact picker.
// W1/MN1 remain recognized requests with an explicit unavailable reason.
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
// Preserve every recognized interval in the shared bus. A saved unsupported
// W1/MN1 request must reach Smart Chart's limitation notice, not become M15.
export function coerceVisibleTimeframe(raw: string): string {
  return chartIntervalDisplayId(restoreChartInterval(raw));
}

export function scannerTimeframeLimitation(raw: string): string | null {
  return chartIntervalLimitation(parseChartInterval(raw));
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

// ── Chart time zone + candle-close countdown (owner screenshots 2026-10-27) ──
//
// lightweight-charts formats the time axis and crosshair from the UTC fields of
// each bar's timestamp, so the axis read 14:00 … 16:00 at 16:04 UTC for a
// viewer whose wall clock said 12:04 (New York) — with no zone stated anywhere.
// The repo's explicit-time convention is UTC (market-closed chip, ARX native
// legend, heat-card event times), so every chart states it with ONE shared
// label rather than switching the axis to local time.

/** Visible zone label rendered beside the timeframe chips on every chart. */
export const CHART_TIME_AXIS_LABEL = "Times: UTC";
export const CHART_TIME_AXIS_TITLE =
  "Chart time axis and candle times are shown in UTC (coordinated universal time), not your local time.";

/** "HH:MM UTC" for an epoch-ms / ISO time, or null when it cannot be parsed. */
export function formatUtcClock(time: number | string | null | undefined): string | null {
  if (time == null) return null;
  const ms = typeof time === "number" ? time : Date.parse(time);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * A candle close time that says which day it was: "HH:MM UTC" when it is
 * today (UTC), otherwise "Fri 30 Oct 22:00 UTC" (with the year when it is not
 * this year). A bare clock for a close days ago reads as today. Null when the
 * time cannot be parsed.
 */
export function formatUtcCandleClose(time: number | string | null | undefined, nowMs: number): string | null {
  const clock = formatUtcClock(time);
  if (clock == null) return null;
  const d = new Date(typeof time === "number" ? time : Date.parse(time as string));
  const n = new Date(nowMs);
  const sameYear = Number.isFinite(nowMs) && d.getUTCFullYear() === n.getUTCFullYear();
  if (sameYear && d.getUTCMonth() === n.getUTCMonth() && d.getUTCDate() === n.getUTCDate()) return clock;
  const day = `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
  return `${day}${sameYear ? "" : ` ${d.getUTCFullYear()}`} ${clock}`;
}

/** Suffix for a time whose UTC mapping is unverified (same words as the chart axis). */
export const SOURCE_CLOCK_SUFFIX = "source clock (UTC unverified)";

/**
 * A candle close time on the SOURCE clock: candles without original-UTC clock
 * evidence (MT5 bars stay on the broker's trade-server clock, audit H7). It is
 * never labelled UTC, and it always names its day, because whether it is
 * "today" cannot be judged against the viewer's UTC clock:
 * "Fri 30 Oct 23:00 source clock (UTC unverified)". Null when unparseable.
 */
export function formatSourceClockCandleClose(time: number | string | null | undefined, nowMs: number): string | null {
  const utc = formatUtcClock(time);
  if (utc == null) return null;
  const d = new Date(typeof time === "number" ? time : Date.parse(time as string));
  const sameYear = Number.isFinite(nowMs) && d.getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  const day = `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
  return `${day}${sameYear ? "" : ` ${d.getUTCFullYear()}`} ${utc.replace(/ UTC$/, "")} ${SOURCE_CLOCK_SUFFIX}`;
}

/** A closed bar cannot close later than now beyond this clock-skew allowance. */
const CLOSED_BAR_SKEW_MS = 5_000;

/**
 * Close time (epoch ms) of the newest CLOSED candle on the chart, or null when
 * there is none or the timeframe is unknown. Not feedStatus.lastCandleTime:
 * that is the newest provider bar's scheduled close, which for a still-forming
 * bar is a FUTURE instant. A bar the server marks forming (isComplete=false)
 * is always skipped.
 *
 * `clock` says what the bar times are measured on:
 * - "utc": the candles carry original-UTC clock evidence
 *   (chartUtcClockQualified). A bar whose open + one interval is still ahead
 *   of now is also skipped.
 * - "source": no UTC evidence (e.g. MT5 broker-server bar times). Those times
 *   cannot be compared with the viewer's clock (a broker clock ahead of UTC
 *   would make every recent close look like the future), so no bar is judged
 *   by now: only a bar the server explicitly marks closed (isComplete=true)
 *   counts, and a shape that states no completeness yields null.
 */
export function lastClosedCandleCloseMs(
  candles: ReadonlyArray<{ time: number; isComplete?: boolean }>,
  timeframe: string,
  nowMs: number,
  clock: "utc" | "source",
): number | null {
  const intervalMs = candleIntervalMs(timeframe);
  if (intervalMs == null || !Number.isFinite(nowMs)) return null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (!c || c.isComplete === false || !Number.isFinite(c.time)) continue;
    if (clock !== "utc" && c.isComplete !== true) continue;
    const closeMs = c.time + intervalMs;
    if (clock === "utc" && closeMs > nowMs + CLOSED_BAR_SKEW_MS) continue;
    return closeMs;
  }
  return null;
}

/** Server clock captured from one accepted tick-stream frame. */
export interface ServerClockSample {
  /** Server wall clock (`ts`) stamped on the frame, epoch ms. */
  serverTs: number;
  /** performance.now() when the frame was received. */
  receivedPerf: number;
}

/**
 * Time left until the forming candle closes, measured against the SERVER clock
 * (the frame's `ts` advanced by monotonic performance.now() elapsed) so a
 * client wall clock running fast/slow can neither shrink, inflate nor hide the
 * countdown. Without a server sample (older server) it falls back to the client
 * wall clock — never a fabricated offset. Residual: closeTimeMs is bucketed on
 * the provider tick epoch while `ts` is the API server clock, so provider-vs-
 * server skew is not removed, only client skew.
 */
export function computeCandleRemainingMs(args: {
  closeTimeMs: number;
  clock: ServerClockSample | null;
  nowPerf: number;
  fallbackNowMs: number;
}): number {
  const { closeTimeMs, clock, nowPerf, fallbackNowMs } = args;
  if (clock && Number.isFinite(clock.serverTs) && Number.isFinite(clock.receivedPerf) && Number.isFinite(nowPerf)) {
    return closeTimeMs - (clock.serverTs + Math.max(0, nowPerf - clock.receivedPerf));
  }
  return closeTimeMs - fallbackNowMs;
}

/** Chip text for the candle-close countdown, e.g. "closes in 0:15". */
export function candleCountdownLabel(remainingMs: number, timeframe: string): string {
  return `closes in ${formatCandleCountdown(remainingMs, timeframe)}`;
}
