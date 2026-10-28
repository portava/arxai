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
import { lastClosedCandleCloseMs, formatUtcClock } from "@/components/scanner/scannerChartFormat";

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
      expect(block).toContain("formatUtcClock(lastClosedCloseMs)");
      expect(block).toMatch(/last candle closed/);
    }
  });
});
