import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar";

vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => ({ data: { connected: true, mode: "DEMO" } }),
  useGetBotStatus: () => ({ data: null }),
  getGetMt5StatusQueryKey: () => ["mt5"],
  getGetBotStatusQueryKey: () => ["bot"],
}));
vi.mock("@/components/layout/SymbolPicker", () => ({ SymbolPicker: () => <span>V25_1S</span> }));
vi.mock("@/components/alerts/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/hooks/useFeatureUnlock", () => ({ useAllUnlocks: () => ({ mt5: true, simulator: false }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: null }), useLogout: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ canToggle: false }) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(["2026-11-01T09:00:00Z", "2026-11-02T15:00:00Z", "2026-11-02T22:00:00Z"])(
  "does not promote wall-clock time or broker connection to a verified session at %s", (now) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
    render(<Topbar />);
    const pill = screen.getByTestId("status-pill-session");
    expect(pill.textContent).toBe("Session:Unverified");
    expect(pill.className).not.toMatch(/emerald|amber/);
    expect(screen.getByTestId("badge-session").textContent).toBe("Unverified");
  },
);

it("keeps the fixed UTC estimate qualified in details and updates after a clock boundary", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-02T12:59:30Z"));
  render(<Topbar />);
  fireEvent.click(screen.getByRole("button", { name: "Open detailed status" }));
  expect(screen.getByText("London (estimate)")).toBeTruthy();
  expect(screen.getByText(/does not verify the selected market/)).toBeTruthy();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByText("New York (estimate)")).toBeTruthy();
  expect(screen.getByTestId("status-pill-session").textContent).toBe("Session:Unverified");
});

it("starts no reference-clock timer until details open and cleans it up on unmount", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-02T06:00:00Z"));
  const start = vi.spyOn(window, "setInterval");
  const stop = vi.spyOn(window, "clearInterval");
  const removeFocus = vi.spyOn(window, "removeEventListener");
  const removeVisibility = vi.spyOn(document, "removeEventListener");
  const view = render(<Topbar />);
  expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open detailed status" }));
  expect(start).toHaveBeenCalledTimes(1);
  const interval = start.mock.results[0]!.value;
  expect(screen.getByText("Asia (estimate)")).toBeTruthy();
  vi.setSystemTime(new Date("2026-11-02T09:00:00Z"));
  fireEvent.focus(window);
  expect(screen.getByText("London (estimate)")).toBeTruthy();
  vi.setSystemTime(new Date("2026-11-02T22:00:00Z"));
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.getByText("Outside reference windows (estimate)")).toBeTruthy();
  view.unmount();
  expect(stop).toHaveBeenCalledWith(interval);
  expect(removeFocus).toHaveBeenCalledWith("focus", expect.any(Function));
  expect(removeVisibility).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
});
