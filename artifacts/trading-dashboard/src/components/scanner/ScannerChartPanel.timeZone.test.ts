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

describe("ScannerChartPanel — time zone + countdown clock", () => {
  it("renders the shared UTC axis label beside the timeframe chips, not gated on live", () => {
    const idx = panel.indexOf('data-testid="scanner-chart-timezone"');
    expect(idx).toBeGreaterThan(-1);
    const block = panel.slice(panel.lastIndexOf("{hasCandles && (", idx), panel.indexOf("PRIMARY_TIMEFRAMES.map", idx));
    expect(block).toContain("{CHART_TIME_AXIS_LABEL}");
    expect(block).toContain("title={CHART_TIME_AXIS_TITLE}");
    expect(block).not.toMatch(/isLiveDisplay/);
  });

  it("no local, unlabelled clock strings remain on the panel or the scanner page", () => {
    expect(panel).not.toMatch(/toLocaleTimeString\(\)/);
    expect(panel).toContain("formatUtcClock(feedStatus.lastCandleTime)");
    expect(page).not.toMatch(/Last scan \{new Date\(resultTimestamp\)\.toLocaleTimeString\(\)\}/);
    expect(page).toContain("Last scan {formatUtcClock(resultTimestamp)");
  });

  it("captures the frame's server ts per accepted frame and counts down against it", () => {
    expect(panel).toMatch(/serverTs: msg\.ts,\s*receivedPerf: performance\.now\(\)/);
    expect(panel).toContain("computeCandleRemainingMs({");
    expect(panel).toContain("candleCountdownLabel(remainingMs, timeframe)");
    expect(panel).toContain("clockRef={serverClockRef}");
  });
});
