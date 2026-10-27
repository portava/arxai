import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScannerChartRead } from "./ScannerChartPanel";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function response(headline: string): Response {
  return { ok: true, json: async () => ({ draftRead: { headline } }) } as Response;
}
const fetchMock = vi.fn<typeof fetch>(), failed = vi.fn();
function setup() {
  return renderHook(({ symbol, timeframe }) => useScannerChartRead(symbol, timeframe, "Ruby", failed), {
    initialProps: { symbol: "EURUSD", timeframe: "15m" },
  });
}
beforeEach(() => { fetchMock.mockReset(); failed.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("scanner chart assistant read context", () => {
  for (const next of [{ symbol: "GBPUSD", timeframe: "15m" }, { symbol: "EURUSD", timeframe: "1h" }]) {
    it(`cancels and ignores delayed A after switching to ${next.symbol}/${next.timeframe}`, async () => {
      const a = deferred<Response>(), b = deferred<Response>();
      fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
      const { result, rerender } = setup();
      const oldAsk = result.current.ask;
      let aDone!: Promise<void>, bDone!: Promise<void>;
      act(() => { aDone = result.current.ask("analyze"); });
      const signal = fetchMock.mock.calls[0]![1]!.signal!;
      expect(result.current.busy).toBe(true);
      rerender(next);
      expect(signal.aborted).toBe(true);
      expect(result.current.busy).toBe(false);
      expect(result.current.read).toBeNull();
      await act(async () => { await oldAsk("analyze"); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      act(() => { bDone = result.current.ask("agent-consensus"); });
      await act(async () => { a.resolve(response("old A")); await aDone; });
      expect(result.current.read).toBeNull();
      expect(result.current.busy).toBe(true);
      await act(async () => { b.resolve(response("current B")); await bDone; });
      expect(result.current.read?.headline).toBe("current B");
      expect(result.current.read?.title).toBe(`Agent view — ${next.symbol} (${next.timeframe === "1h" ? "H1" : "M15"})`);
      expect(result.current.busy).toBe(false);
      expect(failed).not.toHaveBeenCalled();
    });
  }
  it("masks a visible old read in the first render of a new context", async () => {
    fetchMock.mockResolvedValue(response("old A"));
    const observed: Array<{ symbol: string; headline: string | undefined }> = [];
    const { result, rerender } = renderHook(({ symbol }) => {
      const value = useScannerChartRead(symbol, "15m", "Ruby", failed);
      observed.push({ symbol, headline: value.read?.headline });
      return value;
    }, { initialProps: { symbol: "EURUSD" } });
    await act(async () => { await result.current.ask("analyze"); });
    expect(result.current.read?.headline).toBe("old A");
    rerender({ symbol: "GBPUSD" });
    expect(observed.filter((row) => row.symbol === "GBPUSD").every((row) => row.headline === undefined)).toBe(true);
  });
  it("ignores stale rejection and finally while the new context is loading", async () => {
    const a = deferred<Response>(), b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result, rerender } = setup();
    let aDone!: Promise<void>, bDone!: Promise<void>;
    act(() => { aDone = result.current.ask("analyze"); });
    rerender({ symbol: "GBPUSD", timeframe: "1h" });
    act(() => { bDone = result.current.ask("analyze"); });
    await act(async () => { a.reject(new Error("old failure")); await aDone; });
    expect(failed).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);
    await act(async () => { b.resolve(response("B")); await bDone; });
    expect(result.current.read?.headline).toBe("B");
  });
  it("latest read wins when the same context is requested twice", async () => {
    const a = deferred<Response>(), b = deferred<Response>();
    fetchMock.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = setup();
    let aDone!: Promise<void>, bDone!: Promise<void>;
    act(() => { aDone = result.current.ask("analyze"); });
    act(() => { bDone = result.current.ask("agent-consensus"); });
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await act(async () => { b.resolve(response("B")); await bDone; });
    await act(async () => { a.resolve(response("A")); await aDone; });
    expect(result.current.read?.headline).toBe("B");
  });
  it("abort reaches transport and retained callbacks cannot run after unmount", async () => {
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const { result, unmount } = setup();
    const oldAsk = result.current.ask;
    let done!: Promise<void>;
    act(() => { done = result.current.ask("analyze"); });
    const signal = fetchMock.mock.calls[0]![1]!.signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { await done; await oldAsk("analyze"); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });
  it("closing the read prevents a pending refresh from reopening it", async () => {
    const pending = deferred<Response>();
    fetchMock.mockResolvedValueOnce(response("visible")).mockReturnValueOnce(pending.promise);
    const { result } = setup();
    await act(async () => { await result.current.ask("analyze"); });
    let done!: Promise<void>;
    act(() => { done = result.current.ask("analyze"); });
    act(() => result.current.clear());
    expect(fetchMock.mock.calls[1]![1]!.signal!.aborted).toBe(true);
    await act(async () => { pending.resolve(response("late")); await done; });
    expect(result.current.read).toBeNull();
    expect(result.current.busy).toBe(false);
  });
  it("reports current failure and labels the actual supported analysis timeframe", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response).mockResolvedValueOnce(response("H4 read"));
    const { result, rerender } = setup();
    await act(async () => { await result.current.ask("analyze"); });
    expect(failed).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(false);
    rerender({ symbol: "EURUSD", timeframe: "8h" });
    await act(async () => { await result.current.ask("analyze"); });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).timeframe).toBe("H4");
    expect(result.current.read?.title).toBe("Ruby read — EURUSD (H4)");
  });
});
