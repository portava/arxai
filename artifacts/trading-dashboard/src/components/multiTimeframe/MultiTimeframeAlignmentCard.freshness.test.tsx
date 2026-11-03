// Multi-timeframe card: the server marks a report DATA_NOT_CURRENT when any
// timeframe's newest bar is stale or untimestamped (a weekend series, a stalled
// feed). The card must give that label its own style, must not show the score
// measured on old bars as the current alignment or a bias, and every timeframe
// tile must say how old its newest bar is (or that it was not recorded).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MultiTimeframeAlignmentCard, type MultiTimeframeReport } from "./MultiTimeframeAlignmentCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Fresh = "CURRENT" | "STALE" | "UNKNOWN";
function snap(trend: "UP" | "DOWN" | "SIDEWAYS", newestBarTime: string | null | undefined, freshness: Fresh | undefined) {
  const s: Record<string, unknown> = { trend, strength: 55, slope: 0.1, fastSma: 1.1, slowSma: 1.09, candlesUsed: 120 };
  if (newestBarTime !== undefined) s.newestBarTime = newestBarTime;
  if (freshness !== undefined) s.freshness = freshness;
  return s as MultiTimeframeReport["lowerTrend"];
}

const WARNING = "Not a current read: H4 newest bar opened Fri 20:00 UTC (38 h old). On these bars the timeframes showed strong bullish alignment (score 82/100), but the market may be closed or the feed stalled, so no bias is given.";

function report(over: Partial<MultiTimeframeReport>): MultiTimeframeReport {
  return {
    id: 1, symbol: "EURUSD",
    lowerTimeframe: "M5", middleTimeframe: "H1", higherTimeframe: "H4",
    lowerTrend: snap("UP", "2026-10-24T20:55:00.000Z", "STALE"),
    middleTrend: snap("UP", "2026-10-24T20:00:00.000Z", "STALE"),
    higherTrend: snap("UP", "2026-10-24T20:00:00.000Z", "STALE"),
    alignmentScore: 82, alignmentLabel: "DATA_NOT_CURRENT", conflictWarning: WARNING, bestBias: "NEUTRAL",
    aiSummary: "EURUSD: data is not current — M5 UP (55) as of Sat 20:55 UTC. No trend, alignment or bias is reported as current.",
    createdAt: "2026-10-25T10:00:00.000Z",
    ...over,
  };
}

function renderWith(r: MultiTimeframeReport) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(r), { status: 200 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MultiTimeframeAlignmentCard symbol="EURUSD" />
    </QueryClientProvider>,
  );
}

describe("MultiTimeframeAlignmentCard data freshness", () => {
  it("a DATA_NOT_CURRENT report has a styled label and no current score or bias", async () => {
    renderWith(report({}));
    const block = await screen.findByTestId("mtf-not-current");
    const badge = screen.getByTestId("mtf-label");
    expect(badge.textContent).toBe("DATA NOT CURRENT");
    expect(badge.className).not.toMatch(/undefined/);
    expect(badge.className).toMatch(/bg-/);
    expect(block.textContent).toMatch(/Alignment not current/);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Alignment\s*82\/100/);
    expect(text).not.toMatch(/Best bias/);
    expect(text).not.toMatch(/Suggested bias/);
    expect(text).not.toMatch(/is in uptrend/);
    expect(text).toContain(WARNING);
  });

  it("each timeframe tile names its newest bar time and whether it is current", async () => {
    renderWith(report({
      lowerTrend: snap("UP", "2026-10-25T09:55:00.000Z", "CURRENT"),
      higherTrend: snap("UP", null, "UNKNOWN"),
    }));
    const times = await screen.findAllByTestId("mtf-bar-time");
    expect(times.map((e) => e.textContent)).toEqual([
      "newest bar Sun 09:55 UTC · current",
      "newest bar Sat 20:00 UTC · stale",
      "bars carried no time · age not checked",
    ]);
  });

  it("a measured report's tiles also say when their newest bar opened", async () => {
    const fresh = (t: string) => snap("UP", t, "CURRENT");
    renderWith(report({
      lowerTrend: fresh("2026-10-28T09:55:00.000Z"),
      middleTrend: fresh("2026-10-28T09:00:00.000Z"),
      higherTrend: fresh("2026-10-28T08:00:00.000Z"),
      alignmentScore: 82, alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
    }));
    const times = await screen.findAllByTestId("mtf-bar-time");
    expect(times.map((e) => e.textContent)).toEqual([
      "newest bar Wed 09:55 UTC · current",
      "newest bar Wed 09:00 UTC · current",
      "newest bar Wed 08:00 UTC · current",
    ]);
    expect(screen.queryByTestId("mtf-not-current")).toBeNull();
    expect(screen.queryByTestId("mtf-legacy-freshness")).toBeNull();
  });

  it("the client downgrades a report whose label is current but a timeframe is stale", async () => {
    renderWith(report({
      middleTrend: snap("UP", "2026-10-24T20:00:00.000Z", "STALE"),
      lowerTrend: snap("UP", "2026-10-28T09:55:00.000Z", "CURRENT"),
      higherTrend: snap("UP", "2026-10-28T08:00:00.000Z", "CURRENT"),
      alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
    }));
    await screen.findByTestId("mtf-not-current");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Best bias/);
    expect(text).not.toMatch(/Alignment\s*82\/100/);
    expect(text).toMatch(/H1 newest bar is not current/);
  });

  it("an older report without bar times says their age was not recorded", async () => {
    renderWith(report({
      lowerTrend: snap("UP", undefined, undefined),
      middleTrend: snap("UP", undefined, undefined),
      higherTrend: snap("UP", undefined, undefined),
      alignmentLabel: "STRONG_BULLISH_ALIGNMENT", conflictWarning: null, bestBias: "BUY",
    }));
    const note = await screen.findByTestId("mtf-legacy-freshness");
    expect(note.textContent).toMatch(/stored before bar times were recorded/);
    const times = screen.getAllByTestId("mtf-bar-time");
    expect(times.map((e) => e.textContent)).toEqual([
      "bar time not recorded", "bar time not recorded", "bar time not recorded",
    ]);
  });
});
