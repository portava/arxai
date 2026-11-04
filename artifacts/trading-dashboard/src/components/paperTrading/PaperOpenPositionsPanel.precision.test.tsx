// Regression: the paper open-positions panel printed every price with
// toFixed(4) — EURUSD 1.08505 read "1.0851" (a digit rounded away), USDJPY
// 150.123 read "150.1230" and V75 123456.789 read "123456.7890" (digits the
// venue never quoted). Each row now prints at the precision its own prices
// carry, the same rule the scanner uses.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PaperOpenPositionsPanel } from "./PaperOpenPositionsPanel";

const orders = [
  { id: 1, symbol: "EURUSD", direction: "BUY", lotSize: 1, entryPrice: 1.08505, stopLoss: 1.0801, takeProfit: 1.09, status: "OPEN", profitLoss: 0, openedAt: "2026-10-28T00:00:00Z" },
  { id: 2, symbol: "USDJPY", direction: "SELL", lotSize: 1, entryPrice: 150.123, stopLoss: 151.5, takeProfit: 149, status: "OPEN", profitLoss: 0, openedAt: "2026-10-28T00:00:00Z" },
  { id: 3, symbol: "V75", direction: "BUY", lotSize: 0.01, entryPrice: 123456.78, stopLoss: 123000, takeProfit: 124000.5, status: "OPEN", profitLoss: 0, openedAt: "2026-10-28T00:00:00Z" },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("PaperOpenPositionsPanel price precision", () => {
  it("prints each instrument's prices without rounding away or inventing digits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ orders }), { status: 200 })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><PaperOpenPositionsPanel accountId={1} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText("EURUSD")).toBeTruthy());
    expect(screen.getByText("1.08505")).toBeTruthy();
    expect(screen.getByText("1.08010 / 1.09000")).toBeTruthy();
    expect(screen.getByText("150.123")).toBeTruthy();
    expect(screen.getByText("151.500 / 149.000")).toBeTruthy();
    expect(screen.getByText("123456.78")).toBeTruthy();
    expect(screen.getByText("123000.00 / 124000.50")).toBeTruthy();
    expect(screen.queryByText("123456.7800")).toBeNull();
    expect(screen.queryByText("1.0851")).toBeNull();
  });
});
