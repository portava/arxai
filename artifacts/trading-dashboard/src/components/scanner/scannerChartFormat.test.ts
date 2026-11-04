import { describe, it, expect } from "vitest";
import {
  PRIMARY_TIMEFRAMES,
  FALLBACK_TIMEFRAME,
  coerceVisibleTimeframe,
  formatCandleCountdown,
  NEWS_MARKER_LOOKAHEAD_BARS,
  isFeedConfirmedForEventMarkers,
  inferBarSeconds,
  resolveEventMarkerSec,
  snapSecToCandle,
  CHART_TIME_AXIS_LABEL,
  CHART_TIME_AXIS_TITLE,
  formatUtcClock,
  computeCandleRemainingMs,
  candleCountdownLabel,
} from "@/components/scanner/scannerChartFormat";
import type { ChartDisplayStatus } from "@/lib/chart-display-status";

// ── Scanner chart header display helpers (Task #524) ────────────────────────
//
// These are pure display helpers extracted from ScannerChartPanel.tsx so the
// timeframe-fallback and candle-close countdown logic is locked by unit tests
// (mirrors the scannerCandleAdapter.ts pattern). Nothing here touches a data
// source, the candles/tick-stream contract, or any execution path.

describe("PRIMARY_TIMEFRAMES", () => {
  it("is exactly the nine fixed chips in order (no dropdown leftovers)", () => {
    expect(PRIMARY_TIMEFRAMES.map((t) => t.id)).toEqual([
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
      "4h",
      "8h",
      "1d",
      "1w",
    ]);
  });
});

describe("coerceVisibleTimeframe", () => {
  it("passes through every visible chip unchanged", () => {
    for (const tf of PRIMARY_TIMEFRAMES) {
      expect(coerceVisibleTimeframe(tf.id)).toBe(tf.id);
    }
  });

  it("falls back to 15m for a previously-selectable exotic timeframe", () => {
    // Values that used to be reachable via the removed "More" dropdown / month.
    for (const exotic of ["1mo", "6h", "12h", "2m", "1M", ""]) {
      expect(coerceVisibleTimeframe(exotic)).toBe(FALLBACK_TIMEFRAME);
    }
    expect(FALLBACK_TIMEFRAME).toBe("15m");
  });
});

describe("formatCandleCountdown", () => {
  it("formats intraday (1m–1h) as m:ss", () => {
    expect(formatCandleCountdown(0, "1m")).toBe("0:00");
    expect(formatCandleCountdown(5_000, "1m")).toBe("0:05");
    expect(formatCandleCountdown(65_000, "5m")).toBe("1:05");
    expect(formatCandleCountdown(599_000, "15m")).toBe("9:59");
    // 1h still uses m:ss (e.g. 59m 59s left).
    expect(formatCandleCountdown(3_599_000, "1h")).toBe("59:59");
  });

  it("formats 4h / 8h as h:mm", () => {
    expect(formatCandleCountdown(3_600_000, "4h")).toBe("1:00");
    expect(formatCandleCountdown(2 * 3_600_000 + 5 * 60_000, "8h")).toBe("2:05");
  });

  it("formats 1D / 1W as d hh:mm", () => {
    expect(formatCandleCountdown(0, "1d")).toBe("0d 00:00");
    expect(formatCandleCountdown(23 * 3_600_000 + 59 * 60_000, "1d")).toBe("0d 23:59");
    expect(
      formatCandleCountdown(3 * 86_400_000 + 4 * 3_600_000 + 2 * 60_000, "1w"),
    ).toBe("3d 04:02");
  });

  it("never returns a negative time", () => {
    expect(formatCandleCountdown(-10_000, "1m")).toBe("0:00");
    expect(formatCandleCountdown(-10_000, "1d")).toBe("0d 00:00");
  });
});

// ── Economic-event chart marker helpers (Task #628) ─────────────────────────
//
// Lock the two honesty-critical behaviors of the scanner chart's economic-event
// markers: (1) markers only render when the chart feed is CONFIRMED, and (2)
// only events inside the chart's timeframe window appear (no edge-clamping of
// out-of-range events). Both are pure helpers so they can be asserted directly.

