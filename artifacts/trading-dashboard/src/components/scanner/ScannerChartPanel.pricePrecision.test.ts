// Source-scan guard — the Scanner chart prints ONE price at ONE precision
// (owner screenshot [E], 2026-10-27: badge "33588.0069" then "33575.372" — a raw
// JS number frozen to the 15s poll — while the price axis showed the live tip
// "33575.37" at lightweight-charts' default 2 dp).
//
// ScannerChartPanel imports lightweight-charts, which cannot render headlessly
// here (see ScannerChartPanel.refresh-affordance.test.ts), so the contract is
// locked structurally; the pure helpers it calls are behaviour-tested in
// lib/instrumentPriceFormat.test.ts and the header's reading of the published
// tip in ScannerHeaderSummary.pricePrecision.test.tsx.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(HERE, "ScannerChartPanel.tsx"), "utf8");
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");

function badgeBlock(testId: string): string {
  const idx = code.indexOf(`data-testid="${testId}"`);
  expect(idx, `${testId} must exist`).toBeGreaterThan(-1);
  return code.slice(idx, code.indexOf("</Badge>", idx));
}

describe("ScannerChartPanel — one instrument precision, one current-price observation", () => {
  it("creates the candlestick series with the instrument priceFormat and re-applies it without a rebuild", () => {
    const create = code.slice(code.indexOf("chart.addSeries(CandlestickSeries"), code.indexOf("seriesRef.current = series"));
    expect(create).toContain("candlestickPriceFormat(pricePrecisionRef.current)");
    expect(code).toMatch(/series\.applyOptions\(\{ priceFormat \}\)/);
  });

  it("the live badge renders the shared display close at the instrument precision, never a raw number", () => {
    const live = badgeBlock("scanner-chart-last");
    expect(live).toContain("formatInstrumentPrice(shownClose.value, pricePrecision)");
    expect(live).not.toMatch(/\{lastClose\}/);
    const stale = badgeBlock("scanner-chart-last-stale");
    expect(stale).toContain("formatInstrumentPrice(lastClose, pricePrecision)");
  });

  it("the badge's close is the same tick the axis shows: published after series.update, withdrawn on frozen / poll / switch", () => {
    expect(code).toMatch(/resolveDisplayClose\(\{ tipClose: liveTip, lastClose, isLive: isLiveDisplay \}\)/);
    const update = code.indexOf("series.update({");
    const publish = code.indexOf("publishScannerTip(\n        streamTipKey,", update);
    expect(update).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(update);
    // Poll setData replaces the tip on the axis → the published tip is withdrawn.
    const setData = code.indexOf("series.setData(mapped);");
    expect(code.indexOf("publishScannerTip(tipKeyRef.current, null);", setData)).toBeGreaterThan(setData);
    // Frozen frame and stream-key switch withdraw it too.
    expect(code).toMatch(/if \(msg\.frozen \|\| !msg\.bar\) \{\s*publishScannerTip\(streamTipKey, null\);\s*return;/);
    expect(code).toMatch(/const streamTipKey = scannerTipKey\(symbol, timeframe\);\s*publishScannerTip\(streamTipKey, null\);/);
  });

  it("level / draft labels use the shared formatter, not a private magnitude rule", () => {
    expect(code).toContain("const fmt = (n: number) => formatInstrumentPrice(n, pricePrecision);");
    expect(code).not.toMatch(/sample < 10 \? 5 : sample < 1000 \? 3 : 2/);
  });
});
