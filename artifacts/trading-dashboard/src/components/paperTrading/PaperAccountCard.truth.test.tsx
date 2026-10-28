// The Demo Trading Sandbox account card showed Equity, "P&L vs start" and
// Margin with only a "SIMULATED" badge. Orders opened from the ticket are
// valued at a synthetic simulator price (generated candles, not a market
// quote), P&L is price move × lots × 100 for every symbol and margin is lots ×
// 1,000. A failed read also showed "No active account." and the create form.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperAccountCard } from "./PaperAccountCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperAccountCard /></QueryClientProvider>);
}
const account = {
  id: 5, accountName: "Practice", startingBalance: 10000, currentBalance: 10000, equity: 10000.5,
  marginUsed: 1000, isActive: 1, createdAt: "2026-10-28T00:00:00Z",
};
function serve(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe("PaperAccountCard truth", () => {
  it("says the prices are the simulator's synthetic price and the figures are simulator units", async () => {
    serve(200, { account: { ...account, valuation: {
      priceSource: "SIMULATOR", openOrders: 1, openPricedBySimulator: 1, closedSimulatorPriced: 2,
      units: "SIMULATOR_UNITS", pnlMultiplier: 100, marginPerLot: 1000, note: "",
    } } });
    mount();
    await waitFor(() => expect(screen.getByTestId("paper-account-price-source").textContent).toMatch(/synthetic, generated — not a market quote/));
    expect(screen.getByTestId("paper-account-price-source").textContent).toMatch(/2 closed orders were priced by the simulator/);
    const units = screen.getByTestId("paper-account-units").textContent ?? "";
    expect(units).toMatch(/simulator units, not money/);
    expect(units).toMatch(/× 100 for every symbol/);
    expect(units).toMatch(/not a broker margin/);
  });

  it("an older server without a valuation still discloses the units and that the source is not reported", async () => {
    serve(200, { account });
    mount();
    await waitFor(() => expect(screen.getByTestId("paper-account-price-source").textContent).toMatch(/not reported/));
    expect(screen.getByTestId("paper-account-units").textContent).toMatch(/simulator units, not money/);
  });

  it("a failed read says it could not be loaded, not 'No active account.'", async () => {
    serve(503, { error: "Paper account valuation unavailable: a current real quote is required" });
    mount();
    await waitFor(() => expect(screen.getByTestId("paper-account-unavailable").textContent).toMatch(/could not be loaded: Paper account valuation unavailable/));
    expect(screen.queryByText("No active account.")).toBeNull();
    expect(screen.queryByText("Create demo account")).toBeNull();
  });

  it("no account (404) still offers to create one", async () => {
    serve(404, { error: "No active paper account" });
    mount();
    await waitFor(() => expect(screen.getByText("No active account.")).toBeTruthy());
  });
});
