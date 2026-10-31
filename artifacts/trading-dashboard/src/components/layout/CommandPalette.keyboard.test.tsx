import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
vi.mock("wouter", () => ({ useLocation: () => ["/", vi.fn()] }));
vi.mock("@/hooks/useViewMode", () => ({ useViewMode: () => ({ effectiveIsAdmin: false }) }));
vi.mock("@/hooks/useProductRole", () => ({ useProductRole: () => ({ isInvestor: false }) }));
vi.mock("@/hooks/useTraderTier", () => ({ useTraderTier: () => ({ isApprovedTrader: true }) }));
vi.mock("@/hooks/useScannerNavigationWarmup", () => ({ useScannerNavigationWarmup: () => vi.fn() }));
vi.mock("@/lib/assistant-name", () => ({ DEFAULT_ASSISTANT_NAME: "ARX", useAssistantName: () => ({ name: "ARX" }) }));
afterEach(cleanup);
it("closes only the active palette before the underlying fullscreen Escape handler", () => {
  const underlyingClose = vi.fn();
  const listener = (e: KeyboardEvent) => { if (!e.defaultPrevented && e.key === "Escape") underlyingClose(); };
  window.addEventListener("keydown", listener);
  try {
    render(<CommandPalette/>);
    fireEvent.click(screen.getByTestId("cmdk-trigger"));
    fireEvent.keyDown(screen.getByTestId("cmdk-input"), { key: "Escape" });
    expect(screen.queryByTestId("cmdk-dialog")).toBeNull();
    expect(underlyingClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(underlyingClose).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("keydown", listener); }
});
it("leaves unrelated and already handled keys alone", () => {
  render(<CommandPalette/>);
  fireEvent.click(screen.getByTestId("cmdk-trigger"));
  const other = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
  window.dispatchEvent(other);
  expect(other.defaultPrevented).toBe(false);
  const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  handled.preventDefault();
  window.dispatchEvent(handled);
  expect(screen.getByTestId("cmdk-dialog")).toBeTruthy();
});