describe("isFeedConfirmedForEventMarkers", () => {
  it("shows markers ONLY on a confirmed feed (LIVE or delayed composite)", () => {
    expect(isFeedConfirmedForEventMarkers("LIVE")).toBe(true);
    expect(isFeedConfirmedForEventMarkers("FALLBACK_COMPOSITE")).toBe(true);
  });

  it("suppresses markers on every unconfirmed feed state", () => {
    const unconfirmed: ChartDisplayStatus[] = [
      "STALE",
      "ANALYSIS_ONLY",
      "UNAVAILABLE",
    ];
    for (const status of unconfirmed) {
      expect(isFeedConfirmedForEventMarkers(status)).toBe(false);
    }
  });
});

describe("inferBarSeconds", () => {
  it("derives the bar interval from the last two candle times", () => {
    // 15m bars → 900s; 1h bars → 3600s.
    expect(inferBarSeconds([0, 900_000])).toBe(900);
    expect(inferBarSeconds([0, 900_000, 1_800_000, 5_400_000])).toBe(3600);
  });

  it("falls back to 60s when there is fewer than two candles", () => {
    expect(inferBarSeconds([])).toBe(60);
    expect(inferBarSeconds([1_000_000])).toBe(60);
  });

  it("never returns a sub-second interval", () => {
    expect(inferBarSeconds([0, 500])).toBe(1);
  });
});

describe("resolveEventMarkerSec", () => {
  // A window: history from 1000s to 2000s, look-ahead horizon to 2600s.
  const FIRST = 1000;
  const LAST = 2000;
  const WINDOW_END = 2600;

  it("places an in-history event at its true time", () => {
    expect(resolveEventMarkerSec(1500 * 1000, FIRST, LAST, WINDOW_END)).toBe(1500);
  });

  it("anchors a near-future in-window event to the right edge", () => {
    // Past the last bar but within the look-ahead horizon → pinned to LAST.
    expect(resolveEventMarkerSec(2400 * 1000, FIRST, LAST, WINDOW_END)).toBe(LAST);
  });

  it("omits events before the loaded history (no edge-clamping)", () => {
    expect(resolveEventMarkerSec(500 * 1000, FIRST, LAST, WINDOW_END)).toBeNull();
  });

  it("omits events beyond the look-ahead horizon (no edge-clamping)", () => {
    expect(resolveEventMarkerSec(9999 * 1000, FIRST, LAST, WINDOW_END)).toBeNull();
  });

  it("includes the exact window boundaries", () => {
    expect(resolveEventMarkerSec(FIRST * 1000, FIRST, LAST, WINDOW_END)).toBe(FIRST);
    expect(resolveEventMarkerSec(WINDOW_END * 1000, FIRST, LAST, WINDOW_END)).toBe(LAST);
  });

  it("returns null for an unparseable / missing event time", () => {
    expect(resolveEventMarkerSec(NaN, FIRST, LAST, WINDOW_END)).toBeNull();
  });
});

describe("NEWS_MARKER_LOOKAHEAD_BARS", () => {
  it("is a positive forward horizon", () => {
    expect(NEWS_MARKER_LOOKAHEAD_BARS).toBeGreaterThan(0);
  });
});

