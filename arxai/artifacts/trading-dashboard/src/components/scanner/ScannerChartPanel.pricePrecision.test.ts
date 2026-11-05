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
const strip = (raw: string) => raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");
const code = strip(readFileSync(join(HERE, "ScannerChartPanel.tsx"), "utf8"));
// The Scanner chart's canvas, series and tick stream belong to the shared Smart
// Chart (ARXNativeChart) that ScannerChartPanel mounts; the axis precision and
// the published live tip are locked there.
const smart = strip(readFileSync(join(HERE, "../charts/ARXNativeChart.tsx"), "utf8"));
const adapterSrc = strip(readFileSync(join(HERE, "../../lib/chart-engine/lightweightChartsAdapter.ts"), "utf8"));

function badgeBlock(testId: string): string {
  const idx = code.indexOf(`data-testid="${testId}"`);
  expect(idx, `${testId} must exist`).toBeGreaterThan(-1);
  return code.slice(idx, code.indexOf("</Badge>", idx));
}

describe("ScannerChartPanel — one instrument precision, one current-price observation", () => {
  it("creates the candlestick series with the instrument priceFormat and re-applies it without a rebuild", () => {
    // The Smart Chart hands the engine the instrument precision before every
    // data push; the engine applies it to the series' priceFormat in place
    // (behaviour: lib/chart-engine/lightweightChartsAdapter.precision.test.ts).
    const push = smart.indexOf("adapter.setDisplayPricePrecision?.(pricePrecision);");
    expect(push).toBeGreaterThan(-1);
    expect(smart.indexOf("adapter.setCandles(mergedEngineCandles);", push)).toBeGreaterThan(push);
    expect(adapterSrc).toMatch(/this\.displayPrecision \?\? candleDisplayPrecision/);
    expect(adapterSrc).toMatch(/applyOptions\(\{ priceFormat: \{ type: "price", precision/);
    // A declared server precision wins; the panel never re-formats the shared series.
    expect(smart).toMatch(/resolveDisplayPricePrecision\(\s*serverPricePrecision,/);
    expect(code).not.toMatch(/applyOptions\(\{ priceFormat/);
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
    // The panel names the key; the Smart Chart publishes the tip it applied.
    expect(code).toContain("liveTipKey={tipKey}");
    const update = smart.indexOf("adapter.updateActiveCandle({");
    const publish = smart.indexOf("publishScannerTip(\n          liveTipKeyRef.current,", update);
    expect(update).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(update);
    // Only on a live display, at the instrument precision.
    expect(smart.slice(publish, smart.indexOf(");", publish))).toMatch(/isLivePriceAffordanceRef\.current \? Number\(formatInstrumentPrice\(b\.close, pricePrecisionRef\.current\)\) : null/);
    // Poll setCandles replaces the tip on the axis → the published tip is withdrawn.
    const setData = smart.indexOf("adapter.setCandles(mergedEngineCandles);");
    expect(smart.indexOf("withdrawLiveTip();", setData)).toBeGreaterThan(setData);
    // Frozen frame and stream-key switch withdraw it too.
    expect(smart).toMatch(/if \(msg\.frozen \|\| !msg\.bar\) \{\s*setFormingCloseMs\(null\);\s*serverClockRef\.current = null;\s*withdrawLiveTip\(\);\s*return;/);
    expect(smart).toMatch(/withdrawLiveTip\(\);\s*if \(!streamEnabled \|\| !tickSource\) return;/);
  });

  it("level / draft labels use the shared formatter, not a private magnitude rule", () => {
    expect(code).toContain("const fmt = (n: number) => formatInstrumentPrice(n, pricePrecision);");
    expect(code).not.toMatch(/sample < 10 \? 5 : sample < 1000 \? 3 : 2/);
  });
});
