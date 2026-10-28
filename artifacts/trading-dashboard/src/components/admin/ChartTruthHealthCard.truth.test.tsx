// Chart Truth Health card: a check that did not run is "–" (not checked),
// never a tick; the Sym/TF and AI-usable columns say what they measure; the
// footer no longer promises that a green row is fresh live data.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { ChartTruthHealthCard } from "./ChartTruthHealthCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function row(over: Record<string, unknown>) {
  return {
    symbol: "EURUSD", displaySymbol: "EURUSD", assetClass: "forex", timeframe: "M5", candleCount: 10, source: "twelve_data",
    ohlcPass: true, aggregationPass: true, formingCandlePresent: false, mergePass: false,
    outlierSpikeCount: 0, outlierWickCount: 0, historicalPeriodShiftCount: 0, mirrorPass: true, priceAlignPass: false,
    rubyAllowed: true, status: "PARTIAL", rawAssessment: "PARTIAL", quality: "clean", reasons: [],
    mockDataAdminReason: null, newestBarTime: null, latencyMs: 5, ...over,
  };
}
function stub(rows: unknown[]) {
  const report = { generatedAt: new Date().toISOString(), cached: false, ttlSeconds: 300, ageSeconds: 0, nextRefreshInSeconds: 300,
    probeLimit: 10, symbols: ["EURUSD"], timeframes: ["M5"], rows,
    summary: { total: rows.length, clean: 0, partial: rows.length, stale: 0, degraded: 0, unavailable: 0, worstStatus: "PARTIAL" } };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, report }), { status: 200 })));
}

describe("Chart Truth Health card", () => {
  it("shows unmeasured merge and price checks as not checked, not as ticks", async () => {
    stub([row({ mergeChecked: false, priceChecked: false })]);
    render(<ChartTruthHealthCard />);
    await waitFor(() => expect(screen.getByTestId("chart-truth-merge-EURUSD-M5")).toBeTruthy());
    expect(screen.getByTestId("chart-truth-merge-EURUSD-M5").getAttribute("data-check")).toBe("not-checked");
    expect(screen.getByTestId("chart-truth-price-EURUSD-M5").getAttribute("data-check")).toBe("not-checked");
  });

  it("an older payload without the flags never shows a tick for merge or price", async () => {
    stub([row({ mergePass: true, priceAlignPass: true })]);
    render(<ChartTruthHealthCard />);
    await waitFor(() => expect(screen.getByTestId("chart-truth-merge-EURUSD-M5")).toBeTruthy());
    expect(screen.getByTestId("chart-truth-merge-EURUSD-M5").getAttribute("data-check")).toBe("not-checked");
    expect(screen.getByTestId("chart-truth-price-EURUSD-M5").getAttribute("data-check")).toBe("not-checked");
  });

  it("keeps measured results, and the copy says what each column measures", async () => {
    stub([row({ mergeChecked: true, mergePass: true, priceChecked: true, priceAlignPass: false })]);
    render(<ChartTruthHealthCard />);
    await waitFor(() => expect(screen.getByTestId("chart-truth-merge-EURUSD-M5")).toBeTruthy());
    expect(screen.getByTestId("chart-truth-merge-EURUSD-M5").getAttribute("data-check")).toBe("pass");
    expect(screen.getByTestId("chart-truth-price-EURUSD-M5").getAttribute("data-check")).toBe("fail");
    const card = screen.getByTestId("card-chart-truth-health").textContent ?? "";
    expect(card).not.toMatch(/a green row means real data is flowing, valid, and fresh/);
    expect(card).toMatch(/confirmed live/);
    expect(card).toMatch(/Sym\/TF/); expect(card).toMatch(/AI-usable/);
    expect(screen.queryByText(/^Mirror$/)).toBeNull();
  });
});