describe("snapSecToCandle", () => {
  // Fixed M15-style grid (900s spacing) so a marker time can only be valid if it
  // lands exactly on one of these bars.
  const BARS = [1000, 1900, 2800, 3700];

  it("snaps an off-grid time back onto the bar that contains it", () => {
    // 2400 falls between bars 1900 and 2800 → must anchor to 1900 (the open-time
    // of the bar the event occurred during), never the raw 2400.
    expect(snapSecToCandle(2400, BARS)).toBe(1900);
  });

  it("returns an exact bar time unchanged", () => {
    expect(snapSecToCandle(2800, BARS)).toBe(2800);
  });

  it("anchors a time before the first bar to the first bar", () => {
    expect(snapSecToCandle(500, BARS)).toBe(1000);
  });

  it("anchors a time past the last bar to the last bar", () => {
    expect(snapSecToCandle(99999, BARS)).toBe(3700);
  });

  it("always returns a value that exists in the bar set", () => {
    for (const t of [1000, 1234, 1899, 1900, 3699, 3700, 4000]) {
      const snapped = snapSecToCandle(t, BARS);
      expect(snapped).not.toBeNull();
      expect(BARS).toContain(snapped);
    }
  });

  it("returns null when there are no bars or the target is not finite", () => {
    expect(snapSecToCandle(1500, [])).toBeNull();
    expect(snapSecToCandle(NaN, BARS)).toBeNull();
  });

  it("guarantees every off-grid structure/aux marker time lands on a real bar", () => {
    // Structure-overlay and economic-event markers both route through
    // snapSecToCandle before reaching createSeriesMarkers. lightweight-charts'
    // candlestick colorer throws "Value is null" on repaint if a marker time is
    // not a bar that exists, so the snap must NEVER emit an off-series time —
    // regardless of how far off-grid the engine's reported event/structure time
    // is (e.g. an arbitrary break second mid-candle).
    const offGridStructureTimes = [1001, 1450, 1899, 2801, 3699, 3700, 5000];
    for (const t of offGridStructureTimes) {
      const snapped = snapSecToCandle(t, BARS);
      expect(snapped).not.toBeNull();
      expect(BARS).toContain(snapped);
    }
  });
});

// ── Chart time zone + server-clock countdown (owner screenshots 2026-10-27:
//    axis 14:00 … 16:00 with no zone for a New York viewer at 12:04 local, and a
//    "⏱0:15" chip computed against the client clock). ──
describe("chart time zone label + UTC clock", () => {
  it("one shared axis label, stated in UTC", () => {
    expect(CHART_TIME_AXIS_LABEL).toBe("Times: UTC");
    expect(CHART_TIME_AXIS_TITLE).toMatch(/UTC/);
  });

  it("formats the UTC wall clock regardless of the viewer's zone", () => {
    // 16:04Z is 12:04 in New York — the label must read the UTC hour.
    expect(formatUtcClock(Date.parse("2026-10-27T16:04:31Z"))).toBe("16:04 UTC");
    expect(formatUtcClock("2026-10-27T14:00:00.000Z")).toBe("14:00 UTC");
    expect(formatUtcClock("not a time")).toBeNull();
    expect(formatUtcClock(null)).toBeNull();
  });
});

describe("computeCandleRemainingMs — measured against the server clock", () => {
  const closeTimeMs = Date.parse("2026-10-27T16:05:00Z");
  const serverTs = Date.parse("2026-10-27T16:04:45Z"); // 15 s left on the server
  const clock = { serverTs, receivedPerf: 1_000 };

  it("a client clock 5 s fast or slow shows the same remaining time", () => {
    const fast = computeCandleRemainingMs({ closeTimeMs, clock, nowPerf: 1_000, fallbackNowMs: serverTs + 5_000 });
    const slow = computeCandleRemainingMs({ closeTimeMs, clock, nowPerf: 1_000, fallbackNowMs: serverTs - 5_000 });
    expect(fast).toBe(15_000);
    expect(slow).toBe(15_000);
    expect(candleCountdownLabel(fast, "1m")).toBe("closes in 0:15");
  });

  it("advances with monotonic elapsed time since the frame", () => {
    expect(computeCandleRemainingMs({ closeTimeMs, clock, nowPerf: 6_000, fallbackNowMs: 0 })).toBe(10_000);
  });

  it("without a server sample falls back to the client wall clock (never a fabricated offset)", () => {
    expect(computeCandleRemainingMs({ closeTimeMs, clock: null, nowPerf: 0, fallbackNowMs: serverTs + 5_000 })).toBe(10_000);
    expect(computeCandleRemainingMs({ closeTimeMs, clock: { serverTs: Number.NaN, receivedPerf: 0 }, nowPerf: 0, fallbackNowMs: serverTs })).toBe(15_000);
  });
});
