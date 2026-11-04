// Truth regression: the scanner chart's notice strip ("Market closed · last
// session's candles" / "Stale · last-known candles") printed
// "last candle HH:MM UTC" from feedStatus.lastCandleTime. That field is the
// newest PROVIDER bar's closeTime — for a still-forming bar (a W1 bar on a
// weekend, a D1/H4 bar whose ticks stopped) a scheduled FUTURE instant, so the
// strip named a candle time that has not happened yet. The strip now shows the
// close of the newest CLOSED candle on the chart, and says it is a close time.
//
// ScannerChartPanel cannot mount headlessly (lightweight-charts canvas), so the
// helper is behaviour-tested here and the strip's wiring is locked by a source
// scan (same pattern as ScannerChartPanel.timeZone.test.ts).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lastClosedCandleCloseMs, formatUtcClock, formatUtcCandleClose } from "@/components/scanner/scannerChartFormat";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("lastClosedCandleCloseMs", () => {
  it("skips a forming bar whose scheduled close is in the future", () => {
    // Saturday 2026-10-31 10:00 UTC; the W1 bar that opened Mon 2026-10-26
    // closes Mon 2026-11-02 — a future instant.
    const now = Date.parse("2026-10-31T10:00:00Z");
    const forming = Date.parse("2026-10-26T00:00:00Z");
    const candles = [
      { time: forming - 7 * DAY, isComplete: true },
      { time: forming, isComplete: false },
    ];
    const close = lastClosedCandleCloseMs(candles, "1w", now);
    expect(close).toBe(forming);
    expect(close!).toBeLessThanOrEqual(now);
    expect(formatUtcClock(close)).toBe("00:00 UTC");
  });

  it("skips a future-closing newest bar even when the shape states no completeness", () => {
    const now = Date.parse("2026-10-28T14:07:00Z");
    const open = Date.parse("2026-10-28T14:00:00Z");
    const candles = [{ time: open - 15 * MIN }, { time: open }];
    expect(lastClosedCandleCloseMs(candles, "15m", now)).toBe(open);
  });

  it("returns the newest closed bar's close (open + one interval)", () => {
    const now = Date.parse("2026-10-28T14:07:00Z");
    const open = Date.parse("2026-10-28T13:00:00Z");
    expect(lastClosedCandleCloseMs([{ time: open, isComplete: true }], "1h", now)).toBe(open + HOUR);
  });

  it("is null when no closed bar exists or the timeframe is unknown", () => {
    const now = Date.parse("2026-10-28T14:07:00Z");
    expect(lastClosedCandleCloseMs([{ time: Date.parse("2026-10-28T14:00:00Z"), isComplete: false }], "1h", now)).toBeNull();
    expect(lastClosedCandleCloseMs([], "1h", now)).toBeNull();
    expect(lastClosedCandleCloseMs([{ time: Date.parse("2026-10-28T13:00:00Z") }], "weird", now)).toBeNull();
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (raw: string) => raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");
const panel = strip(readFileSync(join(HERE, "ScannerChartPanel.tsx"), "utf8"));

describe("ScannerChartPanel notice strip — last candle time", () => {
  it("never prints the newest provider bar's scheduled close (feedStatus.lastCandleTime)", () => {
    expect(panel).not.toContain("formatUtcClock(feedStatus.lastCandleTime)");
    expect(panel).not.toMatch(/feedStatus\?\.lastCandleTime/);
  });

  it("prints the newest CLOSED candle's close time on the market-closed and stale strips", () => {
    expect(panel).toContain("lastClosedCandleCloseMs(candles, timeframe,");
    for (const id of ["scanner-chart-status-market-closed", "scanner-chart-status-stale"]) {
      const start = panel.indexOf(`data-testid="${id}"`);
      expect(start).toBeGreaterThan(-1);
      const block = panel.slice(start, panel.indexOf("</div>", start));
      // With its date when it is not today (UTC): a bare clock reads as today.
      expect(block).toContain("formatUtcCandleClose(lastClosedCloseMs,");
      expect(block).not.toContain("formatUtcClock(lastClosedCloseMs)");
      expect(block).toMatch(/last candle closed/);
    }
  });
});

// The strip shows the newest CLOSED bar's close exactly when that bar is old
// (Market closed on a weekend, Stale). A bare "00:00 UTC" for a W1 bar that
// closed Monday, read on Saturday, implies today. The close now carries its
// date whenever it is not today (UTC).
describe("formatUtcCandleClose — the close time says which day", () => {
  const SAT = Date.parse("2026-10-31T10:00:00Z");

  it("1W on Saturday: Monday's close names Monday's date", () => {
    const forming = Date.parse("2026-10-26T00:00:00Z");
    const close = lastClosedCandleCloseMs([{ time: forming - 7 * DAY, isComplete: true }, { time: forming, isComplete: false }], "1w", SAT);
    expect(formatUtcCandleClose(close, SAT)).toBe("Mon 26 Oct 00:00 UTC");
  });

  it("1D on Saturday: Friday's bar closed at Saturday 00:00, which is today (UTC)", () => {
    const fri = Date.parse("2026-10-30T00:00:00Z");
    const close = lastClosedCandleCloseMs([{ time: fri, isComplete: true }], "1d", SAT);
    expect(close).toBe(Date.parse("2026-10-31T00:00:00Z"));
    expect(formatUtcCandleClose(close, SAT)).toBe("00:00 UTC");
  });

  it("1D on Sunday: the same close is yesterday and carries its date", () => {
    const sun = Date.parse("2026-11-01T10:00:00Z");
    expect(formatUtcCandleClose(Date.parse("2026-10-31T00:00:00Z"), sun)).toBe("Sat 31 Oct 00:00 UTC");
  });

  it("H1 mid-week Stale: a bar closed days earlier names its day", () => {
    const wed = Date.parse("2026-10-28T14:07:00Z");
    expect(formatUtcCandleClose(Date.parse("2026-10-26T22:00:00Z"), wed)).toBe("Mon 26 Oct 22:00 UTC");
  });

  it("a close in another year names the year", () => {
    const jan = Date.parse("2027-01-02T10:00:00Z");
    expect(formatUtcCandleClose(Date.parse("2026-12-31T22:00:00Z"), jan)).toBe("Thu 31 Dec 2026 22:00 UTC");
  });

  it("is null for a missing or unparseable time", () => {
    expect(formatUtcCandleClose(null, SAT)).toBeNull();
    expect(formatUtcCandleClose(Number.NaN, SAT)).toBeNull();
  });
});
