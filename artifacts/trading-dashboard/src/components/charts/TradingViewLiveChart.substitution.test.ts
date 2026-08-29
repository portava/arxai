// Live Chart — a substituted instrument must be visible, not silent.
//
// BEFORE
//   `toApprovedTvSymbol(input)` was `approvedTradingViewSymbol(input) ??
//   FALLBACK_TV_SYMBOL` with no user-visible notice, even though
//   `approvedTradingViewSymbol`'s own docstring says it returns null "so callers
//   can fall back honestly". Synthetics have no TradingView mapping, /live-chart
//   defaults to chartView="tv", and the chart-symbol bus defaults to V75 — so a
//   trader landed on Live Chart with V75 selected, saw an EURUSD chart, and the
//   trade ticket beside it was armed on V75. Nothing said the instrument had
//   been swapped. Reading the wrong instrument's price action before confirming
//   an order is a real-money error path.
//
// AFTER
//   `resolveTvSymbol` returns the substitution as data, the chart renders a
//   danger-toned banner naming both instruments and the armed ticket, the symbol
//   dropdown no longer shows the stand-in as if it were selected, and the page
//   offers ARX Native (which CAN render the requested symbol).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveTvSymbol } from "@/components/charts/TradingViewLiveChart";
import { approvedTradingViewSymbol } from "@/lib/symbolRegistry";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "..");

function code(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

describe("resolveTvSymbol reports the substitution", () => {
  it("marks a synthetic as substituted rather than silently swapping it", () => {
    // Precondition: V75 genuinely has no TradingView mapping.
    expect(approvedTradingViewSymbol("V75")).toBeNull();

    const r = resolveTvSymbol("V75");
    expect(r.substituted).toBe(true);
    expect(r.requested).toBe("V75");
    expect(r.tv).not.toBe("V75");
    expect(r.tv.length).toBeGreaterThan(0);
  });

  it("does not flag a mapped market as substituted", () => {
    const r = resolveTvSymbol("EURUSD");
    expect(r.substituted).toBe(false);
    expect(r.tv).toBe(approvedTradingViewSymbol("EURUSD"));
  });

  it("treats an unknown symbol as a substitution too", () => {
    expect(resolveTvSymbol("NOT_A_MARKET").substituted).toBe(true);
  });
});

describe("the chart surfaces the substitution", () => {
  const chart = code("components/charts/TradingViewLiveChart.tsx");

  it("no longer silently coalesces to the fallback", () => {
    expect(chart).not.toMatch(/approvedTradingViewSymbol\([^)]*\)\s*\?\?\s*FALLBACK_TV_SYMBOL/);
  });

  it("renders a substitution banner", () => {
    expect(chart).toMatch(/tv-symbol-substituted-banner/);
    expect(chart).toMatch(/has no TradingView feed/);
  });

  it("warns that the trade ticket is still armed on the requested symbol", () => {
    expect(chart).toMatch(/still armed on/);
  });

  it("does not present the stand-in market as the selected option", () => {
    expect(chart).toMatch(/substituted \? "__substituted__" : tvSymbol/);
  });
});

describe("/live-chart offers the view that can render the symbol", () => {
  const page = code("pages/live-chart.tsx");

  it("passes an escape hatch to ARX Native", () => {
    expect(page).toMatch(/onRequestNativeChart=\{\(\) => setChartView\("native"\)\}/);
  });
});
