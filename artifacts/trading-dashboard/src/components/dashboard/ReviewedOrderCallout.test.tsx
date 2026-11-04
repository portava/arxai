import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewedOrderCallout } from "./ReviewedOrderCallout";
import { ReviewedOrderFlowSheet } from "./ReviewedOrderFlowSheet";
import { getChartSymbol, setChartSymbol } from "@/lib/use-chart-symbol";

afterEach(() => localStorage.clear());
describe("reviewed order entry point", () => {
  it("launches the existing reviewed flow inside a workspace sheet with the current symbol", () => {
    setChartSymbol("EURUSD");
    expect(getChartSymbol()).toBe("EURUSD");
    const onOpen = vi.fn();
    const { rerender } = render(<><ReviewedOrderCallout symbol="EURUSD" onOpen={onOpen}/><ReviewedOrderFlowSheet open={false} onOpenChange={() => {}} symbol="EURUSD"/></>);
    fireEvent.click(screen.getByRole("button", { name: "Open reviewed order flow for EURUSD" }));
    expect(onOpen).toHaveBeenCalledOnce();
    rerender(<><ReviewedOrderCallout symbol="EURUSD" onOpen={onOpen}/><ReviewedOrderFlowSheet open onOpenChange={() => {}} symbol="EURUSD"/></>);
    const frame = screen.getByTestId("trade-command-room-frame") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("/trade-command-room");
    expect(frame.title).toBe("Trade Command Room for EURUSD");
    expect(screen.getByTestId("reviewed-order-loading").textContent).toContain("first load can take a few seconds");
    fireEvent.load(frame);
    expect(screen.queryByTestId("reviewed-order-loading")).toBeNull();
    expect(screen.getByRole("link", { name: "Open in a new tab" }).getAttribute("href")).toBe("/trade-command-room");
  });
});
