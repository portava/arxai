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
const raw = readFileSync(join(HERE, "ScannerChartPanel.tsx"), "utf8");
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((line) => (line.trim().startsWith("//") ? "" : line))
  .join("\n");

function jsxBlock(open: string): string {
  const idx = code.indexOf(open);
  expect(idx, `${open} must exist`).toBeGreaterThan(-1);
  return code.slice(idx, code.indexOf("/>", idx) + 2);
}

describe("ScannerChartPanel — deep-history badge", () => {
  it("passes the failed back-page reason, so a failed scroll-back never reads as cached depth", () => {
    const badge = jsxBlock("<ChartHistoryBadge");
    expect(badge).toMatch(/loadError=\{deepHistory\.loadError\}/);
  });
});

describe("ScannerChartPanel — frozen-quote chip", () => {
  it("uses the scheduled-closure-aware chip, never a bare 'Market closed' on a frozen quote", () => {
    expect(code).not.toContain("formatMarketClosedLabel(");
    const idx = code.indexOf('data-testid="scanner-chart-market-closed"');
    expect(idx).toBeGreaterThan(-1);
    const chip = code.slice(code.lastIndexOf("<Badge", idx), code.indexOf("</Badge>", idx));
    expect(chip).toContain("{frozenChip.label}");
    expect(chip).toContain("title={frozenChip.title}");
    expect(code).toMatch(/frozenQuoteChip\(marketFrozen\.lastBrokerTimeMs, scheduledClosure\)/);
    expect(code).toMatch(/scheduledWeekendClosureFor\(feedAssetClass, Date\.now\(\)\)/);
  });

  it("the notice strip calls the market closed only for a scheduled closure, not for any frozen quote", () => {
    expect(code).not.toMatch(/marketClosed: truth\?\.marketClosure != null \|\| marketFrozen != null/);
    expect(code).toMatch(/marketClosed: truth\?\.marketClosure != null \|\| scheduledClosure/);
  });
});

describe("ScannerChartPanel — candle-close countdown", () => {
  it("is withdrawn while the broker keeps repeating one quote (no 'closes in' on a frozen market)", () => {
    const idx = code.indexOf("<CandleCloseCountdown");
    expect(idx).toBeGreaterThan(-1);
    const gate = code.slice(code.lastIndexOf("{", idx), idx);
    expect(gate).toMatch(/formingCloseMs != null && isLiveDisplay && marketFrozen == null/);
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
