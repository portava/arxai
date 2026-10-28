// Header price precision + basis (owner screenshot [A], 2026-10-27): the
// header printed "V75 · 1m · 33,588.01" — the 15s-poll close rounded to 2 dp
// with thousands grouping — while the chart badge printed 33588.0069 and the
// axis the live tip 33575.37. The header now prints the instrument's precision
// (no grouping, same characters as the chart) and, on a live display, the same
// tick-stream tip the chart's axis shows. Off a live display it labels the
// poll close as last-known.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import type { ScannerTruth } from "@/lib/scannerTruth";
import { publishScannerTip, scannerTipKey } from "@/lib/scannerLiveTipStore";

let displayStatus = "LIVE";

function makeTruth(): ScannerTruth {
  return {
    displayStatus,
    strip: {
      data: { verdict: "Live", detail: "Live, confirmed candles." },
      ruby: { detail: "" },
      trading: { verdict: "Blocked", detail: "" },
    },
    candles: {
      lastClose: 33588.0069, pricePrecision: 4, sourceTechnical: "deriv_public",
      count: 200, minRequired: 150, status: "CONFIRMED",
    },
    consolidated: {
      rubyReadStatus: "NO_READ",
      scannerActionability: "WAIT_FOR_CONFIRMATION",
      userMessage: "Live data is confirmed.",
      internalReasonCode: "FEED_OK",
    },
    dataHealth: { sourceNote: "Deriv public data." },
  } as unknown as ScannerTruth;
}

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["V75", () => {}],
  bareSymbol: (s: string) => s,
  setChartSymbol: () => {},
}));
vi.mock("@/hooks/useScannerTimeframe", () => ({
  useScannerTimeframe: () => ["1m", () => {}],
}));
vi.mock("@/hooks/useSymbolTruth", () => ({
  useSymbolTruth: () => ({ scannerTruth: makeTruth(), verdict: null }),
}));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({ shouldShowAdminDiagnostics: false }),
}));

import { ScannerHeaderSummary } from "./ScannerHeaderSummary";

const KEY = scannerTipKey("V75", "1m");

afterEach(() => {
  cleanup();
  publishScannerTip(KEY, null);
  displayStatus = "LIVE";
});

describe("ScannerHeaderSummary — one price, one precision", () => {
  it("prints the poll close at the instrument's 4 dp with no grouping (was 33,588.01)", () => {
    render(<ScannerHeaderSummary running={false} />);
    const price = screen.getByTestId("scanner-header-price");
    expect(price.textContent).toBe("33588.0069");
    expect(price.textContent).not.toContain(",");
  });

  it("follows the chart's live tick tip, the same observation the price axis shows", () => {
    render(<ScannerHeaderSummary running={false} />);
    act(() => publishScannerTip(KEY, 33575.372));
    expect(screen.getByTestId("scanner-header-price").textContent).toBe("33575.3720");
    // Tip withdrawn (poll replaced it on the axis / frozen frame) → poll close.
    act(() => publishScannerTip(KEY, null));
    expect(screen.getByTestId("scanner-header-price").textContent).toBe("33588.0069");
  });

  it("off a live display never shows a tick and labels the close last-known", () => {
    displayStatus = "STALE";
    render(<ScannerHeaderSummary running={false} />);
    act(() => publishScannerTip(KEY, 33575.372));
    const price = screen.getByTestId("scanner-header-price");
    expect(price.textContent).toBe("33588.0069last-known");
    expect(price.getAttribute("title")).toMatch(/not a live price/i);
  });
});
