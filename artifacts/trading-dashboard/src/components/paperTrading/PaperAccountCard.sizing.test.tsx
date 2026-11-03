// Truth: a paper close whose P&L could not be sized for its instrument stores
// 0 as a placeholder. The balance used to stay put on a stop or target hit,
// reading as a measured zero change. The server now counts such a close at
// the paper risk model and says so in account.pnlSizing; the card must show
// that note next to the balance, and show nothing extra when every close was
// sized. The same note covers open positions the equity cannot size.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperAccountCard } from "./PaperAccountCard";

const account = {
  id: 9, accountName: "Practice", startingBalance: 10_000, currentBalance: 9_990, equity: 9_990,
  marginUsed: 0, isActive: 1, createdAt: "2026-10-28T00:00:00Z",
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderWith(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><PaperAccountCard /></QueryClientProvider>);
}

describe("PaperAccountCard balance sizing note", () => {
  it("says when the balance counts closes whose P&L could not be sized", async () => {
    const note = "Balance includes 1 closed trade whose P&L could not be sized for the instrument (no contract size or currency conversion). It is counted at the paper risk model (price move × lots × 100), not a measured amount.";
    renderWith({ account: { ...account, pnlSizing: { unsizedClosedOrders: 1, unsizedOpenPositions: 0, note } } });
    await waitFor(() => expect(screen.getByText("Practice")).toBeTruthy());
    expect(screen.getByTestId("paper-account-sizing-note").textContent).toBe(note);
  });

  it("a server that leaves unsized wins out of the balance: the note and the units line say a win of unknown size is not added", async () => {
    const note = "Balance includes 2 closed trades whose P&L could not be sized for the instrument (no contract size or currency conversion). A closed trade that lost is counted at the paper risk model (price move × lots × 100), not a measured amount. A closed trade that won is not added to the balance (counted as 0), so the balance can be lower than the trades' real result.";
    const valuation = {
      priceSource: "NO_OPEN_ORDERS", openOrders: 0, openPricedBySimulator: 0, closedSimulatorPriced: 0,
      units: "PAPER_USD", pnlMultiplier: 100, marginPerLot: 1000, note: "",
    };
    renderWith({ account: { ...account, valuation, pnlSizing: { unsizedClosedOrders: 2, unsizedClosedWins: 1, unsizedOpenPositions: 0, note } } });
    await waitFor(() => expect(screen.getByText("Practice")).toBeTruthy());
    expect(screen.getByTestId("paper-account-sizing-note").textContent).toBe(note);
    const units = screen.getByTestId("paper-account-units").textContent ?? "";
    // Was "...counts at the paper risk model (price move × lots × 100)." with no exception for wins.
    expect(units).toMatch(/could not be sized counts at the paper risk model \(price move × lots × 100\), except that a closed trade that won is not added to the balance/);
  });

  it("a server that leaves unsized open gains out of equity: the units line says an open position in profit is not added", async () => {
    const valuation = {
      priceSource: "SIMULATOR", openOrders: 1, openPricedBySimulator: 1, closedSimulatorPriced: 0,
      units: "PAPER_USD", pnlMultiplier: 100, marginPerLot: 1000, note: "",
    };
    renderWith({ account: { ...account, valuation, pnlSizing: { unsizedClosedOrders: 0, unsizedClosedWins: 0, unsizedOpenPositions: 1, unsizedOpenGains: 1, note: "x" } } });
    await waitFor(() => expect(screen.getByText("Practice")).toBeTruthy());
    const units = screen.getByTestId("paper-account-units").textContent ?? "";
    // Was "...except that a closed trade that won is not added to the balance." while equity
    // no longer adds an open gain of unknown size either.
    expect(units).toMatch(/except that a closed trade that won is not added to the balance and an open position in profit is not added to equity/);
  });

  it("an older server that does not report unsizedClosedWins: the units line makes no claim that wins are left out", async () => {
    const valuation = {
      priceSource: "NO_OPEN_ORDERS", openOrders: 0, openPricedBySimulator: 0, closedSimulatorPriced: 0,
      units: "PAPER_USD", pnlMultiplier: 100, marginPerLot: 1000, note: "",
    };
    renderWith({ account: { ...account, valuation, pnlSizing: { unsizedClosedOrders: 1, unsizedOpenPositions: 0, note: "x" } } });
    await waitFor(() => expect(screen.getByText("Practice")).toBeTruthy());
    expect(screen.getByTestId("paper-account-units").textContent ?? "").not.toMatch(/not added to the balance/);
    expect(screen.getByTestId("paper-account-units").textContent ?? "").not.toMatch(/not added to equity/);
  });

  it("shows no note when every close was sized", async () => {
    renderWith({ account: { ...account, pnlSizing: { unsizedClosedOrders: 0, unsizedOpenPositions: 0, note: null } } });
    await waitFor(() => expect(screen.getByText("Practice")).toBeTruthy());
    expect(screen.queryByTestId("paper-account-sizing-note")).toBeNull();
  });
});
