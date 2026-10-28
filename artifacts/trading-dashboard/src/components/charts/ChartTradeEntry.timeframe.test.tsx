// "Trade from chart" feed chip — it must describe the timeframe the user is
// trading from, and say which one it describes (truth upgrade, 2026-10-28).
//
// Before: the live-chart page rendered <ChartTradeEntry/> without a timeframe,
// so its chip silently graded the M15 feed while the chart above was on M1
// (or any other timeframe), and nothing on the chip named a timeframe.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChartFeedStatus } from "@workspace/api-client-react";

const scannerTruthCalls: unknown[][] = [];

vi.mock("@/hooks/useScannerTruth", () => ({
  useScannerTruth: (...args: unknown[]) => {
    scannerTruthCalls.push(args);
    return {
      truth: { analysis: { level: "full" } },
      feedStatus: {
        symbol: "EURUSD",
        displaySymbol: "EURUSD",
        assetClass: "forex",
        source: "mt5_broker",
        isLive: true,
        stale: false,
        quality: "clean",
        aiUsable: true,
        missingCandleCount: 0,
        duplicateCount: 0,
        outOfOrderCount: 0,
        invalidOhlcCount: 0,
        warning: null,
        message: "live",
      } as unknown as ChartFeedStatus,
      isLoading: false,
      isError: false,
      refetch: () => {},
    };
  },
}));

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", () => {}],
  bareSymbol: (s: string) => s.replace(/^.*:/, ""),
}));

vi.mock("@/components/live/MasterLiveAccessGuard", () => ({
  useMasterLiveAccess: () => ({ loaded: true, canTrade: false }),
}));
vi.mock("@/components/live/LiveTradeTicket", () => ({ LiveTradeTicket: () => null }));
vi.mock("@/components/live/LiveSharedTradeTicket", () => ({ LiveSharedTradeTicket: () => null }));
vi.mock("@/components/news/EventImpactBadge", () => ({ EventImpactBadge: () => null }));
vi.mock("@/components/news/HighImpactEventBanner", () => ({ HighImpactEventBanner: () => null }));

import { ChartTradeEntry } from "./ChartTradeEntry";

beforeEach(() => {
  scannerTruthCalls.length = 0;
});
afterEach(() => cleanup());

describe("Trade-from-chart feed chip timeframe", () => {
  it("grades the timeframe it is given, not a hidden M15 default", () => {
    render(<ChartTradeEntry timeframe="M1" />);
    expect(scannerTruthCalls.at(-1)?.[1]).toBe("1m");
  });

  it("names the timeframe it describes on the chip", () => {
    render(<ChartTradeEntry timeframe="M1" />);
    const chip = screen.getByTestId("arx-feed-badge");
    expect(chip.getAttribute("aria-label")).toContain("M1");
    expect(screen.getByTestId("arx-feed-timeframe").textContent).toBe("M1");
  });

  it("still says which timeframe it graded when none is passed", () => {
    render(<ChartTradeEntry />);
    expect(scannerTruthCalls.at(-1)?.[1]).toBe("15m");
    expect(screen.getByTestId("arx-feed-timeframe").textContent).toBe("M15");
  });

  it("the live-chart page hands the chart's timeframe to the trade card", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = readFileSync(path.join(here, "../../pages/live-chart.tsx"), "utf8");
    expect(page).toMatch(/<ChartTradeEntry[^>]*timeframe=\{timeframe\}/);
  });
});
