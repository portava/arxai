// Regression: the replay counter was the decision-log length, decisions were
// not tied to a candle, and once every candle was stepped the server stopped
// returning decisions while the page kept offering "Step" with no word that
// the replay had ended.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { default: MarketReplay } = await import("./market-replay");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const CANDLES = [
  { tsIso: "2026-10-28T10:00:00Z", c: 1.1 },
  { tsIso: "2026-10-28T10:01:00Z", c: 1.2 },
];

describe("Market Replay position truth", () => {
  it("shows the server's replay position and says when the replay is finished", async () => {
    let step = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/start")) return new Response(JSON.stringify({ replayId: "r1", candles: CANDLES, candleTimeframe: "M1" }));
      if (url.endsWith("/step")) {
        const i = step++;
        if (i >= CANDLES.length) return new Response(JSON.stringify({ replayId: "r1", finished: true }));
        return new Response(JSON.stringify({
          replayId: "r1", candleIndex: i, totalCandles: 2, finished: i === CANDLES.length - 1,
          decision: { candleIndex: i, candleTsIso: CANDLES[i]!.tsIso, candlesAnalysed: i + 1, aiAction: "WAIT", confidenceScore: 40, riskScore: 30, reason: `r${i}` },
        }));
      }
      return new Response("{}");
    }));
    render(<MarketReplay />);
    fireEvent.click(screen.getByRole("button", { name: /Start/ }));
    await waitFor(() => expect(screen.getByTestId("replay-position").textContent).toMatch(/not started · 2 candles/));
    expect(screen.getByTestId("replay-position").textContent).toMatch(/1-minute simulator bars/);
    fireEvent.click(screen.getByRole("button", { name: /Step \(no call\)/ }));
    await waitFor(() => expect(screen.getByTestId("replay-position").textContent).toMatch(/candle 1 of 2/));
    fireEvent.click(screen.getByRole("button", { name: /Step \(no call\)/ }));
    await waitFor(() => expect(screen.getByTestId("replay-position").textContent).toMatch(/candle 2 of 2.*Replay finished/));
    expect((screen.getByRole("button", { name: /Step \(no call\)/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/candle 2 · /).length).toBe(1);
  });
});
