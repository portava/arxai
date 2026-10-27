// Chart-header timing chip — the grade names the timeframe it was computed on.
//
// Owner screenshot 2026-10-27: the V75 1m chart header showed "D · WAIT FOR
// ENTRY". The chip asked the timing brain with no timeframe, the route defaulted
// to M15, and an M15 grade sat unlabeled on the 1m chart.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const mockUseGetTimingBrain = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useGetTimingBrain: (...args: unknown[]) => mockUseGetTimingBrain(...args),
  getGetTimingBrainQueryKey: (symbol: string, params?: unknown) => ["/api/me/timing-brain", symbol, params],
}));

import { ChartTimingChip, timingTimeframeLabel } from "./ChartTimingChip";

function read(over: Record<string, unknown> = {}) {
  return {
    data: {
      symbol: "V75",
      timeframe: "M1",
      timingGrade: "D",
      entryPermission: "WAIT_FOR_ENTRY",
      heatScore: 41,
      dataQuality: { hasCandleData: true },
      ...over,
    },
  };
}

beforeEach(() => mockUseGetTimingBrain.mockReset());
afterEach(() => cleanup());

describe("ChartTimingChip", () => {
  it("asks for the chart's own timeframe and labels the grade with it (owner state: 1m)", () => {
    mockUseGetTimingBrain.mockReturnValue(read());
    render(<ChartTimingChip symbol="V75" apiTf="M1" timeframeLabel="1m" />);
    const [symbol, params, options] = mockUseGetTimingBrain.mock.calls[0]!;
    expect(symbol).toBe("V75");
    expect(params).toEqual({ timeframe: "M1" });
    expect((options as { query: { queryKey: unknown[] } }).query.queryKey).toEqual([
      "/api/me/timing-brain",
      "V75",
      { timeframe: "M1" },
    ]);
    const chip = screen.getByTestId("scanner-chart-timing-chip");
    expect(chip.textContent).toBe("1m timing · D · Wait for entry");
    expect(chip.getAttribute("title")).toContain("computed on 1m candles");
  });

  it("is not mounted for a timeframe the timing route does not support (it would silently fall back to M15)", () => {
    mockUseGetTimingBrain.mockReturnValue(read());
    for (const [tf, label] of [["H8", "8h"], ["W1", "1W"], ["M2", "2m"]] as const) {
      const { unmount } = render(<ChartTimingChip symbol="V75" apiTf={tf} timeframeLabel={label} />);
      expect(screen.queryByTestId("scanner-chart-timing-chip")).toBeNull();
      unmount();
    }
    expect(mockUseGetTimingBrain).not.toHaveBeenCalled();
  });

  it("hides a read whose echoed timeframe differs from the one asked for (never relabels an M15 read)", () => {
    mockUseGetTimingBrain.mockReturnValue(read({ timeframe: "M15" }));
    render(<ChartTimingChip symbol="V75" apiTf="M1" timeframeLabel="1m" />);
    expect(screen.queryByTestId("scanner-chart-timing-chip")).toBeNull();
  });

  it("hides a session-only estimate (no candle data) — it is not a read of this chart", () => {
    mockUseGetTimingBrain.mockReturnValue(read({ dataQuality: { hasCandleData: false } }));
    render(<ChartTimingChip symbol="V75" apiTf="M1" timeframeLabel="1m" />);
    expect(screen.queryByTestId("scanner-chart-timing-chip")).toBeNull();
  });

  it("timingTimeframeLabel names the timing card's timeframe from the server echo", () => {
    expect(timingTimeframeLabel("M15")).toBe("15m");
    expect(timingTimeframeLabel("H4")).toBe("4h");
    expect(timingTimeframeLabel("")).toBeNull();
    expect(timingTimeframeLabel(undefined)).toBeNull();
  });
});
