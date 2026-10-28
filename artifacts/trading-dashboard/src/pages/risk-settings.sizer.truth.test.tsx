import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The Position Sizing Calculator promised the "optimal lot size" and showed
// "Final Lot Size 0.01" for XAUUSD although the server sized gold as a forex
// pair ($10 per pip — about 1000x off). The server now says which value model
// it used; the card labels the lot an estimate, states the basis, and does
// not show a lot for a symbol whose contract it does not know.

const { default: RiskSettings } = await import("./risk-settings");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

class NoEventSource { onmessage = null; onerror = null; addEventListener() {} removeEventListener() {} close() {} }

function stub(sizer: Record<string, unknown>) {
  vi.stubGlobal("EventSource", NoEventSource);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/risk/position-size")) return json(sizer);
    if (url.includes("/risk/settings")) return json({ riskPerTradePct: 0.5, maxDailyLossPct: 2, maxWeeklyLossPct: 5, maxTradesPerDay: 5, maxOpenTrades: 2, maxLotSize: 0.1, stopAfterLosingStreak: 3, cooldownAfterLossMinutes: 30, minConfidenceScore: 75, disableDuringAbnormalVolatility: true, mode: "Balanced", liveLocked: true });
    return json({}, 404);
  }));
}

async function calculate(symbol: string) {
  window.history.replaceState({}, "", "/risk-settings?tab=calculator");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RiskSettings /></QueryClientProvider>);
  const input = await screen.findByPlaceholderText("e.g. Volatility 75 Index");
  fireEvent.change(input, { target: { value: symbol } });
  fireEvent.click(screen.getByRole("button", { name: /Calculate Position Size/ }));
  return screen.findByTestId("sizer-final-lot");
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const BASE = { riskAmount: 10, stopDistance: 5, suggestedLot: 0.01, maxLotAllowed: 0.1, finalLot: 0.01, warning: "Lot clamped to minimum 0.01." };

describe("Position sizer — estimate disclosure", () => {
  it("a symbol the model does not know is 'Not sized', with the basis shown", async () => {
    const basis = "XAUUSD is not a currency pair this calculator knows (metals, crypto and similar), but it was sized as one at $10 per pip. That can be wrong by a factor of 1,000 or more, so the lot is not usable. Use your broker's contract specification.";
    stub({ ...BASE, valueModel: "unknown_contract", estimate: true, valuePerUnitPerLot: 100000, basis });
    const lot = await calculate("XAUUSD");
    expect(lot.textContent).toBe("Not sized");
    expect(screen.getByTestId("sizer-basis").textContent).toBe(basis);
    expect(screen.queryByText("Final Lot Size")).toBeNull();
    expect(screen.queryByText(/optimal lot size/i)).toBeNull();
  });

  it("an estimated model shows the lot as an estimate with its basis", async () => {
    const basis = "EURGBP's pip value is in GBP, not USD. The calculator assumes $10 per 0.0001 pip, so the lot is an estimate.";
    stub({ ...BASE, warning: null, finalLot: 0.2, suggestedLot: 0.2, valueModel: "forex_other_quote", estimate: true, valuePerUnitPerLot: 100000, basis });
    const lot = await calculate("EURGBP");
    expect(lot.textContent).toBe("0.20");
    expect(screen.getByTestId("sizer-final-label").textContent).toBe("Estimated Lot Size");
    expect(screen.getByTestId("sizer-basis").textContent).toBe(basis);
  });

  it("an older server with no basis is still labelled an estimate", async () => {
    stub({ ...BASE });
    await calculate("EURUSD");
    expect(screen.getByTestId("sizer-final-label").textContent).toBe("Estimated Lot Size");
    expect(screen.getByTestId("sizer-basis").textContent).toMatch(/not reported/);
  });
});
