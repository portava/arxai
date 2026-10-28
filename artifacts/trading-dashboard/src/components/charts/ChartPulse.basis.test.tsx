// Chart Pulse feed chip — it must say which feed basis it grades
// (truth upgrade, 2026-10-28).
//
// The Smart Chart header chip grades the DISPLAY feed (closed bars plus the
// live forming tip, /api/chart/candles with includeFormingTip=true, capped by
// the shared scanner truth). Chart Pulse grades state.truthState from
// /me/chart/intelligence, which the server builds over CLOSED bars only
// (getChartCandles(..., includeFormingTip=false)) with its own short cache.
// Both are honest about their own input, so they can legitimately disagree on
// the same page — "Stale" in the header, "Clean" in the Pulse — and before this
// fix nothing told the reader the two chips describe different things.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { ChartFeedStatus, ChartIntelligenceResponse } from "@workspace/api-client-react";
import { ChartPulse } from "./ChartPulse";
import { FeedConfidenceBadge } from "./FeedConfidenceBadge";

afterEach(() => cleanup());

type ChartState = ChartIntelligenceResponse["state"];

function feed(over: Partial<ChartFeedStatus> = {}): ChartFeedStatus {
  return {
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    assetClass: "forex",
    source: "mt5_broker",
    isLive: true,
    stale: false,
    quality: "clean",
    aiUsable: true,
    missingCandleCount: 0,
    duplicateCount: 0,
    outOfOrderCount: 0,
    invalidOhlcCount: 0,
    warning: null,
    message: "live",
    ...over,
  } as unknown as ChartFeedStatus;
}

function pulseState(truthState: ChartFeedStatus): ChartState {
  return {
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    timeframe: "M5",
    truthState,
    aiUsable: truthState.aiUsable,
    stale: truthState.stale,
    marketUnderstanding: {
      trend: { populated: false, regime: "range", direction: "neutral" },
      levels: { nearestSupport: null, nearestResistance: null },
    },
    decisionState: { populated: false, bias: "neutral", quality: "—", actionability: "wait", vetoed: false },
    fastFlags: { momentumBurst: false },
    candleStats: { direction: "flat" },
    marketSentences: {
      risk: { tone: "neutral", text: "" },
      bestNextAction: { tone: "neutral", text: "Wait." },
    },
    setupState: { populated: false, ageBars: null, stage: "none" },
  } as unknown as ChartState;
}

describe("Chart Pulse names the feed basis it grades", () => {
  it("labels its chip as the closed-bar grade, not a bare feed status", () => {
    render(<ChartPulse state={pulseState(feed())} />);
    const chip = screen.getByTestId("pulse-feed");
    expect(chip.getAttribute("data-basis")).toBe("closed-bars");
    expect(chip.textContent).toMatch(/^Closed bars · Clean$/);
  });

  it("explains that the chart header grades a different basis and can differ", () => {
    render(<ChartPulse state={pulseState(feed())} />);
    const title = screen.getByTestId("pulse-feed").getAttribute("title") ?? "";
    expect(title).toMatch(/closed bars/i);
    expect(title).toMatch(/forming bar/i);
    expect(title).toMatch(/header/i);
  });

  it("a header 'Stale' next to a Pulse 'Clean' is no longer an unexplained contradiction", () => {
    render(
      <>
        <FeedConfidenceBadge feedStatus={feed({ quality: "stale", stale: true, isLive: false, aiUsable: false })} />
        <ChartPulse state={pulseState(feed())} />
      </>,
    );
    expect(screen.getByTestId("arx-feed-badge").getAttribute("data-severity")).not.toBe("clean");
    // The Pulse chip states that it describes closed bars only.
    expect(screen.getByTestId("pulse-feed").textContent).toContain("Closed bars");
  });
});
