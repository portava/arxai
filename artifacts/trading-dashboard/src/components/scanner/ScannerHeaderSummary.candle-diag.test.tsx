// Owner screenshot 2026-10-27 (V75 1m, admin): the diagnostic line read
// "candles 200/150" — a ratio-looking pair whose 200 included the still-forming
// bar, beside a Trade Health line about "closed candles". The line must say what
// was loaded, how many were CLOSED (the number readiness used), and the minimum.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";

let candles: Record<string, unknown> = {};

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["V75", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["1m", () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({
    scannerTruth: {
      strip: {
        data: { verdict: "Live", detail: "Live, confirmed candles." },
        ruby: { detail: "" },
        trading: { verdict: "Blocked", detail: "Trading is restricted on your account." },
      },
      candles,
      consolidated: { rubyReadStatus: "NO_READ", scannerActionability: "WAIT_FOR_CONFIRMATION", userMessage: "", internalReasonCode: "" },
      dataHealth: { sourceNote: "" },
      readiness: null,
    } as unknown as ScannerTruth,
    verdict: null,
  }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: true }),
}));

import { ScannerHeaderSummary } from "./ScannerHeaderSummary";

afterEach(() => cleanup());

describe("ScannerHeaderSummary — admin candle diagnostic", () => {
  it("200 loaded with a forming tip: 'loaded (incl. forming) · 199 closed · min 150 closed', never '200/150'", () => {
    candles = { lastClose: 33588.01, sourceTechnical: "Deriv public", count: 200, closedCount: 199, hasFormingBar: true, minRequired: 150, status: "live" };
    render(<ScannerHeaderSummary running={false} />);
    const line = screen.getByTestId("scanner-header-candle-diag").textContent ?? "";
    expect(line).toContain("candles 200 loaded (incl. forming) · 199 closed · min 150 closed");
    expect(line).not.toMatch(/200\/150/);
  });

  it("all bars closed: no forming note", () => {
    candles = { lastClose: 1, sourceTechnical: "x", count: 180, closedCount: 180, hasFormingBar: false, minRequired: 150, status: "live" };
    render(<ScannerHeaderSummary running={false} />);
    const line = screen.getByTestId("scanner-header-candle-diag").textContent ?? "";
    expect(line).toContain("candles 180 loaded · 180 closed · min 150 closed");
  });
});
