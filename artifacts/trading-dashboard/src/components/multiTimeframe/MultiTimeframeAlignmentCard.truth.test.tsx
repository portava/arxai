// Multi-timeframe card: a timeframe that had no candles was not observed. The
// card must not show "SIDEWAYS · strength 0" / "NO CLEAR BIAS" / "Alignment
// 0/100" for it, including for older reports stored before the server learned
// to say INSUFFICIENT_DATA (client may only downgrade).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MultiTimeframeAlignmentCard, type MultiTimeframeReport } from "./MultiTimeframeAlignmentCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function snap(trend: "UP" | "DOWN" | "SIDEWAYS" | "INSUFFICIENT_DATA", candlesUsed: number, strength = 0) {
  return { trend, strength, slope: 0, fastSma: 0, slowSma: 0, candlesUsed };
}

function report(over: Partial<MultiTimeframeReport>): MultiTimeframeReport {
  return {
    id: 1, symbol: "EURUSD",
    lowerTimeframe: "M5", middleTimeframe: "H1", higherTimeframe: "H4",
    lowerTrend: snap("SIDEWAYS", 0), middleTrend: snap("SIDEWAYS", 0), higherTrend: snap("SIDEWAYS", 0),
    alignmentScore: 0, alignmentLabel: "NO_CLEAR_BIAS", conflictWarning: null, bestBias: "NEUTRAL",
    aiSummary: "EURUSD: M5 SIDEWAYS (0), H1 SIDEWAYS (0), H4 SIDEWAYS (0). This analysis describes observed conditions only",
    createdAt: "2026-10-28T06:00:00.000Z",
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

describe("MultiTimeframeAlignmentCard truth", () => {
  it("a legacy report built from 0 candles is not shown as SIDEWAYS / NO CLEAR BIAS", async () => {
    renderWith(report({}));
    await screen.findByTestId("mtf-insufficient");
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/SIDEWAYS/);
    expect(text).not.toMatch(/NO CLEAR BIAS/);
    expect(text).not.toMatch(/Alignment\s*0\/100/);
    expect(text).not.toMatch(/observed conditions/);
    expect(text).toMatch(/NOT ENOUGH DATA/);
    expect(text).toMatch(/Not enough candles were received for M5 \(0\), H1 \(0\), H4 \(0\)/);
  });

  it("an INSUFFICIENT_DATA report from the server names the short timeframe and its candle count", async () => {
    renderWith(report({
      lowerTrend: snap("UP", 120, 40), middleTrend: snap("UP", 120, 40), higherTrend: snap("INSUFFICIENT_DATA", 5),
      alignmentLabel: "INSUFFICIENT_DATA",
      aiSummary: "EURUSD: not enough candles to analyse",
    }));
    await screen.findByTestId("mtf-insufficient");
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/H4 \(5\)/);
    expect(text).not.toMatch(/Best bias/);
  });

  it("a fully observed report shows trends and how many candles each was read from", async () => {
    renderWith(report({
      lowerTrend: snap("UP", 120, 60), middleTrend: snap("UP", 120, 60), higherTrend: snap("UP", 120, 60),
      alignmentScore: 60, alignmentLabel: "STRONG_BULLISH_ALIGNMENT", bestBias: "BUY",
      aiSummary: "EURUSD: M5 UP (60). This analysis describes observed conditions only",
    }));
    const used = await screen.findAllByTestId("mtf-candles-used");
    expect(used.map((e) => e.textContent)).toEqual(["from 120 candles", "from 120 candles", "from 120 candles"]);
    expect(screen.queryByTestId("mtf-insufficient")).toBeNull();
    expect(document.body.textContent).toMatch(/STRONG BULLISH ALIGNMENT/);
  });
});
