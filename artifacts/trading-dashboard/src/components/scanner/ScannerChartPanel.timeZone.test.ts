// Source-scan guard — the Scanner chart states its time zone and measures the
// candle-close countdown against the server clock (owner screenshot [E],
// 2026-10-27: axis 14:00 … 16:00 with no zone for a New York viewer at 12:04
// local; "⏱0:15" computed from the client clock). ScannerChartPanel cannot
// mount headlessly (lightweight-charts canvas), so the wiring is locked here
// and the pure helpers are behaviour-tested in scannerChartFormat.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const strip = (raw: string) => raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");
const panel = strip(readFileSync(join(HERE, "ScannerChartPanel.tsx"), "utf8"));
const page = strip(readFileSync(join(HERE, "../../pages/market-scanner.tsx"), "utf8"));
// The Scanner chart's timeframe chips, tick stream and countdown belong to the
// shared Smart Chart (ARXNativeChart) that ScannerChartPanel mounts.
const smart = strip(readFileSync(join(HERE, "../charts/ARXNativeChart.tsx"), "utf8"));
const countdown = strip(readFileSync(join(HERE, "../charts/CandleCloseCountdown.tsx"), "utf8"));

describe("ScannerChartPanel — time zone + countdown clock", () => {
  it("renders the shared UTC axis label beside the timeframe chips, not gated on live", () => {
    expect(panel).toContain("<ARXNativeChart");
    const controls = smart.indexOf("const timeframeControls = (");
    const idx = smart.indexOf('data-testid="arx-native-timezone"', controls);
    expect(controls).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(controls);
    const block = smart.slice(smart.lastIndexOf("{hasCandles && (", idx), smart.indexOf("</span>", idx));
    expect(block).toContain("{timeAxisLabel}");
    expect(block).toContain("title={timeAxisTitle}");
    expect(block).not.toMatch(/isLivePriceAffordance|isLiveDisplay/);
    // The UTC wording is the shared label; it is stated only for candles with
    // original-UTC clock evidence (ARXNativeChart.tick-stream.test.tsx).
    expect(smart).toMatch(/resolveTimeZone\(displayZone\) === "UTC"\s*\?\s*CHART_TIME_AXIS_LABEL/);
    expect(smart).toMatch(/resolveTimeZone\(displayZone\) === "UTC"\s*\?\s*CHART_TIME_AXIS_TITLE/);
  });

  it("no local, unlabelled clock strings remain on the panel or the scanner page", () => {
    expect(panel).not.toMatch(/toLocaleTimeString\(\)/);
    // The strip's last-candle note is a UTC clock (with its date when not
    // today) of the newest CLOSED candle (ScannerChartPanel.lastClosedCandle.test.ts
    // locks why it is not lastCandleTime and why it carries a date).
    expect(panel).toContain("formatUtcCandleClose(lastClosedCloseMs,");
    expect(page).not.toMatch(/Last scan \{new Date\(resultTimestamp\)\.toLocaleTimeString\(\)\}/);
    expect(page).toContain("Last scan {formatUtcClock(resultTimestamp)");
  });

  it("captures the frame's server ts per accepted frame and counts down against it", () => {
    expect(smart).toMatch(/serverTs: msg\.ts,\s*receivedPerf: performance\.now\(\)/);
    expect(countdown).toContain("computeCandleRemainingMs({");
    expect(countdown).toContain("candleCountdownLabel(remainingMs, timeframe)");
    expect(smart).toContain("clockRef={serverClockRef}");
  });
});
