import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScannerAnalysisMount } from "./ScannerAnalysisMount";
let frame: FrameRequestCallback;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", vi.fn(fn => { frame = fn; return 11; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("honestly marks loading and mounts the latest children after yielding", () => {
  const child = vi.fn(() => <button>Analysis action</button>);
  const Child = child;
  const view = render(<ScannerAnalysisMount><Child /></ScannerAnalysisMount>);
  expect(child).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("Loading");
  expect(screen.getByTestId("scanner-analysis-mount").getAttribute("aria-busy")).toBe("true");
  view.rerender(<ScannerAnalysisMount><span>Latest market</span><Child /></ScannerAnalysisMount>);
  act(() => frame(0));
  expect(child).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText("Latest market")).toBeTruthy();
  expect(screen.getByRole("button")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByTestId("scanner-analysis-mount").getAttribute("aria-busy")).toBe("false");
});
it("cancels callbacks when leaving the Scanner before the frame", () => {
  const Child = vi.fn(() => <span>Late analysis</span>);
  const view = render(<ScannerAnalysisMount><Child /></ScannerAnalysisMount>);
  view.unmount();
  act(() => { frame(0); vi.runAllTimers(); });
  expect(cancelAnimationFrame).toHaveBeenCalledWith(11);
  expect(Child).not.toHaveBeenCalled();
});
it("does not wait forever when frame delivery is suspended", () => {
  render(<ScannerAnalysisMount><span>Ready</span></ScannerAnalysisMount>);
  act(() => vi.advanceTimersByTime(100));
  expect(screen.getByText("Ready")).toBeTruthy();
});
it("mounts on background transition instead of waiting for a throttled frame", () => {
  render(<ScannerAnalysisMount><span>Ready</span></ScannerAnalysisMount>);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.getByText("Ready")).toBeTruthy();
});
it("does not defer without a frame API", () => {
  vi.stubGlobal("requestAnimationFrame", undefined);
  render(<ScannerAnalysisMount><span>Ready</span></ScannerAnalysisMount>);
  expect(screen.getByText("Ready")).toBeTruthy();
});
