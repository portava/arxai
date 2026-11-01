import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHART_READ_REQUEST_TIMEOUT_MS, RubyReadStoreProvider, useRubyReadStore } from "./rubyReadStore";
import type { ChartRead } from "@/lib/rubyReadPanelState";
import { resolveCappedRubyReadStatus } from "@/lib/rubyReadPanelState";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const full = (bias: string, symbol = "EURUSD", timeframe = "M5"): ChartRead => ({ symbol, timeframe, gated: false, readLayer: "FULL", liveSetupWithheld: false, canShowLiveTradeSetup: true, bias });
function deferred() {
  let resolve!: (r: ChartRead) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<ChartRead>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const useStore = () => renderHook(useRubyReadStore, { wrapper: RubyReadStoreProvider });

describe("chart assessment completion ordering", () => {
  it("bounds a hung transport, permits retry, and ignores the late response", async () => {
    vi.useFakeTimers();
    const { result } = useStore(); const old = deferred(); let signal!: AbortSignal;
    act(() => { void result.current.request("EURUSD", "M5", s => { signal = s; return old.promise; }); });
    await act(async () => vi.advanceTimersByTimeAsync(CHART_READ_REQUEST_TIMEOUT_MS));
    expect(signal.aborted).toBe(true);
    expect(result.current.requestState("EURUSD", "M5").loading).toBe(false);
    expect(result.current.get("EURUSD", "M5")?.gated).toBe(true);
    await act(async () => result.current.request("EURUSD", "M5", async () => full("Bearish")));
    await act(async () => old.resolve(full("Bullish")));
    expect(result.current.get("EURUSD", "M5")?.bias).toBe("Bearish");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts outstanding work when the provider leaves and settles the caller", async () => {
    vi.useFakeTimers();
    const { result, unmount } = useStore(); let signal!: AbortSignal; let done!: Promise<void>;
    act(() => { done = result.current.request("EURUSD", "M5", s => { signal = s; return new Promise(() => {}); }); });
    unmount();
    await done;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts the service's structural read and older market-resolution refusal", async () => {
    const { result } = useStore();
    const structural: ChartRead = { symbol: "EURUSD", timeframe: "M5", gated: false, bias: "Bearish", readLayer: "STRUCTURAL_ONLY", liveSetupWithheld: true, canShowLiveTradeSetup: false, blockedReason: "Source clock unverified" };
    await act(async () => result.current.request("EURUSD", "M5", async () => structural));
    expect(result.current.get("EURUSD", "M5")).toEqual(structural);
    const refusal: ChartRead = { symbol: "EURUSD", timeframe: "M5", gated: true, dataQuality: "insufficient", headline: "Market unavailable" };
    await act(async () => result.current.request("EURUSD", "M5", async () => refusal));
    expect(result.current.get("EURUSD", "M5")).toEqual(refusal);
    expect(result.current.requestState("EURUSD", "M5").error).toBeNull();
  });

  it("captures synchronous loader errors without leaving a loading lock", async () => {
    const { result } = useStore();
    await act(async () => result.current.request("EURUSD", "M5", () => { throw new Error("failed before fetch"); }));
    expect(result.current.requestState("EURUSD", "M5")).toEqual({ loading: false, error: "failed before fetch" });
    expect(result.current.get("EURUSD", "M5")?.gated).toBe(true);
  });

  it.each(["success", "failure"])("ignores an older %s after the newer result", async outcome => {
    const { result } = useStore();
    const a = deferred(), b = deferred();
    act(() => { void result.current.request("EURUSD", "M5", () => a.promise); });
    act(() => { void result.current.request("eurusd", "M5", () => b.promise); });
    await act(async () => b.resolve(full("Bearish")));
    await act(async () => outcome === "success" ? a.resolve(full("Bullish")) : a.reject(new Error("old failure")));
    expect(result.current.get("EURUSD", "M5")?.bias).toBe("Bearish");
    expect(result.current.requestState("EURUSD", "M5")).toEqual({ loading: false, error: null });
  });

  it("an old failure cannot end the newer loading state or restore its old read", async () => {
    const { result } = useStore();
    const a = deferred(), b = deferred();
    act(() => {
      result.current.set("EURUSD", "M5", full("Bullish"));
      void result.current.request("EURUSD", "M5", () => a.promise);
      void result.current.request("EURUSD", "M5", () => b.promise);
    });
    await act(async () => a.reject(new Error("old")));
    expect(result.current.requestState("EURUSD", "M5")).toEqual({ loading: true, error: null });
    expect(result.current.get("EURUSD", "M5")?.bias).toBeUndefined();
    expect(resolveCappedRubyReadStatus("FULL_READ", result.current.get("EURUSD", "M5"), undefined).status).toBe("LIMITED_READ");
    await act(async () => b.resolve(full("Bearish")));
  });

  it("explicit clear invalidates an outstanding completion", async () => {
    const { result } = useStore(); const a = deferred();
    act(() => { void result.current.request("EURUSD", "M5", () => a.promise); });
    act(() => result.current.set("EURUSD", "M5", null));
    await act(async () => a.resolve(full("Bullish")));
    expect(result.current.get("EURUSD", "M5")).toBeNull();
  });

  it("does not mix markets, timeframes or delimiter-containing keys", async () => {
    const { result } = useStore();
    await act(async () => {
      await result.current.request("EURUSD", "M5", async () => (full("Bullish")));
      await result.current.request("GBPUSD", "M5", async () => full("Bearish", "GBPUSD"));
      await result.current.request("EURUSD", "H1", async () => full("Ranging", "EURUSD", "H1"));
      result.current.set("A|B", "C", { bias: "First" });
      result.current.set("A", "B|C", { bias: "Second" });
    });
    expect(result.current.get("EURUSD", "M5")?.bias).toBe("Bullish");
    expect(result.current.get("GBPUSD", "M5")?.bias).toBe("Bearish");
    expect(result.current.get("EURUSD", "H1")?.bias).toBe("Ranging");
    expect(result.current.get("A|B", "C")?.bias).toBe("First");
    expect(result.current.get("A", "B|C")?.bias).toBe("Second");
  });

  it.each([null, undefined, [], "Bullish", {}, { gated: "false" }, { gated: false }, { ...full("Bullish"), bias: {} }, { ...full("Bullish"), canShowLiveTradeSetup: "true" }, { ...full("Bullish"), liveSetupWithheld: true }, { ...full("Bullish"), cautions: [42] }])("withholds an invalid response %j", async value => {
    const { result } = useStore();
    await act(async () => { await result.current.request("EURUSD", "M5", async () => value as ChartRead); });
    expect(result.current.get("EURUSD", "M5")?.gated).toBe(true);
    expect(result.current.requestState("EURUSD", "M5").error).toMatch(/Invalid chart read response|does not match/);
  });
});
