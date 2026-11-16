import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TickingTime } from "./TickingTime";
const start = Date.parse("2026-10-31T20:00:00Z");
const format = (stamp: string, now: number) => `${Math.round((now - Date.parse(stamp)) / 1000)} seconds old`;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("updates age text while leaving its parent untouched", () => {
  let parentRenders = 0;
  function Parent() { parentRenders++; return <TickingTime timestamp={new Date(start).toISOString()} format={format}/>; }
  render(<Parent/>); act(() => { vi.advanceTimersByTime(5_000); });
  expect(screen.getByText("5 seconds old")).toBeTruthy(); expect(parentRenders).toBe(1);
});
it("refreshes a new timestamp immediately and does not invent an age for invalid data", () => {
  const view = render(<TickingTime timestamp={new Date(start).toISOString()} format={format}/>);
  act(() => { vi.advanceTimersByTime(4_000); });
  view.rerender(<TickingTime timestamp={new Date(start + 4_000).toISOString()} format={format}/>);
  expect(screen.getByText("0 seconds old")).toBeTruthy();
  view.rerender(<TickingTime timestamp="invalid" format={format}/>);
  expect(screen.getByText("Time unavailable")).toBeTruthy(); expect(vi.getTimerCount()).toBe(0);
});
it("stops hidden work, catches up on return, and removes timers on unmount", () => {
  const view = render(<TickingTime timestamp={new Date(start).toISOString()} format={format}/>);
  Object.defineProperty(document, "hidden", { configurable: true, value: true });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); }); expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(start + 60_000); Object.defineProperty(document, "hidden", { configurable: true, value: false });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(screen.getByText("60 seconds old")).toBeTruthy(); expect(vi.getTimerCount()).toBe(1);
  act(() => { window.dispatchEvent(new Event("focus")); }); expect(vi.getTimerCount()).toBe(1);
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
