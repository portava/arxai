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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";

const fetchChartHistory = vi.fn();
vi.mock("@/lib/chartCandlesQuery", () => ({
  fetchChartHistory: (...args: unknown[]) => fetchChartHistory(...args),
}));

import { useChartDeepHistory } from "./useChartDeepHistory";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const candle = (time: number) => ({ time, open: 1, high: 1, low: 1, close: 1 });
const before = "2026-02-01T00:00:00.000Z";

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
  historyEvidence: { symbol: string; timeframe: string; source: string; sourceIdentity: string; scope?: "public_provider"; lastClosedCandleAt?: string } | null;
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

  it("retains only observed public history evidence and masks it on a source change",async()=>{
    const time=Date.parse("2026-01-01T00:00:00Z"),identity="a".repeat(64);
    const evidence={symbol:"V75",timeframe:"M15",source:"deriv_public",sourceIdentity:identity,scope:"public_provider" as const,lastClosedCandleAt:new Date(time+900_000).toISOString()};
    fetchChartHistory.mockResolvedValueOnce(page({source:"deriv_public",candles:[candle(time)],historyEvidence:evidence}));
    const {result,rerender}=renderHook(({id})=>useChartDeepHistory("V75","M15",true,"deriv_public",id,true),{initialProps:{id:identity}});
    await act(async()=>result.current.loadOlder(before));
    expect(result.current.analysisEvidence).toEqual(evidence);
    rerender({id:"b".repeat(64)});expect(result.current.analysisEvidence).toBeNull();expect(result.current.olderCandles).toEqual([]);
  });

  it("conflicting page overlap permanently withholds analysis before display deduplication",async()=>{
    const time=Date.parse("2026-01-01T00:00:00Z"),identity="a".repeat(64);
    const evidence={symbol:"V75",timeframe:"M15",source:"deriv_public",sourceIdentity:identity,scope:"public_provider" as const,lastClosedCandleAt:new Date(time+900_000).toISOString()};
    fetchChartHistory.mockResolvedValueOnce(page({source:"deriv_public",candles:[candle(time)],historyEvidence:evidence}))
      .mockResolvedValueOnce(page({source:"deriv_public",candles:[{...candle(time),high:2,close:2}],historyEvidence:evidence}))
      .mockResolvedValueOnce(page({source:"deriv_public",candles:[candle(time-900_000)],historyEvidence:evidence}));
    const {result}=renderHook(()=>useChartDeepHistory("V75","M15",true,"deriv_public",identity,true));
    await act(async()=>result.current.loadOlder(before));expect(result.current.analysisEvidence).toEqual(evidence);
    await act(async()=>result.current.loadOlder(before));expect(result.current.analysisEvidence).toBeNull();
    expect(result.current.olderCandles).toEqual([candle(time)]);
    await act(async()=>result.current.loadOlder(before));expect(result.current.analysisEvidence).toBeNull();expect(result.current.olderCandles).toHaveLength(2);
  });

  it("checks each page's own closed boundary rather than borrowing a newer page's cutoff",async()=>{
    const time=Date.parse("2026-01-01T00:00:00Z"),identity="a".repeat(64);
    const evidence={symbol:"V75",timeframe:"M15",source:"deriv_public",sourceIdentity:identity,scope:"public_provider" as const,lastClosedCandleAt:new Date(time+900_000).toISOString()};
    fetchChartHistory.mockResolvedValueOnce(page({source:"deriv_public",candles:[candle(time)],historyEvidence:evidence}))
      .mockResolvedValueOnce(page({source:"deriv_public",candles:[candle(time-900_000)],historyEvidence:{...evidence,lastClosedCandleAt:new Date(time-1).toISOString()}}));
    const {result}=renderHook(()=>useChartDeepHistory("V75","M15",true,"deriv_public",identity,true));
    await act(async()=>result.current.loadOlder(before));expect(result.current.analysisEvidence).toEqual(evidence);
    await act(async()=>result.current.loadOlder(before));expect(result.current.analysisEvidence).toBeNull();
  });

  it.each([
    { source: "deriv_public", evidence: "public" },
    { source: "mt5_broker", evidence: "different-opaque-account" },
  ])("masks and aborts older history after a source identity change: $source/$evidence", async (next) => {
    const old = deferred<ReturnType<typeof page>>(), current = deferred<ReturnType<typeof page>>();
    fetchChartHistory.mockResolvedValueOnce(page({ source: "mt5_broker", candles: [candle(100)],
      historyEvidence: { symbol: "V75", timeframe: "M15", source: "mt5_broker", sourceIdentity: "first-opaque-account" } }))
      .mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const seen: number[][] = [];
    const { result, rerender } = renderHook(({ source, evidence }) => {
      const value = useChartDeepHistory("V75", "M15", true, source, evidence);
      if (evidence === next.evidence) seen.push(value.olderCandles.map(c => c.time));
      return value;
    }, { initialProps: { source: "mt5_broker", evidence: "first-opaque-account" } });
    await act(async () => result.current.loadOlder(before));
    expect(result.current.olderCandles).toEqual([candle(100)]);
    act(() => result.current.loadOlder(before));
    const staleLoad = result.current.loadOlder;
    const signal = fetchChartHistory.mock.calls[1]![0].signal as AbortSignal;
    rerender(next);
    expect(signal.aborted).toBe(true);
    expect(seen.every(row => row.length === 0)).toBe(true);
    act(() => { staleLoad(before); result.current.loadOlder(before); });
    expect(fetchChartHistory).toHaveBeenCalledTimes(3);
    expect(fetchChartHistory.mock.calls[2]![0]).toMatchObject({ source: next.source, before });
    await act(async () => old.resolve(page({ source: "mt5_broker", candles: [candle(150)] })));
    expect(result.current.olderCandles).toEqual([]);
    expect(result.current.loading).toBe(true);
    await act(async () => current.resolve(page({ source: next.source, candles: [candle(200)],
      historyEvidence: { symbol: "V75", timeframe: "M15", source: next.source, sourceIdentity: next.evidence } })));
    expect(result.current.olderCandles).toEqual([candle(200)]);
  });

  it("refuses a history response from a different provider instead of mixing candle prefixes", async () => {
    fetchChartHistory.mockResolvedValueOnce(page({ source: "deriv_public", candles: [candle(100)] }));
    const { result } = renderHook(() => useChartDeepHistory("V75", "M15", true, "mt5_broker", "opaque"));
    await act(async () => result.current.loadOlder(before));
    expect(result.current.olderCandles).toEqual([]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.providerCapped).toBe(true);
    expect(result.current.limitationReason).toContain("did not match");
  });

  it("no-ops when there is nothing on screen to page behind", () => {
    const { result } = renderHook(() => useChartDeepHistory("EURUSD", "M5", true));
    act(() => result.current.loadOlder(null));
    expect(fetchChartHistory).not.toHaveBeenCalled();
  });

  it("does not request unattested history for a strict chart with missing identity", () => {
    const { result } = renderHook(() => useChartDeepHistory("V75", "M15", true, "mt5_broker", null, true));
    act(() => result.current.loadOlder(before));
    expect(fetchChartHistory).not.toHaveBeenCalled();
    expect(result.current.providerCapped).toBe(true);
    expect(result.current.limitationReason).toContain("identity can be verified");
  });

  it.each([null,
    { symbol: "V75", timeframe: "M15", source: "deriv_public", sourceIdentity: "different-account-or-source" },
    { symbol: "V25", timeframe: "M15", source: "deriv_public", sourceIdentity: "expected" },
    { symbol: "V75", timeframe: "M5", source: "deriv_public", sourceIdentity: "expected" },
  ])("withholds same-provider rows without the expected historical evidence: %s", async historyEvidence => {
    fetchChartHistory.mockResolvedValueOnce(page({ source: "deriv_public", candles: [candle(100)], historyEvidence }));
    const { result } = renderHook(() => useChartDeepHistory("V75", "M15", true, "deriv_public", "expected", true));
    await act(async () => result.current.loadOlder(before));
    expect(result.current.olderCandles).toEqual([]);
    expect(result.current.providerCapped).toBe(true);
    expect(result.current.hasMore).toBe(false);
    expect(fetchChartHistory.mock.calls[0]![0]).toMatchObject({ sourceIdentity: "expected" });
  });

  it("accepts matching producer evidence and preserves a denied account-history explanation", async () => {
    const historyEvidence = { symbol: "V75", timeframe: "M15", source: "deriv_public", sourceIdentity: "expected" };
    fetchChartHistory.mockResolvedValueOnce(page({ source: "deriv_public", candles: [candle(100)], historyEvidence }))
      .mockResolvedValueOnce(page({ source: "deriv_public", candles: [], limitationReason: "Original account history is unverified", historyEvidence: null }));
    const { result } = renderHook(() => useChartDeepHistory("V75", "M15", true, "deriv_public", "expected", true));
    await act(async () => result.current.loadOlder(before));
    expect(result.current.olderCandles).toEqual([candle(100)]);
    await act(async () => result.current.loadOlder(before));
    expect(result.current.olderCandles).toEqual([candle(100)]);
    expect(result.current.limitationReason).toBe("Original account history is unverified");
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

  it.each([
    { symbol: "GBPUSD", apiTf: "M5" },
    { symbol: "EURUSD", apiTf: "H1" },
  ])("isolates delayed history when the series changes to $symbol/$apiTf", async (next) => {
    const old = deferred<ReturnType<typeof page>>(), current = deferred<ReturnType<typeof page>>();
    fetchChartHistory.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
      .mockResolvedValueOnce(page({ hasMoreHistory: false, nextBefore: null }));
    const { result, rerender } = renderHook(({ symbol, apiTf }) => useChartDeepHistory(symbol, apiTf),
      { initialProps: { symbol: "EURUSD", apiTf: "M5" } });
    const oldLoad = result.current.loadOlder;
    act(() => oldLoad(before));
    const oldSignal = fetchChartHistory.mock.calls[0]![0].signal as AbortSignal;
    rerender(next);
    expect(oldSignal.aborted).toBe(true);
    act(() => oldLoad(before));
    expect(fetchChartHistory).toHaveBeenCalledTimes(1);
    act(() => result.current.loadOlder(before));
    expect(fetchChartHistory.mock.calls[1]![0]).toMatchObject({ ...next, before, source: null });
    // Simulate a provider/mock that ignores transport cancellation.
    await act(async () => old.resolve(page({ source: "old-feed", candles: [candle(100)],
      nextBefore: "old-cursor", hasMoreHistory: false, providerLimitReached: true,
      limitationReason: "old limit", coverageDays: 999 })));
    expect(result.current.olderCandles).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.providerCapped).toBe(false);
    expect(result.current.limitationReason).toBeNull();
    expect(result.current.coverageDays).toBeNull();
    act(() => result.current.loadOlder(before));
    expect(fetchChartHistory).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(page({ source: "current-feed", candles: [candle(200)], nextBefore: "current-cursor" })));
    expect(result.current.olderCandles).toEqual([candle(200)]);
    act(() => result.current.loadOlder(before));
    expect(fetchChartHistory.mock.calls[2]![0]).toMatchObject({ ...next, before: "current-cursor", source: "current-feed" });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("does not let an obsolete rejection exhaust or unlock the new series", async () => {
    const old = deferred<ReturnType<typeof page>>(), current = deferred<ReturnType<typeof page>>();
    fetchChartHistory.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { result, rerender } = renderHook(({ symbol }) => useChartDeepHistory(symbol, "M5"),
      { initialProps: { symbol: "EURUSD" } });
    act(() => result.current.loadOlder(before));
    rerender({ symbol: "GBPUSD" });
    act(() => result.current.loadOlder(before));
    await act(async () => old.reject(new Error("late failure")));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loading).toBe(true);
    act(() => result.current.loadOlder(before));
    expect(fetchChartHistory).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(page()));
    expect(result.current.loading).toBe(false);
  });

  it("reset aborts and invalidates pending work even for the same series", async () => {
    const old = deferred<ReturnType<typeof page>>(), current = deferred<ReturnType<typeof page>>();
    fetchChartHistory.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { result } = renderHook(() => useChartDeepHistory("EURUSD", "M5"));
    act(() => result.current.loadOlder(before));
    const oldSignal = fetchChartHistory.mock.calls[0]![0].signal as AbortSignal;
    act(() => result.current.reset());
    expect(oldSignal.aborted).toBe(true);
    expect(result.current.loadedAny).toBe(false);
    act(() => result.current.loadOlder(before));
    await act(async () => old.resolve(page({ candles: [candle(100)], hasMoreHistory: false })));
    expect(result.current.olderCandles).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.hasMore).toBe(true);
    await act(async () => current.resolve(page({ candles: [candle(200)] })));
    expect(result.current.olderCandles).toEqual([candle(200)]);
    expect(result.current.loading).toBe(false);
  });

  it("never exposes already loaded bars during the new series' first render", async () => {
    fetchChartHistory.mockResolvedValueOnce(page({ candles: [candle(100)] }));
    const renders: { symbol: string; times: number[] }[] = [];
    const { result, rerender } = renderHook(({ symbol }) => {
      const state = useChartDeepHistory(symbol, "M5");
      renders.push({ symbol, times: state.olderCandles.map(bar => bar.time) });
      return state;
    }, { initialProps: { symbol: "EURUSD" } });
    act(() => result.current.loadOlder(before));
    await waitFor(() => expect(result.current.olderCandles).toHaveLength(1));
    rerender({ symbol: "GBPUSD" });
    expect(renders.filter(render => render.symbol === "GBPUSD").every(render => render.times.length === 0)).toBe(true);
  });

  it("unmount aborts pending work and disables retained callbacks", async () => {
    const old = deferred<ReturnType<typeof page>>();
    fetchChartHistory.mockReturnValueOnce(old.promise);
    const { result, unmount } = renderHook(() => useChartDeepHistory("EURUSD", "M5"));
    const retained = result.current;
    act(() => retained.loadOlder(before));
    const signal = fetchChartHistory.mock.calls[0]![0].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(page({ candles: [candle(100)] })));
    act(() => { retained.reset(); retained.loadOlder(before); });
    expect(fetchChartHistory).toHaveBeenCalledTimes(1);
  });

  it("passes optional cancellation through the real history transport", async () => {
    const actual = await vi.importActual<typeof import("./chartCandlesQuery")>("./chartCandlesQuery");
    const controller = new AbortController();
    const transport = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", transport);
    const request = actual.fetchChartHistory({ symbol: "EURUSD", apiTf: "M5", before, signal: controller.signal });
    expect(transport.mock.calls[0]![1]).toMatchObject({ credentials: "include", signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
  });
});
