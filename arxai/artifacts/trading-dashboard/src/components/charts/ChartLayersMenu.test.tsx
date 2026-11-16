import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChartLayersMenu } from "./ChartLayersMenu";
import { allLayers, CHART_LAYERS } from "@/lib/chart-engine/layers";

describe("ChartLayersMenu", () => {
  it("exposes all 18 layer switches and applies Show all / Hide all", () => {
    const onChange = vi.fn();
    render(
      <ChartLayersMenu
        value={allLayers(true)}
        onChange={onChange}
        availability={{}}
      />,
    );

    fireEvent.click(screen.getByTestId("chart-layers-menu"));
    const dialog = screen.getByText("Chart layers").parentElement?.parentElement;
    expect(dialog).not.toBeNull();
    expect(within(dialog as HTMLElement).getAllByRole("checkbox")).toHaveLength(18);
    expect(CHART_LAYERS).toHaveLength(18);

    fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Hide all" }));
    expect(onChange).toHaveBeenLastCalledWith(allLayers(false));

    fireEvent.click(within(dialog as HTMLElement).getByRole("button", { name: "Show all" }));
    expect(onChange).toHaveBeenLastCalledWith(allLayers(true));
  });
});
