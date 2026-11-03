// Demo account card — "No active account." (and the create form, whose POST
// deactivates the user's current account) may only follow a confirmed 404.
// A 503 means the account exists but could not be valued; any other failure
// means it could not be loaded. Neither is "no account".
//
// The card also showed Equity, "P&L vs start" and Margin with only a
// "SIMULATED" badge. Orders opened from the ticket are valued at a synthetic
// simulator price (generated candles, not a market quote) and margin is lots ×
// 1,000. After the paper-venue contract sizing, P&L is sized in USD from the
// instrument's contract size; only an unsized amount uses the paper risk model
// (move × lots × 100), so the units line says so when the server reports it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperAccountCard } from "./PaperAccountCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperAccountCard /></QueryClientProvider>);
}

describe("PaperAccountCard read states", () => {
  it("503 valuation unavailable: the account exists, no 'No active account' and no create form", async () => {
    mount(503, { error: "Paper account valuation unavailable: a current real quote is required", simulated: true });
    const state = await screen.findByTestId("paper-account-unavailable");
    expect(state.textContent).toContain("a current real quote is required");
    expect(state.textContent).toMatch(/could not be valued/i);
    expect(screen.queryByText("No active account.")).toBeNull();
    expect(screen.queryByText("Create demo account")).toBeNull();
  });

  it("500: could not be loaded, no create form", async () => {
    mount(500, { error: "Failed" });
    const state = await screen.findByTestId("paper-account-unavailable");
    expect(state.textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText("No active account.")).toBeNull();
    expect(screen.queryByText("Create demo account")).toBeNull();
  });

  it("a confirmed 404 still offers to create one", async () => {
    mount(404, { error: "No active paper account" });
    await screen.findByText("No active account.");
    expect(screen.getByText("Create demo account")).toBeTruthy();
  });

  it("while loading it does not offer to create one", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PaperAccountCard /></QueryClientProvider>);
    expect(screen.queryByText("No active account.")).toBeNull();
    expect(screen.queryByText("Create demo account")).toBeNull();
  });
});

function mountTruth() {
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
  it("says the prices are the simulator's synthetic price and the figures are simulated USD sized from the contract size", async () => {
    serve(200, { account: { ...account, valuation: {
      priceSource: "SIMULATOR", openOrders: 1, openPricedBySimulator: 1, closedSimulatorPriced: 2,
      units: "PAPER_USD", pnlMultiplier: 100, marginPerLot: 1000, note: "",
    } } });
    mountTruth();
    await waitFor(() => expect(screen.getByTestId("paper-account-price-source").textContent).toMatch(/synthetic, generated — not a market quote/));
    expect(screen.getByTestId("paper-account-price-source").textContent).toMatch(/2 closed orders were priced by the simulator/);
    const units = screen.getByTestId("paper-account-units").textContent ?? "";
    expect(units).toMatch(/simulated USD, not money/);
    expect(units).toMatch(/sized from the instrument's contract size/);
    expect(units).toMatch(/could not be sized counts at the paper risk model \(price move × lots × 100\)/);
    expect(units).toMatch(/not a broker margin/);
  });

  it("an older server without a valuation: the source and the units are 'not reported', and no scale is claimed", async () => {
    serve(200, { account });
    mountTruth();
    await waitFor(() => expect(screen.getByTestId("paper-account-price-source").textContent).toMatch(/not reported/));
    const units = screen.getByTestId("paper-account-units").textContent ?? "";
    expect(units).toMatch(/Units not reported by the server/);
    expect(units).toMatch(/not money/);
    expect(units).not.toMatch(/× 100/);
  });

  it("a failed read (503) says the account could not be valued, not 'No active account.'", async () => {
    serve(503, { error: "Paper account valuation unavailable: a current real quote is required" });
    mountTruth();
    await waitFor(() => expect(screen.getByTestId("paper-account-unavailable").textContent).toMatch(/could not be valued right now \(Paper account valuation unavailable/));
    expect(screen.queryByText("No active account.")).toBeNull();
    expect(screen.queryByText("Create demo account")).toBeNull();
  });

  it("no account (404) still offers to create one", async () => {
    serve(404, { error: "No active paper account" });
    mountTruth();
    await waitFor(() => expect(screen.getByText("No active account.")).toBeTruthy());
  });
});
