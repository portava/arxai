// Ruby chat header timing chip — the grade names the chart timeframe it was
// computed on, and a session-only estimate is never shown as a read.
//
// Before: the chip asked GET /me/timing-brain/:symbol with no timeframe
// (server default M15) and rendered "EURUSD · B · Wait" on an H1 chart, even
// when dataQuality.hasCandleData was false (a clock/session-only estimate that
// the Truth snapshot refuses), polling every 90 s.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const mockUseGetTimingBrain = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useGetTimingBrain: (...args: unknown[]) => mockUseGetTimingBrain(...args),
  getGetTimingBrainQueryKey: (symbol: string, params?: unknown) => ["/api/me/timing-brain", symbol, params],
}));

import { RubyTimingChip } from "./RubyTimingChip";

function read(over: Record<string, unknown> = {}) {
  return {
    data: {
      symbol: "EURUSD",
      timeframe: "H1",
      timingGrade: "B",
      entryPermission: "WAIT_FOR_ENTRY",
      dataQuality: { label: "real", hasCandleData: true, note: "All data sources available — read is based on real data." },
      ...over,
    },
  };
}

beforeEach(() => mockUseGetTimingBrain.mockReset());
afterEach(() => cleanup());

describe("RubyTimingChip", () => {
  it("asks for the chart's timeframe (1h → H1), polls within the 30 s advice lifetime, and prints the timeframe", () => {
    mockUseGetTimingBrain.mockReturnValue(read());
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1h" />);
    const [symbol, params, options] = mockUseGetTimingBrain.mock.calls[0]!;
    expect(symbol).toBe("EURUSD");
    expect(params).toEqual({ timeframe: "H1" });
    const q = (options as { query: { queryKey: unknown[]; refetchInterval: number } }).query;
    expect(q.queryKey).toEqual(["/api/me/timing-brain", "EURUSD", { timeframe: "H1" }]);
    expect(q.refetchInterval).toBeLessThanOrEqual(30_000);
    expect(screen.getByTestId("ruby-timing-chip").textContent).toBe("EURUSD · 1h · B · Wait");
  });

  it("hides a session-only estimate (basic_timing_estimate, no candle data)", () => {
    mockUseGetTimingBrain.mockReturnValue(read({ dataQuality: { label: "basic_timing_estimate", hasCandleData: false } }));
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1h" />);
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
  });

  it("hides a read whose echoed timeframe is not the chart's (never relabels an M15 read)", () => {
    mockUseGetTimingBrain.mockReturnValue(read({ timeframe: "M15" }));
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1h" />);
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
  });

  it("is not mounted for a timeframe the timing route does not support, or with no chart timeframe", () => {
    mockUseGetTimingBrain.mockReturnValue(read());
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="8h" />);
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe={null} />);
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
    expect(mockUseGetTimingBrain).not.toHaveBeenCalled();
  });

  it("marks a partial-data read", () => {
    mockUseGetTimingBrain.mockReturnValue(read({ dataQuality: { label: "partial", hasCandleData: true, note: "Partial data: live quote unavailable." } }));
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1h" />);
    const chip = screen.getByTestId("ruby-timing-chip");
    expect(chip.textContent).toBe("EURUSD · 1h · B · Wait · partial");
    expect(chip.getAttribute("title")).toContain("Partial data: live quote unavailable.");
  });
});
