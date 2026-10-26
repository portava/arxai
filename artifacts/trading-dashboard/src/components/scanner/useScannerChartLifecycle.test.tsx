import { useEffect, useLayoutEffect } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScannerChartLifecycle } from "./useScannerChartLifecycle";

afterEach(cleanup);

describe("scanner canvas lifecycle", () => {
  it("reuses the engine while clearing each cached context before other layout work can observe it", () => {
    let pixels: string | null = null;
    const dispose = vi.fn(), create = vi.fn(() => dispose), beforePaint: Array<string | null> = [];
    const { rerender, unmount } = renderHook(({ context }) => {
      useScannerChartLifecycle(true, context, create, () => { pixels = null; });
      useLayoutEffect(() => { beforePaint.push(pixels); }, [context]);
      useEffect(() => { pixels = context; }, [context]);
    }, { initialProps: { context: "EURUSD/M15/mt5/account-A" } });
    for (const context of ["GBPUSD/M15/mt5/account-A", "GBPUSD/H1/mt5/account-A", "GBPUSD/H1/deriv_public", "GBPUSD/H1/mt5/account-B"]) {
      rerender({ context });
      expect(pixels).toBe(context);
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(beforePaint).toEqual([null, null, null, null, null]);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves the viewport and geometry on ordinary same-context rerenders", () => {
    let viewport = "initial";
    const create = vi.fn(() => vi.fn()), reset = vi.fn(() => { viewport = "initial"; });
    const { rerender } = renderHook(({ revision }) => {
      useScannerChartLifecycle(true, "EURUSD/M15/mt5", () => create(), () => { void revision; reset(); });
    }, { initialProps: { revision: 1 } });
    viewport = "user panned/drew";
    rerender({ revision: 2 });
    expect(viewport).toBe("user panned/drew");
    expect(create).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("removes an unavailable context and creates only the latest context when data returns", () => {
    const created: string[] = [], reset: string[] = [], dispose = vi.fn();
    const { rerender, unmount } = renderHook(({ available, context }) => {
      useScannerChartLifecycle(available, context, () => { created.push(context); return dispose; }, () => { reset.push(context); });
    }, { initialProps: { available: true, context: "A" } });
    rerender({ available: false, context: "B" });
    expect(dispose).toHaveBeenCalledTimes(1);
    rerender({ available: false, context: "C" });
    rerender({ available: true, context: "C" });
    expect(created).toEqual(["A", "C"]);
    expect(reset).toEqual(["A", "C"]);
    unmount();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
