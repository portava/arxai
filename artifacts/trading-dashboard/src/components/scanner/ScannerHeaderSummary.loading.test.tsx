// Truth audit 2026-10-28 — before the first /api/chart/candles response there
// is no measurement. The header Data pill and the Data health card must say
// they are still checking, not paint the red "Unavailable" / XCircle used for
// a feed that was measured and found empty or for a failed load.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let symbolTruth: Record<string, unknown> = {};
let scannerTruth: Record<string, unknown> = {};

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({ useScannerTimeframe: () => ["15m", () => {}] }));
vi.mock("@/hooks/useSymbolTruth", () => ({ useSymbolTruth: () => symbolTruth }));
vi.mock("@/hooks/useScannerTruth", () => ({ useScannerTruth: () => scannerTruth }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ shouldShowAdminDiagnostics: false }) }));

import { ScannerHeaderSummary } from "./ScannerHeaderSummary";
import { ScannerDataHealthPanel } from "./ScannerDataHealthPanel";

afterEach(() => cleanup());

function pillVerdict(testId: string): HTMLElement {
  const pill = screen.getByTestId(testId);
  return pill.querySelector("span.font-semibold") as HTMLElement;
}

describe("scanner header + data health while the first candles response is pending", () => {
  it("Data pill reads as checking, not a red 'Unavailable'", () => {
    symbolTruth = { scannerTruth: null, verdict: null, components: null, isLoading: true, isError: false };
    render(<ScannerHeaderSummary />);
    const v = pillVerdict("scanner-header-data");
    expect(v.textContent).not.toBe("Unavailable");
    expect(v.textContent).toMatch(/Checking/);
    expect(v.className).not.toContain("text-danger");
    expect(pillVerdict("scanner-header-ruby").textContent).not.toBe("No read");
  });

  it("a failed candles load still reads Unavailable (it was checked and failed)", () => {
    symbolTruth = { scannerTruth: null, verdict: null, components: null, isLoading: false, isError: true };
    render(<ScannerHeaderSummary />);
    const v = pillVerdict("scanner-header-data");
    expect(v.textContent).toBe("Unavailable");
    expect(v.className).toContain("text-danger");
    expect(screen.getByTestId("scanner-header-data").textContent).not.toContain("Waiting for market data");
  });

  it("Data health card shows no red failure icon before any measurement", () => {
    scannerTruth = { truth: null, feedStatus: null, isLoading: true, isError: false, refetch: () => {} };
    render(<ScannerDataHealthPanel />);
    const card = screen.getByTestId("scanner-data-health");
    const headline = screen.getByTestId("scanner-data-health-headline");
    expect(headline.className).not.toContain("text-danger");
    expect(headline.textContent).toContain("Waiting for market data");
    expect(card.querySelector(".lucide-circle-x, .lucide-x-circle")).toBeNull();
  });

  it("Data health card says the load failed when the candles request errored", () => {
    scannerTruth = { truth: null, feedStatus: null, isLoading: false, isError: true, refetch: () => {} };
    render(<ScannerDataHealthPanel />);
    const headline = screen.getByTestId("scanner-data-health-headline");
    expect(headline.className).toContain("text-danger");
    expect(headline.textContent).not.toContain("Waiting for market data");
  });
});
