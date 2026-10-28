import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The badge renders what /api/market-data/tradability decided. A failed
// lookup (the hook resolves it to null) is "could not be loaded", never an
// endless "Checking…"; a verdict is shown with the server's own copy.
let query: { data: unknown; isPending: boolean; isFetching: boolean } = { data: undefined, isPending: true, isFetching: true };
vi.mock("@/lib/useTradability", () => ({ useTradability: () => query }));

import { TradabilityBadge } from "./TradabilityBadge";

afterEach(() => { cleanup(); });

describe("TradabilityBadge", () => {
  it("shows 'Checking…' only while the request is in flight", () => {
    query = { data: undefined, isPending: true, isFetching: true };
    render(<TradabilityBadge symbol="EURUSD" />);
    expect(screen.getByTestId("badge-tradability-loading").textContent).toMatch(/Checking/);
  });

  it("a failed lookup reads 'could not be loaded', not 'Checking…'", () => {
    query = { data: null, isPending: false, isFetching: false };
    render(<TradabilityBadge symbol="EURUSD" />);
    expect(screen.queryByTestId("badge-tradability-loading")).toBeNull();
    expect(screen.getByTestId("badge-tradability-unavailable").textContent).toBe("Tradability could not be loaded");
    expect(screen.getByTestId("text-tradability-helper").textContent).toMatch(/was not checked/);
  });

  it("an allowed market shows the server label and copy, which make no bridge-connection claim", () => {
    query = {
      data: {
        ok: true, symbol: "EURUSD", assetClass: "forex", dataProvider: "external", dataAvailable: true,
        mt5Tradable: "yes", executionProvider: "mt5", liveExecutionAllowed: true,
        badgeLabel: "Allowed for MT5 live",
        userMessage: "EURUSD is on your live market list and is an ARX Focus market — that is all this label checks. The MT5 bridge connection, the broker's symbol list, governance rules and every live safety gate are checked only when an order is submitted.",
      },
      isPending: false, isFetching: false,
    };
    render(<TradabilityBadge symbol="EURUSD" />);
    expect(screen.getByTestId("badge-tradability").textContent).toBe("Allowed for MT5 live");
    expect(screen.getByTestId("text-tradability-helper").textContent).not.toMatch(/connected MT5 bridge/);
  });
});
