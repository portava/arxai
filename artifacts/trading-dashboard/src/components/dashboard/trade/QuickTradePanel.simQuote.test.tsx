// MOCK_LEAK — the Quick Trade price strip is fed by /api/market/quote, whose
// ONLY handler is the in-memory random-walk market simulator (every payload is
// tagged executionEnvironment:"SIMULATOR"). Before this fix the panel rendered
// those bid/ask/spread numbers as an unlabeled executable price strip — under a
// page banner reading "LIVE · Shared Master MT5".
//
// Contract locked here:
//   1. A SIMULATOR-tagged quote renders a visible "Simulated quote" tag.
//   2. The BUY/SELL action buttons carry NO simulator price (a price on the
//      action button reads as executable).
//   3. A quote without the SIMULATOR tag (future broker-real wiring) renders
//      no tag and keeps prices on the buttons.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("wouter", () => ({
  useLocation: () => ["/", vi.fn()],
  Link: ({ href, children, ...rest }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// ChartFeedConfidence self-fetches scanner truth; irrelevant to this contract.
vi.mock("@/components/charts/ChartFeedConfidence", () => ({
  ChartFeedConfidence: () => <span data-testid="feed-confidence-stub" />,
}));

import { QuickTradePanel, type Quote } from "./QuickTradePanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = () => {};

function renderPanel(quote: Quote) {
  return render(
    <QuickTradePanel
      symbol="EURUSD" setSymbol={noop}
      timeframe="M15" setTimeframe={noop}
      orderType="Market" setOrderType={noop}
      lot="0.01" setLot={noop}
      quote={quote}
      slTpOn={false} setSlTpOn={noop}
      stopLoss="" setStopLoss={noop}
      takeProfit="" setTakeProfit={noop}
      riskCheckOn setRiskCheckOn={noop}
      safetyGatesOn setSafetyGatesOn={noop}
      riskApprox="—"
      canTrade
      blockedLabel=""
    />,
  );
}

const SIM_QUOTE: Quote = {
  bid: 1.085, ask: 1.0851, spread: 0.0001, mid: 1.08505,
  executionEnvironment: "SIMULATOR",
};

describe("QuickTradePanel — simulator quotes must never pass as broker pricing", () => {
  it("labels a SIMULATOR-tagged quote with a visible simulated-quote tag", () => {
    renderPanel(SIM_QUOTE);

    const tag = screen.getByTestId("quick-trade-sim-quote-tag");
    expect(tag.textContent ?? "").toMatch(/simulated quote/i);
    expect(tag.textContent ?? "").toMatch(/not your broker/i);
  });

  it("keeps simulator prices OFF the BUY/SELL action buttons", () => {
    renderPanel(SIM_QUOTE);

    expect(screen.getByTestId("trade-action-buy").textContent ?? "").not.toContain("1.0851");
    expect(screen.getByTestId("trade-action-sell").textContent ?? "").not.toContain("1.085");
  });

  it("renders no tag and keeps button prices for an untagged (broker-real) quote", () => {
    renderPanel({ bid: 1.085, ask: 1.0851, spread: 0.0001, mid: 1.08505 });

    expect(screen.queryByTestId("quick-trade-sim-quote-tag")).toBeNull();
    expect(screen.getByTestId("trade-action-buy").textContent ?? "").toContain("1.0851");
  });

  it("renders no tag when there is no quote at all", () => {
    renderPanel(null);

    expect(screen.queryByTestId("quick-trade-sim-quote-tag")).toBeNull();
  });
});
