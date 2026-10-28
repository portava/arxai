import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Regression: the Trade Logs Entry / SL / TP cells printed EURUSD levels at
// 2 decimals ("1.09") and a missing price as "0.00".
const trades = [
  {
    id: 1,
    createdAt: "2026-10-27T10:00:00.000Z",
    symbol: "EURUSD",
    direction: "BUY",
    lot: 0.1,
    entryPrice: 1.08523,
    stopLoss: 1.0831,
    takeProfit: 1.0895,
    status: "CLOSED_WIN",
    pnl: 42.7,
    pnlStatus: "CONFIRMED",
    strategy: "Test",
    mode: "DEMO",
  },
  {
    id: 2,
    createdAt: "2026-10-27T11:00:00.000Z",
    symbol: "USDJPY",
    direction: "SELL",
    lot: 0.1,
    entryPrice: null,
    stopLoss: 150.123,
    takeProfit: null,
    status: "OPEN",
    pnl: null,
    pnlStatus: "PENDING",
    strategy: "Test",
    mode: "DEMO",
  },
];

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetTrades: () => ({ data: trades, isLoading: false }),
    useGetOpenTrades: () => ({ data: [], isLoading: false }),
  };
});
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: false }),
}));
vi.mock("@/components/trade-logs/PnlCell", () => ({
  PnlCell: () => <span>pnl</span>,
}));

import TradeLogs from "./trade-logs";

describe("Trade Logs — executed levels at their quoted precision", () => {
  it("EURUSD entry/SL/TP keep 5 decimals; missing prices are a dash", () => {
    render(<TradeLogs />);
    const rows = screen.getAllByRole("row");
    const eur = rows.find((r) => r.textContent?.includes("EURUSD"));
    const jpy = rows.find((r) => r.textContent?.includes("USDJPY"));
    expect(eur?.textContent).toContain("1.08523");
    expect(eur?.textContent).toContain("1.0831");
    expect(eur?.textContent).toContain("1.0895");
    expect(eur?.textContent).not.toContain("1.09");
    expect(jpy?.textContent).toContain("150.123");
    expect(jpy?.textContent).not.toContain("0.00");
    expect(jpy?.textContent).toContain("—");
  });
});
