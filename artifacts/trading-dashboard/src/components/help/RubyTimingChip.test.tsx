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
let gateDowngraded = false;
const gateCalls: unknown[][] = [];
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: (...args: unknown[]) => {
    gateCalls.push(args);
    return { truth: null, level: gateDowngraded ? "structural" : "full", isFull: !gateDowngraded, downgraded: gateDowngraded, reason: null };
  },
}));

import { RubyTimingChip } from "./RubyTimingChip";
import { timingBrainParams, userTimingTimezone } from "@/components/scanner/ChartTimingChip";

function read(over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  return {
    data: {
      symbol: "EURUSD",
      timeframe: "H1",
      timingGrade: "B",
      entryPermission: "WAIT_FOR_ENTRY",
      generatedAt: new Date(Date.now() - 2_000).toISOString(),
      dataQuality: { label: "real", hasCandleData: true, note: "All data sources available — read is based on real data." },
      ...over,
    },
    isError: false,
    ...state,
  };
}

beforeEach(() => {
  mockUseGetTimingBrain.mockReset();
  gateDowngraded = false;
  gateCalls.length = 0;
});
afterEach(() => cleanup());

describe("RubyTimingChip", () => {
  it("asks for the chart's timeframe (1h → H1), polls within the 30 s advice lifetime, and prints the timeframe", () => {
    mockUseGetTimingBrain.mockReturnValue(read());
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1h" />);
    const [symbol, params, options] = mockUseGetTimingBrain.mock.calls[0]!;
    expect(symbol).toBe("EURUSD");
    // The chart chip's request shape ({timeframe, tz}): one query, one cache entry.
    const expected = timingBrainParams("H1", userTimingTimezone());
    expect(params).toEqual(expected);
    expect((params as { timeframe: string }).timeframe).toBe("H1");
    const q = (options as { query: { queryKey: unknown[]; refetchInterval: number } }).query;
    expect(q.queryKey).toEqual(["/api/me/timing-brain", "EURUSD", expected]);
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

// Review finding: the Ruby chip said it used "the same rules as ChartTimingChip"
// but skipped the error, age and feed-gate checks, so after a failed refetch
// (React Query keeps the old data), a slept tab, or a downgraded feed it kept
// "EURUSD · 1m · B · Wait" while the chart header showed "no current read".
describe("RubyTimingChip — no grade without a current read (same rules as the chart chip)", () => {
  it("drops the grade after a failed refetch, even though the old data is cached", () => {
    mockUseGetTimingBrain.mockReturnValue(read({ timeframe: "M1" }, { isError: true }));
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1m" />);
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
    const muted = screen.getByTestId("ruby-timing-chip-unavailable");
    expect(muted.textContent).toBe("EURUSD · 1m · no current read");
    expect(muted.getAttribute("title")).toMatch(/could not be refreshed/);
  });

  it("drops the grade when the read is older than the 30 s advice lifetime", () => {
    mockUseGetTimingBrain.mockReturnValue(read({ timeframe: "M1", generatedAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1m" />);
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
    expect(screen.getByTestId("ruby-timing-chip-unavailable").textContent).toBe("EURUSD · 1m · no current read");
  });

  it("drops the grade with no build time or a future build time", () => {
    mockUseGetTimingBrain.mockReturnValue(read({ timeframe: "M1", generatedAt: undefined }));
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1m" />);
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
    cleanup();
    mockUseGetTimingBrain.mockReturnValue(read({ timeframe: "M1", generatedAt: new Date(Date.now() + 60_000).toISOString() }));
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1m" />);
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
  });

  it("hides the grade while the chart's feed gate is downgraded, reading the gate for the chart timeframe", () => {
    gateDowngraded = true;
    mockUseGetTimingBrain.mockReturnValue(read({ timeframe: "M1" }));
    render(<RubyTimingChip symbol="EURUSD" chartTimeframe="1m" />);
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
    expect(gateCalls[0]).toEqual(["EURUSD", "1m"]);
  });

  it("agrees with ChartTimingChip on the same data", async () => {
    const { ChartTimingChip } = await import("@/components/scanner/ChartTimingChip");
    mockUseGetTimingBrain.mockReturnValue(read({ timeframe: "M1", generatedAt: new Date(Date.now() - 5 * 60_000).toISOString() }, { isError: true }));
    render(<><RubyTimingChip symbol="EURUSD" chartTimeframe="1m" /><ChartTimingChip symbol="EURUSD" apiTf="M1" timeframeLabel="1m" /></>);
    expect(screen.getByTestId("scanner-chart-timing-chip-unavailable")).toBeTruthy();
    expect(screen.getByTestId("ruby-timing-chip-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("ruby-timing-chip")).toBeNull();
    // Same request from both chips.
    const [rubyCall, chartCall] = mockUseGetTimingBrain.mock.calls;
    expect(rubyCall![0]).toBe(chartCall![0]);
    expect(rubyCall![1]).toEqual(chartCall![1]);
  });
});
