import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useSelectedMarketSnapshot } from "@/hooks/useSelectedMarketSnapshot";
import { fetchChartCandles } from "@/lib/chartCandlesQuery";
import { fetchSelectedMarket, refreshSelectedMarket, selectedMarketIdentity, selectedMarketQueryOptions } from "./selectedMarketQuery";

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach((c) => c.clear()); clients.length = 0; vi.unstubAllGlobals(); });
function setup(userId = 7) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  client.setQueryData(["me"], { id: userId });
  return { client, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
function response(symbol = "EURUSD", timeframe = "M5", marker = "first") {
  return { ok: true, symbol, timeframe, highlights: { marker }, explanation: { marker }, generatedAt: "2026-10-26T12:00:01.000Z", dataAsOf: "2026-10-26T12:00:00.000Z" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function network() {
  const calls: Array<{ url: string; signal: AbortSignal; answer: ReturnType<typeof deferred<Response>> }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    const answer = deferred<Response>();
    const signal = init.signal as AbortSignal;
    signal?.addEventListener("abort", () => answer.reject(new DOMException("Aborted", "AbortError")));
    calls.push({ url: String(url), signal, answer });
    return answer.promise;
  }));
  return calls;
}
function answer(call: ReturnType<typeof network>[number], body = response()) {
  call.answer.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

describe("selected market shared read", () => {
  it("normalizes canonical/API timeframe spellings to one user-scoped key", () => {
    expect(selectedMarketQueryOptions(7, "FX:eurusd", "M5").queryKey).toEqual(selectedMarketQueryOptions(7, "EURUSD", "5m").queryKey);
    expect(selectedMarketQueryOptions(8, "EURUSD", "M5").queryKey).not.toEqual(selectedMarketQueryOptions(7, "EURUSD", "M5").queryKey);
    expect(selectedMarketQueryOptions(7, "EURUSD", "M15").queryKey).not.toEqual(selectedMarketQueryOptions(7, "EURUSD", "M5").queryKey);
  });

  it("panel and header observers share one timeframe-correct request and timestamp", async () => {
    const { wrapper } = setup(); const calls = network();
    const { result } = renderHook(() => [useSelectedMarketSnapshot("EURUSD", "5m"), useSelectedMarketSnapshot("EURUSD", "M5")], { wrapper });
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain("timeframe=M5");
    await act(async () => answer(calls[0]));
    await waitFor(() => expect(result.current[0].data?.ok).toBe(true));
    expect(result.current[0].data).toBe(result.current[1].data);
    expect(result.current[0].data).toMatchObject({ dataAsOf: "2026-10-26T12:00:00.000Z", generatedAt: "2026-10-26T12:00:01.000Z" });
  });

  it("refresh replaces a pending ordinary read with exactly one forced response", async () => {
    const { wrapper } = setup(); const calls = network();
    const { result } = renderHook(() => useSelectedMarketSnapshot("EURUSD", "5m"), { wrapper });
    let first!: Promise<unknown>, duplicate!: Promise<unknown>;
    act(() => { first = result.current.refresh(); duplicate = result.current.refresh(); });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0].signal.aborted).toBe(true); expect(calls[1].url).toContain("refresh=1");
    await act(async () => { answer(calls[1], response("EURUSD", "M5", "forced")); await Promise.all([first, duplicate]); });
    await waitFor(() => expect(result.current.data).toMatchObject({ highlights: { marker: "forced" } }));
    expect(calls).toHaveLength(2);
  });

  it("switching symbols cancels the old request and never displays its data", async () => {
    const { wrapper } = setup(); const calls = network();
    const { result, rerender } = renderHook(({ symbol }) => useSelectedMarketSnapshot(symbol, "5m"), { wrapper, initialProps: { symbol: "EURUSD" } });
    rerender({ symbol: "GBPUSD" });
    expect(calls[0].signal.aborted).toBe(true); expect(result.current.data).toBeUndefined();
    await act(async () => answer(calls[1], response("GBPUSD")));
    await waitFor(() => expect(result.current.data).toMatchObject({ symbol: "GBPUSD" }));
  });

  it("a force-refresh continuation cannot repopulate a cache cleared at logout", async () => {
    const { client, wrapper } = setup(); const calls = network();
    const { result, unmount } = renderHook(() => useSelectedMarketSnapshot("EURUSD", "5m"), { wrapper });
    const promise = result.current.refresh();
    unmount(); client.clear();
    await expect(promise).rejects.toThrow(/session changed/);
    expect(calls).toHaveLength(1); expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("a signed-out/new-user switch does not send an old-user forced request", async () => {
    const { client, wrapper } = setup(); const calls = network();
    const { result } = renderHook(() => useSelectedMarketSnapshot("EURUSD", "5m"), { wrapper });
    const promise = result.current.refresh();
    client.setQueryData(["me"], { id: 8 });
    await expect(promise).rejects.toThrow(/session changed/);
    expect(calls.every((call) => !call.url.includes("refresh=1"))).toBe(true);
  });

  it("failed HTTP and mismatched market responses fail closed", async () => {
    const identity = selectedMarketIdentity(7, "EURUSD", "5m");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    await expect(fetchSelectedMarket(identity, new AbortController().signal)).rejects.toThrow(/500/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response("GBPUSD")))));
    await expect(fetchSelectedMarket(identity, new AbortController().signal)).rejects.toThrow(/does not match/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response("EURUSD", "M15")))));
    await expect(fetchSelectedMarket(identity, new AbortController().signal)).rejects.toThrow(/does not match/);
  });

  it("signed-out reads and refreshes remain disabled", async () => {
    const { client } = setup(); const calls = network();
    expect(selectedMarketQueryOptions(null, "EURUSD", "5m").enabled).toBe(false);
    await expect(refreshSelectedMarket(client, null, "EURUSD", "5m")).rejects.toThrow(/Sign in/);
    expect(calls).toHaveLength(0);
  });

  it("chart candles consume the caller cancellation signal", async () => {
    const calls = network(); const controller = new AbortController();
    const read = fetchChartCandles("EURUSD", "M5", 200, controller.signal);
    controller.abort();
    await expect(read).rejects.toThrow(/Aborted/);
    expect(calls[0].signal).toBe(controller.signal);
  });
});
