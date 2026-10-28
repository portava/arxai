// Regression: the Trade Command Room polls /api/market/quote/:symbol, which
// routes/market.ts serves from marketSimulator.quote() — a random walk around
// a base price, tagged executionEnvironment:"SIMULATOR". QuickTradePanel's
// Quote type dropped that tag and rendered the simulator bid/ask in the big
// SELL / BUY strip and on the SELL / BUY buttons, and the page computed
// "Risk approx. $N" from the simulator mid, all under "LIVE · Shared Master
// MT5". Those are not the master broker's prices.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/charts/ChartFeedConfidence", () => ({ ChartFeedConfidence: () => null }));
vi.mock("@/components/dashboard/cockpit/primitives", () => ({
  CockpitCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { QuickTradePanel, computeRiskApprox } = await import("./QuickTradePanel");

// Exact shape routes/market.ts returns (marketSimulator.quote()).
const simQuote = {
  symbol: "EURUSD", bid: 1.08493, ask: 1.08507, spread: 0.00014, mid: 1.085,
  tsIso: "2026-10-28T05:00:00.000Z", volatility: 1, executionEnvironment: "SIMULATOR",
};

const noop = () => {};
function panel(props: { hideNonBrokerQuote: boolean; quote?: typeof simQuote | null }) {
  return (
    <QuickTradePanel
      symbol="EURUSD" setSymbol={noop}
      timeframe="M15" setTimeframe={noop}
      orderType="Market" setOrderType={noop}
      lot="0.10" setLot={noop}
      quote={props.quote === undefined ? simQuote : props.quote}
      slTpOn setSlTpOn={noop}
      stopLoss="" setStopLoss={noop}
      takeProfit="" setTakeProfit={noop}
      riskCheckOn setRiskCheckOn={noop}
      safetyGatesOn setSafetyGatesOn={noop}
      riskApprox="Set SL"
      canTrade
      blockedLabel=""
      hideNonBrokerQuote={props.hideNonBrokerQuote}
    />
  );
}

afterEach(() => cleanup());

describe("QuickTradePanel quote source", () => {
  it("in live mode does not show simulator prices in the price strip or on the buttons", () => {
    const { container } = render(panel({ hideNonBrokerQuote: true }));
    const text = container.textContent ?? "";
    expect(text).not.toContain("1.08493");
    expect(text).not.toContain("1.08507");
    expect(screen.getByTestId("trade-action-buy").textContent).not.toMatch(/\d/);
    expect(screen.getByTestId("trade-action-sell").textContent).not.toMatch(/\d/);
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toMatch(/simulator/i);
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toMatch(/not .*broker/i);
  });

  it("outside live mode labels the simulator prices as simulated", () => {
    const { container } = render(panel({ hideNonBrokerQuote: false }));
    expect(container.textContent).toContain("1.08493");
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toMatch(/simulated/i);
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toMatch(/not .*broker/i);
  });

  it("a quote with no source tag is not presented as a broker quote", () => {
    const { executionEnvironment: _e, ...untagged } = simQuote;
    void _e;
    render(panel({ hideNonBrokerQuote: false, quote: untagged as typeof simQuote }));
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toMatch(/unknown/i);
  });
});

describe("computeRiskApprox", () => {
  it("does not compute a live dollar risk from a simulator price", () => {
    const r = computeRiskApprox({ lot: "0.10", stopLoss: "1.0800", quote: simQuote, symbol: "EURUSD", isLive: true });
    expect(r).not.toMatch(/\$/);
    expect(r).toMatch(/broker quote/i);
  });

  it("outside live mode labels the estimate as using a simulated price", () => {
    const r = computeRiskApprox({ lot: "0.10", stopLoss: "1.0800", quote: simQuote, symbol: "EURUSD", isLive: false });
    expect(r).toMatch(/^\$50\.00/);
    expect(r).toMatch(/sim/i);
  });

  it("still asks for a stop-loss first", () => {
    expect(computeRiskApprox({ lot: "0.10", stopLoss: "", quote: simQuote, symbol: "EURUSD", isLive: true })).toBe("Set SL");
  });
});
