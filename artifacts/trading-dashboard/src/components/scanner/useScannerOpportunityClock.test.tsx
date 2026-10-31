import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScannerOpportunityClock } from "./useScannerOpportunityClock";
import { canUseScannerOpportunity } from "./scannerMapFreshness";
const epoch = Date.parse("2026-10-31T20:00:00Z");
const stamp = (time: number) => new Date(time).toISOString();
const live = (time = epoch) => ({ dataStatus: "live", tradeable: true, generatedAt: stamp(time), scanGeneratedAt: stamp(time) });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("does no periodic work with empty or permanently unavailable rows", () => {
  let renders = 0;
  renderHook(() => { renders++; return useScannerOpportunityClock([{ ...live(), dataStatus: "no_data" }, { ...live(), tradeable: false }, { ...live(), generatedAt: "bad", scanGeneratedAt: "bad" }], null); });
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(renders).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it("expires at the first millisecond outside the unchanged 30 second rule", () => {
  let renders = 0; const row = live();
  const view = renderHook(() => { renders++; const now = useScannerOpportunityClock([row], null); return canUseScannerOpportunity(row, now); });
  act(() => { vi.advanceTimersByTime(30_000); });
  expect(renders).toBe(1); expect(view.result.current).toBe(true);
  act(() => { vi.advanceTimersByTime(1); });
  expect(view.result.current).toBe(false); expect(renders).toBe(2); expect(vi.getTimerCount()).toBe(0);
});
it("tracks row and scan timestamps separately and future skew admission", () => {
  const row = { ...live(epoch + 10_000), scanGeneratedAt: stamp(epoch - 20_000) };
  const view = renderHook(() => canUseScannerOpportunity(row, useScannerOpportunityClock([row], null)));
  expect(view.result.current).toBe(false);
  act(() => { vi.advanceTimersByTime(5_000); }); expect(view.result.current).toBe(true);
  act(() => { vi.advanceTimersByTime(5_001); }); expect(view.result.current).toBe(false);
});
it("also expires the older row held by an open ticket", () => {
  const held = live(epoch - 29_000), fresh = live();
  const view = renderHook(() => canUseScannerOpportunity(held, useScannerOpportunityClock([fresh], held)));
  act(() => { vi.advanceTimersByTime(1_001); }); expect(view.result.current).toBe(false);
});
it("reads the current time when replacement rows arrive, cancels old boundaries and cleans up", () => {
  const view = renderHook(({ row }) => canUseScannerOpportunity(row, useScannerOpportunityClock([row], null)), { initialProps: { row: live() } });
  act(() => { vi.advanceTimersByTime(20_000); });
  view.rerender({ row: live(epoch + 20_000) });
  act(() => { vi.advanceTimersByTime(10_001); }); expect(view.result.current).toBe(true);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it("refreshes expired displays when returning after clock changes or background suspension", () => {
  const row = live(); const view = renderHook(() => canUseScannerOpportunity(row, useScannerOpportunityClock([row], null)));
  vi.setSystemTime(epoch + 60_000);
  act(() => { window.dispatchEvent(new Event("focus")); }); expect(view.result.current).toBe(false);
  vi.setSystemTime(epoch);
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); }); expect(view.result.current).toBe(true);
});
it("clamps far-future boundaries and rearms without an immediate timer loop", () => {
  const row = live(epoch + 0x7fffffff + 20_000); let renders = 0;
  const view = renderHook(() => { renders++; return canUseScannerOpportunity(row, useScannerOpportunityClock([row], null)); });
  act(() => { vi.advanceTimersByTime(0x7fffffff); }); expect(renders).toBe(2); expect(view.result.current).toBe(false);
  act(() => { vi.advanceTimersByTime(15_000); }); expect(view.result.current).toBe(true);
});
