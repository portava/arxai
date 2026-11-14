// The chart toolbar keeps one row of navigation, drawing and study controls;
// display and date controls stay mounted but folded until asked for.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChartWorkbenchTools } from "./ChartWorkbenchTools";
import { DEFAULT_PREFERENCES } from "@/lib/chart-engine/chartWorkspace";
import type { ChartEngineAdapter } from "@/lib/chart-engine";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("chart toolbar groups", () => {
  it("folds display and date controls behind one toggle each and opens only one at a time", () => {
    const adapter = {} as unknown as ChartEngineAdapter;
    render(<ChartWorkbenchTools adapter={adapter} epoch={1} symbol="EURUSD" timeframe="M15" preferences={DEFAULT_PREFERENCES}
      onPreferences={vi.fn()} hasCandles feedLabel="mt5_broker" />);
    const display = screen.getByTestId("chart-display-controls"), goTo = screen.getByTestId("chart-goto-controls");
    const displayToggle = screen.getByTestId("chart-display-toggle"), goToToggle = screen.getByTestId("chart-goto-toggle");
    expect(display.className).toBe("hidden"); expect(goTo.className).toBe("hidden");
    expect(displayToggle.getAttribute("aria-expanded")).toBe("false");
    // Every display control lives in the display group; none is left loose in the row.
    for (const label of ["Price scale", "Chart style", "Display time zone"]) expect(within(display).getByLabelText(label)).toBeTruthy();
    expect(within(display).getByRole("button", { name: "Export PNG" })).toBeTruthy();
    expect(within(goTo).getByRole("button", { name: "1D" })).toBeTruthy();
    // Drawing controls stay in the always-visible row.
    const drawing = screen.getByRole("group", { name: "Drawing" });
    expect(within(drawing).getByLabelText("Drawing tool")).toBeTruthy();
    expect(within(drawing).getByRole("button", { name: "Undo" })).toBeTruthy();

    fireEvent.click(displayToggle);
    expect(display.className).not.toBe("hidden"); expect(displayToggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(goToToggle);
    expect(display.className).toBe("hidden"); expect(goTo.className).not.toBe("hidden");
    fireEvent.click(goToToggle);
    expect(goTo.className).toBe("hidden"); expect(goToToggle.getAttribute("aria-expanded")).toBe("false");
  });
});
