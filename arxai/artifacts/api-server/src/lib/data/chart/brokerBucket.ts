// Broker-grid bar buckets (chart forming tip).
//
// MT5 bars open on the BROKER's calendar: a D1 bar on a UTC+2 server opens at
// 00:00 broker time = 22:00 UTC the day before. Ingest converts bar and tick
// stamps to UTC with the bridge's measured clock offset (brokerClockOffset.ts),
// so the stored bars sit on the broker grid expressed in UTC. A forming tip
// bucketed on the epoch-UTC grid (floor(t / interval)) therefore opens at
// 00:00 UTC on D1 — two hours after the real bar — and the chart appended it
// as a second bar for the same session. W1 epoch buckets start on a Thursday
// and MN1 used fixed 31-day buckets, so neither ever matched a broker bar.
//
// One helper buckets every timeframe on the broker grid:
//   - intraday and D1: floor((t + off) / interval) * interval − off
//   - W1: broker-calendar Sunday 00:00 (MT5 stamps weekly bars on the Sunday
//     that starts the trading week, server time)
//   - MN1: broker-calendar 1st of the month 00:00
// `brokerOffsetMs` is broker − UTC (the brokerClockOffset convention). With an
// offset of 0 (unknown offset, or a UTC venue such as Deriv) intraday and D1
// buckets are exactly the old epoch buckets.

import { timeframeMs, type ChartTimeframe } from "./timeframes.js";

const DAY_MS = 24 * 60 * 60_000;

function safeOffset(brokerOffsetMs: number | null | undefined): number {
  return typeof brokerOffsetMs === "number" && Number.isFinite(brokerOffsetMs) ? brokerOffsetMs : 0;
}

/** Open time (UTC ms) of the broker-grid bar that contains `tUtcMs`. */
export function brokerBucketOpenMs(
  tUtcMs: number,
  tf: ChartTimeframe,
  brokerOffsetMs: number | null | undefined = 0,
): number {
  const off = safeOffset(brokerOffsetMs);
  const local = tUtcMs + off; // the broker's wall clock, read as if it were UTC
  if (tf === "W1") {
    const day = Math.floor(local / DAY_MS);
    // 1970-01-01 (day 0) was a Thursday; days since the preceding Sunday:
    const sinceSunday = (((day + 4) % 7) + 7) % 7;
    return (day - sinceSunday) * DAY_MS - off;
  }
  if (tf === "MN1") {
    const d = new Date(local);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - off;
  }
  const iv = timeframeMs(tf);
  return Math.floor(local / iv) * iv - off;
}

/** Close time (UTC ms) of that bar: the open of the next broker-grid bar. */
export function brokerBucketCloseMs(
  tUtcMs: number,
  tf: ChartTimeframe,
  brokerOffsetMs: number | null | undefined = 0,
): number {
  const open = brokerBucketOpenMs(tUtcMs, tf, brokerOffsetMs);
  if (tf === "MN1") {
    const off = safeOffset(brokerOffsetMs);
    const d = new Date(open + off);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - off;
  }
  return open + timeframeMs(tf);
}

/** True when `openMs` is the open of a broker-grid bar for this timeframe. */
export function isBrokerBucketAligned(
  openMs: number,
  tf: ChartTimeframe,
  brokerOffsetMs: number | null | undefined = 0,
): boolean {
  return brokerBucketOpenMs(openMs, tf, brokerOffsetMs) === openMs;
}
