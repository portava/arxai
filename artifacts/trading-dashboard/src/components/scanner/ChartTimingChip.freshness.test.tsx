// Truth fix — the chart-header timing chip kept "15m timing · A · GO" on the
// chart after its refetches failed (React Query keeps the last data), after the
// tab slept for minutes, and while the chart's own feed gate said the feed was
// not confirmed. A grade with no current read behind it must not be shown.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

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

import { ChartTimingChip } from "./ChartTimingChip";

const NOW = Date.parse("2026-10-28T10:00:00.000Z");
function goRead(over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) {
  return {
    data: {
      symbol: "EURUSD", timeframe: "M15", timingGrade: "A", entryPermission: "GO", heatScore: 80,
      generatedAt: new Date(NOW - 2_000).toISOString(), dataQuality: { hasCandleData: true }, ...over,
    },
    isError: false,
    isFetching: false,
    refetch: () => Promise.resolve(),
    ...state,
  };
}

beforeEach(() => {
  mockUseGetTimingBrain.mockReset();
  gateDowngraded = false;
  gateCalls.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("ChartTimingChip — no grade without a current read", () => {
  it("shows a current GO read", () => {
    mockUseGetTimingBrain.mockReturnValue(goRead());
    render(<ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />);
    expect(screen.getByTestId("scanner-chart-timing-chip").textContent).toBe("15m timing · A · Go");
  });

  it("drops the grade when the refetch fails, even though the last data is still cached", () => {
    mockUseGetTimingBrain.mockReturnValue(goRead({}, { isError: true }));
    render(<ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />);
    expect(screen.queryByTestId("scanner-chart-timing-chip")).toBeNull();
    const muted = screen.getByTestId("scanner-chart-timing-chip-unavailable");
    expect(muted.textContent).toBe("15m timing · no current read");
    expect(muted.textContent).not.toContain("Go");
  });

  it("withdraws the grade once the read is older than the chip's lifetime, with no re-render from the query", () => {
    mockUseGetTimingBrain.mockReturnValue(goRead());
    render(<ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />);
    expect(screen.getByTestId("scanner-chart-timing-chip")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(screen.queryByTestId("scanner-chart-timing-chip")).toBeNull();
    expect(screen.getByTestId("scanner-chart-timing-chip-unavailable")).toBeTruthy();
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-date"],
    ["future", new Date(NOW + 120_000).toISOString()],
  ])("does not show a grade whose generatedAt is %s", (_n, generatedAt) => {
    mockUseGetTimingBrain.mockReturnValue(goRead({ generatedAt }));
    render(<ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />);
    expect(screen.queryByTestId("scanner-chart-timing-chip")).toBeNull();
  });

  it("shows no GO grade while the chart's own feed gate is downgraded", () => {
    gateDowngraded = true;
    mockUseGetTimingBrain.mockReturnValue(goRead());
    render(<ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />);
    expect(screen.queryByTestId("scanner-chart-timing-chip")).toBeNull();
    expect(gateCalls[0]).toEqual(["EURUSD", "15m"]);
  });
});

// Review fix (2026-10-28): the chip's poll interval and the read's lifetime
// were both 30 s, and React Query restarts the interval after each response,
// so every healthy cycle the grade expired before the next read arrived and the
// chip flashed "no current read". The chip now asks for a new read ahead of
// the expiry. Simulated: React Query's polling (interval restarted on every
// update, as configured by the chip), 1 s request latency, generatedAt stamped
// when the request starts.
describe("ChartTimingChip — a healthy poll never shows 'no current read'", () => {
  it("keeps the grade on screen across several polling cycles", async () => {
    const { useEffect, useState } = await import("react");
    const LATENCY_MS = 1_000;
    let requests = 0;
    mockUseGetTimingBrain.mockImplementation(
      (_symbol: string, _params: unknown, options: { query: { refetchInterval?: number } }) => {
        const [data, setData] = useState(() => goRead({ generatedAt: new Date(Date.now() - 1_000).toISOString() }).data);
        const [isFetching, setFetching] = useState(false);
        const fetchNow = () => {
          requests += 1;
          const startedAt = Date.now();
          setFetching(true);
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              setData(goRead({ generatedAt: new Date(startedAt).toISOString() }).data);
              setFetching(false);
              resolve();
            }, LATENCY_MS);
          });
        };
        const interval = options.query.refetchInterval;
        useEffect(() => {
          if (typeof interval !== "number") return;
          const id = setTimeout(() => { void fetchNow(); }, interval);
          return () => clearTimeout(id);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [data, interval]);
        return { data, isError: false, isFetching, refetch: fetchNow };
      },
    );
    render(<ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />);
    expect(screen.getByTestId("scanner-chart-timing-chip")).toBeTruthy();
    for (let elapsed = 0; elapsed < 3 * 60_000; elapsed += 250) {
      act(() => { vi.advanceTimersByTime(250); });
      if (screen.queryByTestId("scanner-chart-timing-chip-unavailable")) {
        throw new Error(`'no current read' shown at +${elapsed + 250} ms on a healthy poll`);
      }
      expect(screen.getByTestId("scanner-chart-timing-chip")).toBeTruthy();
    }
    expect(requests).toBeGreaterThan(3);
  });

  it("a read the server returns unchanged is not re-requested in a loop", async () => {
    const refetch = vi.fn(() => Promise.resolve());
    mockUseGetTimingBrain.mockReturnValue({ ...goRead(), isFetching: false, refetch });
    render(<ChartTimingChip symbol="EURUSD" apiTf="M15" timeframeLabel="15m" />);
    act(() => { vi.advanceTimersByTime(2 * 60_000); });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("scanner-chart-timing-chip-unavailable")).toBeTruthy();
  });
});
