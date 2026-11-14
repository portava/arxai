// The chart toolbar keeps one row of navigation, drawing and study controls;
// display and date controls stay mounted but folded until asked for.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartWorkbenchTools } from "./ChartWorkbenchTools";
import { DEFAULT_PREFERENCES } from "@/lib/chart-engine/chartWorkspace";
import type { ChartEngineAdapter } from "@/lib/chart-engine";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("chart toolbar groups", () => {
  it("keeps one row and opens drawing, display and date controls from menus, one at a time", () => {
    const adapter = {} as unknown as ChartEngineAdapter;
    render(<ChartWorkbenchTools adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={DEFAULT_PREFERENCES}
      onPreferences={vi.fn()} hasCandles feedLabel="mt5_broker" />);
    const popup = (name: string) => ({ toggle: screen.getByTestId(`chart-${name}-toggle`), controls: screen.getByTestId(`chart-${name}-controls`) });
    const drawing = popup("drawing"), display = popup("display"), goTo = popup("goto");
    for (const menu of [drawing, display, goTo]) {
      expect(menu.controls.className).toBe("hidden");
      expect(menu.toggle.getAttribute("aria-expanded")).toBe("false");
      expect(menu.toggle.getAttribute("aria-controls")).toBe(menu.controls.id);
    }
    // Each control lives in exactly one menu; none is left loose in the row.
    for (const label of ["Price scale", "Chart style", "Display time zone"]) expect(within(display.controls).getByLabelText(label)).toBeTruthy();
    expect(within(display.controls).getByRole("button", { name: "Export PNG" })).toBeTruthy();
    expect(within(goTo.controls).getByRole("button", { name: "1D" })).toBeTruthy();
    expect(within(drawing.controls).getByRole("button", { name: /Magnet/ })).toBeTruthy();
    expect(within(drawing.controls).getByRole("button", { name: /Objects/ })).toBeTruthy();
    // The drawing tool, undo and redo stay in the always-visible row.
    const row = screen.getByRole("group", { name: "Drawing" });
    expect(within(row).getByLabelText("Drawing tool")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Redo" })).toBeTruthy();

    fireEvent.click(display.toggle);
    expect(display.controls.className).toContain("absolute"); expect(display.toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(goTo.toggle);
    expect(display.controls.className).toBe("hidden"); expect(goTo.controls.className).toContain("absolute");
    // Escape closes the open menu and returns focus to its button.
    fireEvent.keyDown(within(goTo.controls).getByRole("button", { name: "1D" }), { key: "Escape" });
    expect(goTo.controls.className).toBe("hidden"); expect(document.activeElement).toBe(goTo.toggle);
    // A press outside the menu closes it.
    fireEvent.click(drawing.toggle);
    expect(drawing.controls.className).toContain("absolute");
    fireEvent.pointerDown(document.body);
    expect(drawing.controls.className).toBe("hidden");
  });
});
