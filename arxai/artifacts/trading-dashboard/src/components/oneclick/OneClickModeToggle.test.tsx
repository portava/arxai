// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const oc = {
  mode: { on: false, scope: "demo" as "live" | "demo" | null, canEnable: true, blockReason: null as string | null, defaultVolume: 0.01, maxLotPerClick: null, loading: false },
  switching: false,
  busyKey: null,
  enable: vi.fn(async () => ({ ok: true, error: null })),
  disable: vi.fn(async () => ({ ok: true, error: null })),
  execute: vi.fn(),
  closePosition: vi.fn(),
};
vi.mock("@/hooks/useOneClickMode", () => ({ useOneClickMode: () => oc }));

import { OneClickModeToggle } from "./OneClickModeToggle";
import { ONE_CLICK_MODE_CHANGES } from "./OneClickModeDisclaimer";

afterEach(() => { cleanup(); toast.mockReset(); oc.enable.mockClear(); oc.disable.mockClear(); oc.mode = { ...oc.mode, on: false, scope: "demo", canEnable: true, blockReason: null }; });

describe("OneClickModeToggle", () => {
  it("OFF → click opens the disclaimer; enable() is only called after the checkbox + accept", async () => {
    render(<OneClickModeToggle />);
    const btn = screen.getByTestId("one-click-mode-toggle");
    expect(btn.getAttribute("data-state")).toBe("off");
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId("one-click-disclaimer")).toBeTruthy());
    expect(oc.enable).not.toHaveBeenCalled();

    // Every system-wide change is listed, and the Buy/Sell + Close lines are there.
    const items = screen.getByTestId("one-click-disclaimer-changes").querySelectorAll("li");
    expect(items.length).toBe(ONE_CLICK_MODE_CHANGES.length);
    expect(screen.getByTestId("one-click-disclaimer-changes").textContent).toMatch(/Buy and Sell buttons .* No ticket, no confirmation/);
    expect(screen.getByTestId("one-click-disclaimer-changes").textContent).toMatch(/Close \(×\) on any open position/);

    const accept = screen.getByTestId("one-click-disclaimer-accept") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("one-click-disclaimer-agree"));
    await waitFor(() => expect(accept.disabled).toBe(false));
    fireEvent.click(accept);
    await waitFor(() => expect(oc.enable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "One-click ON (DEMO)" })));
  });

  it("ON → click turns the mode off immediately, no dialog", async () => {
    oc.mode = { ...oc.mode, on: true, scope: "live" };
    render(<OneClickModeToggle />);
    const btn = screen.getByTestId("one-click-mode-toggle");
    expect(btn.getAttribute("data-state")).toBe("on");
    expect(btn.textContent).toMatch(/1-Click ON/);
    fireEvent.click(btn);
    await waitFor(() => expect(oc.disable).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("one-click-disclaimer")).toBeNull();
  });

  it("a live account that cannot arm gets a disabled switch with the reason, and the disclaimer's accept stays locked", () => {
    oc.mode = { ...oc.mode, on: false, scope: "live", canEnable: false, blockReason: "Your live trading access is not yet fully approved." };
    render(<OneClickModeToggle />);
    const btn = screen.getByTestId("one-click-mode-toggle") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/not yet fully approved/);
  });

  it("renders nothing for an account mode without one-click (paper)", () => {
    oc.mode = { ...oc.mode, scope: null, canEnable: false };
    render(<OneClickModeToggle />);
    expect(screen.queryByTestId("one-click-mode-toggle")).toBeNull();
  });
});
