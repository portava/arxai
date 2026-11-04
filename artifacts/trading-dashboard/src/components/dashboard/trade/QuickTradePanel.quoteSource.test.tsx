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
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => ({ mode: { on: false, scope: "live", defaultVolume: 0.01, maxLotPerClick: null, canEnable: true, blockReason: null, loading: false }, busyKey: null, execute: vi.fn(), closePosition: vi.fn() }) }));
vi.mock("@/hooks/useSymbolLotSpec", () => ({ useSymbolLotSpec: () => ({ volumeMin: null, volumeStep: null, volumeMax: null, point: null, stopsLevel: null }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { QuickTradePanel, readQuickTradeQuote } = await import("./QuickTradePanel");
const { quickTradeRiskApprox } = await import("./quickTradeRisk");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Shape of marketSimulator.quote() (api-server/src/lib/marketSimulator.ts).
const SIM_QUOTE = {
  symbol: "EURUSD", bid: 1.08494, ask: 1.08506, spread: 0.00012, mid: 1.085,
  tsIso: "2026-10-28T12:00:00.000Z", volatility: "MEDIUM", executionEnvironment: "SIMULATOR",
};

const noop = () => undefined;
function panel(quote: Parameters<typeof QuickTradePanel>[0]["quote"], riskApprox = "—", quoteLoadFailed = false, quoteLoading?: boolean) {
  return (
    <QuickTradePanel
      symbol="EURUSD" setSymbol={noop} timeframe="M15" setTimeframe={noop}
      orderType="Market" setOrderType={noop} lot="1.00" setLot={noop} quote={quote} quoteLoadFailed={quoteLoadFailed} quoteLoading={quoteLoading}
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
    // Ported from the parallel fix's test: the label never presents it as the broker's quote.
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toMatch(/not .*broker/i);
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

// Review finding: /api/market/quote/:symbol answers 404 {error:"Unknown symbol"}
// for an unknown symbol, and the page stored that JSON body as the quote. The
// panel then took any non-null object for a simulator quote and said "The only
// quote it can read comes from the ARX price simulator" — inventing a quote
// that never came back.
describe("Quick Trade — an error body is not a simulator quote", () => {
  it("an error body says no quote is available, not 'ARX price simulator'", () => {
    render(panel({ error: "Unknown symbol" } as unknown as Parameters<typeof QuickTradePanel>[0]["quote"]));
    const src = screen.getByTestId("quick-trade-quote-source").textContent ?? "";
    expect(src).not.toMatch(/simulator/i);
    expect(src).toBe("No quote available for this symbol.");
  });

  it("a quote object without numeric bid/ask is not called a simulator quote", () => {
    render(panel({ executionEnvironment: "SIMULATOR" } as unknown as Parameters<typeof QuickTradePanel>[0]["quote"]));
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toBe("No quote available for this symbol.");
  });

  it("a priced quote with no stated source is named as unsourced, not as the simulator", () => {
    const { executionEnvironment: _e, ...unsourced } = SIM_QUOTE;
    render(panel(unsourced));
    const src = screen.getByTestId("quick-trade-quote-source").textContent ?? "";
    expect(src).not.toMatch(/simulator/i);
    expect(src).toMatch(/no stated source/i);
  });

  // Was a regex over the page source; now exercises the read the page uses.
  it("the page does not store a failed quote response as the quote", async () => {
    const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", answer(500, JSON.stringify({ error: "Internal error" })));
    expect(await readQuickTradeQuote("EURUSD")).toEqual({ quote: null, failed: true });
    vi.stubGlobal("fetch", answer(200, JSON.stringify(SIM_QUOTE)));
    expect(await readQuickTradeQuote("EURUSD")).toEqual({ quote: SIM_QUOTE, failed: false });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/market/quote/EURUSD");
  });
});

// Review finding (d019e37f): every non-ok answer and every rejected request
// became a null quote, and the panel said "No quote available for this
// symbol." Only the route's 404 {error:"Unknown symbol"} means there is no
// quote; any other failure is "could not be loaded".
describe("Quick Trade — a failed quote read is 'could not be loaded', not 'no quote'", () => {
  const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));

  it("a 5xx answer is a failed read", async () => {
    vi.stubGlobal("fetch", answer(502, "Bad Gateway"));
    expect(await readQuickTradeQuote("EURUSD")).toEqual({ quote: null, failed: true });
    vi.stubGlobal("fetch", answer(401, JSON.stringify({ error: "Unauthorized" })));
    expect(await readQuickTradeQuote("EURUSD")).toEqual({ quote: null, failed: true });
  });

  it("a request that throws is a failed read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await readQuickTradeQuote("EURUSD")).toEqual({ quote: null, failed: true });
  });

  it("a 2xx body that is not JSON is a failed read", async () => {
    vi.stubGlobal("fetch", answer(200, "<!doctype html><html></html>"));
    expect(await readQuickTradeQuote("EURUSD")).toEqual({ quote: null, failed: true });
  });

  it("the route's 404 Unknown symbol is no quote, not a failure", async () => {
    vi.stubGlobal("fetch", answer(404, JSON.stringify({ error: "Unknown symbol" })));
    expect(await readQuickTradeQuote("FOO")).toEqual({ quote: null, failed: false });
  });

  it("any other 404 (the route itself was not found) is a failed read", async () => {
    vi.stubGlobal("fetch", answer(404, "Cannot GET /api/market/quote/EURUSD"));
    expect(await readQuickTradeQuote("EURUSD")).toEqual({ quote: null, failed: true });
  });

  it("the panel says the quote could not be loaded instead of 'No quote available'", () => {
    render(panel(null, "—", true));
    const src = screen.getByTestId("quick-trade-quote-source").textContent ?? "";
    expect(src).toMatch(/The quote could not be loaded/);
    expect(src).not.toMatch(/No quote available/);
    expect(src).not.toMatch(/simulator/i);
  });

  it("with no failure, an absent quote still reads 'No quote available for this symbol.'", () => {
    render(panel(null, "—", false));
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toBe("No quote available for this symbol.");
  });
});

// Round 3 review: until the first quote read answered, the panel reached its
// last branch and said "No quote available for this symbol." -- a claim about
// the symbol made before any answer arrived.
describe("Quick Trade — a quote not read yet is not 'no quote'", () => {
  it("while the quote is loading the panel says so, not 'No quote available'", () => {
    render(panel(null, "—", false, true));
    const src = screen.getByTestId("quick-trade-quote-source").textContent ?? "";
    expect(src).not.toMatch(/No quote available/);
    expect(src).toBe("Loading the quote…");
  });

  it("once the read answered with no quote it says 'No quote available for this symbol.'", () => {
    render(panel(null, "—", false, false));
    expect(screen.getByTestId("quick-trade-quote-source").textContent).toBe("No quote available for this symbol.");
  });
});
