// Truth regression: the scanner score on the chart AI-overlay legend is a
// heuristic (mean of setup quality, entry quality and inverted risk), not a
// probability, so it must not be printed as a percentage; and the status chip
// must use plain-language copy instead of a lower-cased UPPER_SNAKE enum.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ChartAiOverlayPanel } from "./ChartAiOverlayPanel";
import type { UseAiChartOverlaysResult, AiSignalSummary } from "@/hooks/useAiChartOverlays";

afterEach(() => cleanup());

function data(signal: Partial<AiSignalSummary>): UseAiChartOverlaysResult {
  return {
    overlays: [],
    signal: {
      symbol: "EURUSD", timeframe: "M15", timeframeMatchesChart: true, side: "BUY", bias: "bullish",
      confidence: 0.71, confidenceScore: 71, statusBadge: "REJECTED_BY_RISK", dataSource: "LIVE_FEED",
      entry: 1.1, stopLoss: 1.09, takeProfit: 1.12, finalReadHeadline: null,
      ...signal,
    } as AiSignalSummary,
    ruby: { status: "idle", read: null, error: null },
    suppressed: false,
    suppressedReason: null,
    requestRubyRead: vi.fn(),
  };
}

describe("ChartAiOverlayPanel scanner legend", () => {
  it("shows the heuristic score without a percentage and says it is not a probability", () => {
    render(<ChartAiOverlayPanel data={data({})} />);
    const row = screen.getByTestId("chart-ai-overlay-signal");
    expect(row.textContent).not.toMatch(/\d+%/);
    const score = screen.getByTestId("chart-ai-overlay-score");
    expect(score.textContent).toContain("71/100");
    expect(score.getAttribute("title") ?? "").toMatch(/not a win probability/i);
  });

  it("says the score is unavailable instead of inventing 0", () => {
    render(<ChartAiOverlayPanel data={data({ confidence: 0, confidenceScore: null })} />);
    expect(screen.getByTestId("chart-ai-overlay-score").textContent).toMatch(/unavailable/i);
  });

  it("maps the status enum to plain-language copy", () => {
    render(<ChartAiOverlayPanel data={data({})} />);
    const chip = screen.getByTestId("chart-ai-overlay-status");
    expect(chip.textContent).toBe("Risk too high");
  });

  it("does not leak an unrecognised status token", () => {
    render(<ChartAiOverlayPanel data={data({ statusBadge: "NEW_INTERNAL_STATE" })} />);
    const chip = screen.getByTestId("chart-ai-overlay-status");
    expect(chip.textContent).not.toMatch(/new internal state/i);
  });
});

describe("ChartAiOverlayPanel data-source chip", () => {
  const cases: Array<[string, RegExp]> = [
    ["LIVE_FEED", /^Scanned on live feed$/],
    ["LIVE_DELAYED", /^Scanned on delayed feed$/],
    ["STALE_FEED", /^Scanned on stale feed$/],
    ["SIMULATOR", /^Simulated data$/],
    ["AWAITING_FEED", /^No market data yet$/],
    ["HISTORY_READY_AWAITING_LIVE_TICK", /^History only, no live tick yet$/],
  ];
  for (const [token, label] of cases) {
    it(`reads ${token} in plain English, never the raw token`, () => {
      render(<ChartAiOverlayPanel data={data({ dataSource: token })} />);
      const chip = screen.getByTestId("chart-ai-overlay-datasource");
      expect(chip.textContent).toMatch(label);
      expect(chip.textContent).not.toContain(token);
      expect(chip.getAttribute("data-source")).toBe(token);
    });
  }

  it("says the source was not reported instead of printing UNKNOWN", () => {
    render(<ChartAiOverlayPanel data={data({ dataSource: "" })} />);
    const chip = screen.getByTestId("chart-ai-overlay-datasource");
    expect(chip.textContent).toBe("Source not reported");
  });

  it("does not leak an unrecognised source token or present it as live", () => {
    render(<ChartAiOverlayPanel data={data({ dataSource: "NEW_INTERNAL_FEED" })} />);
    const chip = screen.getByTestId("chart-ai-overlay-datasource");
    expect(chip.textContent).toBe("Unrecognised source");
    expect(chip.textContent).not.toMatch(/live/i);
  });

  it("titles the chip as the scan-time source, not a current-feed verdict", () => {
    render(<ChartAiOverlayPanel data={data({ dataSource: "LIVE_FEED" })} />);
    const title = screen.getByTestId("chart-ai-overlay-datasource").getAttribute("title") ?? "";
    expect(title).toMatch(/when it scanned/i);
    expect(title).not.toMatch(/honest/i);
  });
});
