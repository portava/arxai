// Source-scan guard — the Scanner chart's chips describe what actually
// happened, using the same props and helpers as the ARX Native chart.
//
// ScannerChartPanel imports lightweight-charts, which cannot render headlessly
// here (see ScannerChartPanel.refresh-affordance.test.ts), so the wiring is
// locked structurally; the shared chips themselves are behaviour-tested in
// components/charts/*.test.tsx.

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
// On this line the Scanner chart's canvas, tick stream, frozen-quote chip,
// candle-close countdown and deep-history badge are the shared Smart Chart's
// (ARXNativeChart, mounted by ScannerChartPanel); the same contracts are
// locked there.
const smart = strip(readFileSync(join(HERE, "../charts/ARXNativeChart.tsx"), "utf8"));

function jsxBlock(open: string): string {
  const idx = code.indexOf(open);
  expect(idx, `${open} must exist`).toBeGreaterThan(-1);
  return code.slice(idx, code.indexOf("/>", idx) + 2);
}

describe("ScannerChartPanel — deep-history badge", () => {
  it("passes the failed back-page reason, so a failed scroll-back never reads as cached depth", () => {
    expect(code).toContain("<ARXNativeChart");
    const idx = smart.indexOf("<ChartHistoryBadge");
    expect(idx).toBeGreaterThan(-1);
    const badge = smart.slice(idx, smart.indexOf("/>", idx) + 2);
    expect(badge).toMatch(/loadError=\{deepHistory\.loadError\}/);
    // The panel draws no second history badge that could omit the reason.
    if (code.includes("<ChartHistoryBadge")) expect(jsxBlock("<ChartHistoryBadge")).toMatch(/loadError=\{deepHistory\.loadError\}/);
  });
});

describe("ScannerChartPanel — frozen-quote chip", () => {
  it("uses the scheduled-closure-aware chip, never a bare 'Market closed' on a frozen quote", () => {
    expect(code).not.toContain("formatMarketClosedLabel(");
    expect(smart).not.toContain("formatMarketClosedLabel(");
    const idx = smart.indexOf('data-testid="arx-native-market-closed"');
    expect(idx).toBeGreaterThan(-1);
    const chip = smart.slice(smart.lastIndexOf("<Badge", idx), smart.indexOf("</Badge>", idx));
    expect(chip).toContain("{frozenChip.label}");
    expect(chip).toContain("title={frozenChip.title}");
    expect(smart).toMatch(/frozenQuoteChip\(marketFrozen\.lastBrokerTimeMs, scheduledClosure\)/);
    expect(smart).toMatch(/scheduledWeekendClosureFor\(data\?\.feedStatus\?\.assetClass \?\? null, Date\.now\(\)\)/);
    // The panel's own strip reads the same stream verdict, scheduled-closure aware.
    expect(code).toContain("onMarketFrozenChange={setMarketFrozen}");
    expect(code).toMatch(/scheduledWeekendClosureFor\(feedAssetClass, Date\.now\(\)\)/);
  });

  it("the notice strip calls the market closed only for a scheduled closure, not for any frozen quote", () => {
    expect(code).not.toMatch(/marketClosed: truth\?\.marketClosure != null \|\| marketFrozen != null/);
    expect(code).toMatch(/marketClosed: truth\?\.marketClosure != null \|\| scheduledClosure/);
  });
});

describe("ScannerChartPanel — candle-close countdown", () => {
  it("is withdrawn while the broker keeps repeating one quote (no 'closes in' on a frozen market)", () => {
    const idx = smart.indexOf("<CandleCloseCountdown");
    expect(idx).toBeGreaterThan(-1);
    const gate = smart.slice(smart.lastIndexOf("{", idx), idx);
    expect(gate).toMatch(/formingCloseMs != null && isLivePriceAffordance && !marketFrozen/);
    // The panel mounts no ungated countdown of its own.
    expect(code).not.toContain("<CandleCloseCountdown");
  });
});

describe("ScannerChartPanel — your positions and drafts", () => {
  it("a failed positions/drafts load is said out loud, never shown as 'no positions'", () => {
    const load = code.slice(code.indexOf("const loadOwned = async"), code.indexOf("void loadOwned();"));
    expect(load).toMatch(/setOwnedLoadFailed\(posRes == null \|\| penRes == null\)/);
    expect(load).toMatch(/catch \{[\s\S]*setOwnedLoadFailed\(true\)/);
    const idx = code.indexOf('data-testid="scanner-chart-owned-unavailable"');
    expect(idx).toBeGreaterThan(-1);
    expect(code.slice(code.lastIndexOf("{ownedLoadFailed", idx), idx)).toContain("ownedLoadFailed &&");
  });
});

describe("ScannerChartPanel — header price while the quote is frozen", () => {
  it("a frozen broker quote is shown as last-known, never as a plain current price", () => {
    const live = code.slice(code.lastIndexOf("{", code.indexOf('data-testid="scanner-chart-last"')), code.indexOf('data-testid="scanner-chart-last"'));
    expect(live).toMatch(/isLiveDisplay && marketFrozen == null/);
    const stale = code.slice(code.lastIndexOf("{", code.indexOf('data-testid="scanner-chart-last-stale"')), code.indexOf('data-testid="scanner-chart-last-stale"'));
    expect(stale).toMatch(/\(!isLiveDisplay \|\| marketFrozen != null\)/);
  });
});
