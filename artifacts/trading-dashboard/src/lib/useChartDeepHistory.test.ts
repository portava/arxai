// Guard test for the deep-history accumulator hook (Task #438).
//
// Locks the frontend honesty/loop-safety contract that the ScannerChartPanel
// reach-start handler depends on:
//   - loadOlder fetches an older page and accumulates it in front (ascending).
//   - Once the backend reports history is exhausted (hasMoreHistory=false /
//     nextBefore=null), hasMore flips false and FURTHER loadOlder calls are a
//     no-op — no repeated back-page fetches (the bug a stale closure would cause).
//   - A provider ceiling surfaces providerCapped + limitationReason verbatim.
//   - loadOlder never fetches when there is nothing on screen to page behind.
//
// MARKET-DATA / TELEMETRY ONLY: the hook touches no execution path. fetchChartHistory
// is mocked so the test is deterministic and offline.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const fetchChartHistory = vi.fn();
vi.mock("@/lib/chartCandlesQuery", () => ({
  fetchChartHistory: (...args: unknown[]) => fetchChartHistory(...args),
}));

import { useChartDeepHistory } from "./useChartDeepHistory";

function page(over: Partial<{
  source: string | null;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number }>;
  hasMoreHistory: boolean;
  nextBefore: string | null;
  providerLimitReached: boolean;
  limitationReason: string | null;
  providerMessage: string | null;
  coverageDays: number | null;
  depthTargetDays: number;
}> = {}) {
  return {
    source: "assistant_real",
    candles: [],
    hasMoreHistory: true,
    nextBefore: "2026-01-01T00:00:00.000Z",
    providerLimitReached: false,
    limitationReason: null,
    providerMessage: null,
    coverageDays: 1,
    depthTargetDays: 730,
    ...over,
  };
}

describe("useChartDeepHistory", () => {
  beforeEach(() => {
    fetchChartHistory.mockReset();
  });

  it("no-ops when there is nothing on screen to page behind", () => {
    const { result } = renderHook(() => useChartDeepHistory("EURUSD", "M5", true));
    act(() => result.current.loadOlder(null));
    expect(fetchChartHistory).not.toHaveBeenCalled();
  });

  it("stops fetching once the backend reports history is exhausted", async () => {
    fetchChartHistory.mockResolvedValueOnce(
      page({
        candles: [{ time: 1_700_000_000_000, open: 1, high: 1, low: 1, close: 1 }],
        hasMoreHistory: false,
        nextBefore: null,
      }),
    );

    const { result } = renderHook(() => useChartDeepHistory("EURUSD", "M5", true));

    act(() => result.current.loadOlder("2026-02-01T00:00:00.000Z"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchChartHistory).toHaveBeenCalledTimes(1);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.olderCandles.length).toBe(1);
    expect(result.current.depthTargetDays).toBe(730);

    // Repeated reach-start events after exhaustion must NOT fetch again.
    act(() => result.current.loadOlder("2026-02-01T00:00:00.000Z"));
    act(() => result.current.loadOlder("2026-02-01T00:00:00.000Z"));
    expect(fetchChartHistory).toHaveBeenCalledTimes(1);
  });

  it("surfaces a provider ceiling honestly (providerCapped + limitationReason)", async () => {
    fetchChartHistory.mockResolvedValueOnce(
      page({
        candles: [],
        hasMoreHistory: false,
        nextBefore: null,
        providerLimitReached: true,
        limitationReason: "Provider free tier has no older-than cursor; deeper history is unavailable from this source.",
        providerMessage: "Provider free tier has no older-than cursor; deeper history is unavailable from this source.",
      }),
    );

    const { result } = renderHook(() => useChartDeepHistory("EURUSD", "M5", true));
    act(() => result.current.loadOlder("2026-02-01T00:00:00.000Z"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.providerCapped).toBe(true);
    expect(result.current.limitationReason).toContain("older-than cursor");
    expect(result.current.hasMore).toBe(false);
  });
});
