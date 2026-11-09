import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

// Regression: the holding card fed the pool's navStatus ("OK" | "UNDER_REVIEW")
// into the data-freshness chip, whose map only knows FRESH / DELAYED / STALE /
// UNDER_REVIEW / MISSING. A healthy "OK" NAV fell through to "Unavailable",
// beside a section chip that said "Live". navStatus is a NAV-calculation
// status, not a freshness reading, and must be labelled as one.

let fundBook: Record<string, unknown> = {};
vi.mock("@workspace/api-client-react", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useGetMeFundBook: () => ({ isLoading: false, data: fundBook }),
  useGetMeFundBookDrawdown: () => ({ data: { pools: [] } }),
  useGetMeFundBookTier: () => ({ isLoading: false, isError: false, data: null }),
}));

import { HoldingsTab } from "./investor";

function book(navStatus: string) {
  return {
    ok: true, baseCurrency: "USD", totalValue: 12, settledValue: 12, unrealizedFloatingPl: 0,
    realtimeValue: 12, realizedPnl: 0, freshness: "FRESH", freshnessAsOf: new Date().toISOString(),
    pools: [{
      poolKey: "BALANCED", name: "Balanced", riskLevel: "Moderate", status: "ACTIVE",
      navPerUnit: 1.2, navStatus, unitsOwned: 10, averageNav: 1, costBasis: 10, currentValue: 12,
      ownershipPct: 10, holdingStatus: "ACTIVE", floatingPlShare: 0,
    }],
  };
}

afterEach(() => cleanup());

describe("Investor holdings NAV status chip", () => {
  it("a healthy 'OK' NAV is not shown as 'Unavailable'", () => {
    fundBook = book("OK");
    render(<HoldingsTab />);
    const card = screen.getByTestId("holding-BALANCED");
    expect(within(card).queryByText("Unavailable")).toBeNull();
    expect(within(card).getByTestId("nav-status-badge").textContent).toMatch(/NAV computed/i);
  });

  it("an UNDER_REVIEW NAV says so", () => {
    fundBook = book("UNDER_REVIEW");
    render(<HoldingsTab />);
    const card = screen.getByTestId("holding-BALANCED");
    expect(within(card).getByTestId("nav-status-badge").textContent).toMatch(/NAV under review/i);
  });

  it("a NAV that was never computed hides the placeholder unit price and value", () => {
    fundBook = book("NOT_COMPUTED");
    render(<HoldingsTab />);
    const card = screen.getByTestId("holding-BALANCED");
    expect(within(card).getByTestId("nav-status-badge").textContent).toMatch(/NAV not computed/i);
    expect(within(card).getByTestId("holding-value-BALANCED").textContent).not.toMatch(/\$/);
    expect(within(card).queryByText("$1.20")).toBeNull();
  });

  it("an unrecognised NAV status is disclosed as unknown", () => {
    fundBook = book("WHATEVER");
    render(<HoldingsTab />);
    const card = screen.getByTestId("holding-BALANCED");
    expect(within(card).getByTestId("nav-status-badge").textContent).toMatch(/NAV status unknown/i);
  });
});
