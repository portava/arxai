import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_INTERVALS, chartIntervalDisplayId } from "@/lib/chart-engine/chartIntervals";
import { loadScannerTimeframe, useScannerTimeframe } from "./useScannerTimeframe";

const KEY = "scanner.chart.timeframe";
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("shared Scanner interval bus", () => {
  it.each(CHART_INTERVALS)("restores supported %s and broadcasts its exact context", timeframe => {
    const display = chartIntervalDisplayId(timeframe);
    localStorage.setItem(KEY,timeframe);
    const a=renderHook(useScannerTimeframe), b=renderHook(useScannerTimeframe);
    expect(a.result.current[0]).toBe(display);
    expect(b.result.current[0]).toBe(display);
    act(() => a.result.current[1]("M15"));
    act(() => a.result.current[1](timeframe));
    expect(a.result.current[0]).toBe(display);
    expect(b.result.current[0]).toBe(display);
    expect(localStorage.getItem(KEY)).toBe(display);
  });
  it.each([["W1","1w"],["MN1","1mo"],["1M","1mo"]])("preserves unavailable %s through storage and events", (code,display) => {
    localStorage.setItem(KEY,code!);
    const a=renderHook(useScannerTimeframe), b=renderHook(useScannerTimeframe);
    expect(a.result.current[0]).toBe(display);
    act(() => a.result.current[1](code!));
    expect(b.result.current[0]).toBe(display);
    expect(localStorage.getItem(KEY)).toBe(display);
  });
  it("delivers the choice to every mounted consumer even when storage writes fail", () => {
    localStorage.setItem(KEY,"15m");
    const a=renderHook(useScannerTimeframe), b=renderHook(useScannerTimeframe);
    vi.spyOn(Storage.prototype,"setItem").mockImplementation(() => {throw new Error("storage unavailable");});
    act(() => a.result.current[1]("H12"));
    expect(a.result.current[0]).toBe("12h");
    expect(b.result.current[0]).toBe("12h");
    expect(localStorage.getItem(KEY)).toBe("15m");
  });
  it("can mount when storage reads are denied", () => {
    vi.spyOn(Storage.prototype,"getItem").mockImplementation(() => {throw new Error("storage unavailable");});
    expect(loadScannerTimeframe()).toBe("15m");
    const a=renderHook(useScannerTimeframe), b=renderHook(useScannerTimeframe);
    act(() => a.result.current[1]("M2"));
    expect(a.result.current[0]).toBe("2m");
    expect(b.result.current[0]).toBe("2m");
  });
  it("handles legacy same-tab events and exact cross-tab storage events", () => {
    const a=renderHook(useScannerTimeframe);
    localStorage.setItem(KEY,"H12");
    act(() => window.dispatchEvent(new CustomEvent("scanner:timeframe")));
    expect(a.result.current[0]).toBe("12h");
    localStorage.setItem(KEY,"M2");
    act(() => window.dispatchEvent(new StorageEvent("storage",{key:"unrelated"})));
    expect(a.result.current[0]).toBe("12h");
    act(() => window.dispatchEvent(new StorageEvent("storage",{key:KEY})));
    expect(a.result.current[0]).toBe("2m");
  });
  it("falls back only for an unrecognized stored interval", () => {
    localStorage.setItem(KEY,"M60");
    expect(loadScannerTimeframe()).toBe("15m");
  });
});
