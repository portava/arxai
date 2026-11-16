import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ToolbarPopup } from "./ToolbarPopup";

const box = (left: number, right: number, top = 0, bottom = 32) =>
  ({ left, right, top, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) }) as DOMRect;

// The desktop Tools window: an overflow-auto panel (991–1407) narrower than the
// 416 px popover, inside a 24–1416 chart card, at a 1440 px window.
function renderInTools() {
  window.innerWidth = 1440;
  render(
    <div data-testid="arx-native-chart" style={{ overflow: "hidden" }}>
      <div data-testid="tools-panel" style={{ overflow: "auto" }}>
        <ToolbarPopup testId="chart-history" popupLabel="Loaded history" label="History · 5000">
          <button type="button">Fit history</button>
        </ToolbarPopup>
      </div>
    </div>,
  );
  const rects: Record<string, DOMRect> = {
    "arx-native-chart": box(24, 1416), "tools-panel": box(991, 1407), "chart-history-toggle": box(1095, 1235),
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return rects[this.dataset.testid ?? ""] ?? box(0, 0, 0, 0);
  });
  fireEvent.click(screen.getByTestId("chart-history-toggle"));
  return screen.getByTestId("chart-history-controls");
}

describe("ToolbarPopup inside a clipping tools panel", () => {
  afterEach(() => vi.restoreAllMocks());
  it("opens fully inside the panel instead of being cut off at its edge", () => {
    const popup = renderInTools();
    const maxWidth = parseFloat(popup.style.maxWidth);
    // Anchored either at the trigger's left (style.left offset) or right edge.
    const left = popup.style.right === "0px" ? 1235 - maxWidth : 1095 + parseFloat(popup.style.left || "0");
    // Without the fix the popover starts at the trigger (1095) and is 416 px
    // wide: its right part (to 1511) is clipped, under the candle inspector.
    expect(Number.isFinite(maxWidth)).toBe(true);
    expect(left).toBeGreaterThanOrEqual(991 + 8);
    expect(left + maxWidth).toBeLessThanOrEqual(1407 - 8);
  });
});
