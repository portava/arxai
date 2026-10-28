// Quick Trade (Trade Command Room): /api/market/quote/:symbol is served by the
// ARX price simulator (random walk off fixed base prices, tagged
// executionEnvironment "SIMULATOR"). Its bid/ask/spread must never be shown as
// the tradable Sell / Buy price, and no "Risk approx." dollar figure may be
// derived from it, even when the page header reads LIVE.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("wouter", () => ({ useLocation: () => ["/trade-command-room", vi.fn()] }));
vi.mock("@/components/charts/ChartFeedConfidence", () => ({ ChartFeedConfidence: () => null }));

const { QuickTradePanel } = await import("./QuickTradePanel");
const { quickTradeRiskApprox } = await import("./quickTradeRisk");

afterEach(cleanup);

// Shape of marketSimulator.quote() (api-server/src/lib/marketSimulator.ts).
const SIM_QUOTE = {
  symbol: "EURUSD", bid: 1.08494, ask: 1.08506, spread: 0.00012, mid: 1.085,
  tsIso: "2026-10-28T12:00:00.000Z", volatility: "MEDIUM", executionEnvironment: "SIMULATOR",
};

const noop = () => undefined;
function panel(quote: Parameters<typeof QuickTradePanel>[0]["quote"], riskApprox = "—") {
  return (
    <QuickTradePanel
      symbol="EURUSD" setSymbol={noop} timeframe="M15" setTimeframe={noop}
      orderType="Market" setOrderType={noop} lot="1.00" setLot={noop} quote={quote}
      slTpOn setSlTpOn={noop} stopLoss="1.0800" setStopLoss={noop} takeProfit="" setTakeProfit={noop}
      riskCheckOn setRiskCheckOn={noop} safetyGatesOn setSafetyGatesOn={noop}
      riskApprox={riskApprox} canTrade blockedLabel=""
    />
  );
}

describe("Quick Trade quote source", () => {
  it("the quote route is the simulator", () => {
    const src = readFileSync(resolve(__dirname, "../../../../../api-server/src/routes/market.ts"), "utf8");
    expect(src).toMatch(/router\.get\("\/market\/quote\/:symbol"[\s\S]*?marketSimulator\.quote\(/);
  });

  it("a simulator quote is not shown as Sell / Buy prices", () => {
    render(panel(SIM_QUOTE));
    const strip = screen.getByTestId("quick-trade-price-strip").textContent ?? "";
    expect(strip).not.toContain("1.08494");
    expect(strip).not.toContain("1.08506");
    expect(strip).not.toContain("0.00012");
    expect(screen.getByTestId("trade-action-buy").textContent).not.toContain("1.08506");
    expect(screen.getByTestId("trade-action-sell").textContent).not.toContain("1.08494");
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toMatch(/simulator/i);
  });

  it("a quote with no stated source is not shown either", () => {
    const { executionEnvironment: _e, ...unsourced } = SIM_QUOTE;
    render(panel(unsourced));
    expect(screen.getByTestId("quick-trade-price-strip").textContent).not.toContain("1.08494");
  });

  it("a broker quote is shown with its source", () => {
    render(panel({ ...SIM_QUOTE, executionEnvironment: "MT5" }));
    expect(screen.getByTestId("quick-trade-price-strip").textContent).toContain("1.08494");
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toContain("MT5");
  });

  it("no Risk approx. dollar figure is derived from a simulator quote", () => {
    expect(quickTradeRiskApprox({ symbol: "EURUSD", lot: "1", stopLoss: "1.0800", quote: SIM_QUOTE }))
      .toBe("No market price");
    expect(quickTradeRiskApprox({ symbol: "EURUSD", lot: "1", stopLoss: "1.0800", quote: null }))
      .toBe("No market price");
  });
});
