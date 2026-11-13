import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChartHistoryControls } from "./ChartHistoryControls";

describe("compact chart history controls", () => {
  const base = {
    loadedCount: 200,
    oldestTimeMs: Date.parse("2026-11-01T12:15:00.000Z"),
    clockLabel: "source clock · UTC unverified",
    archiveCount: 0,
    archiveLabel: "Archived MT5 history",
    loading: false,
    hasMore: true,
    canLoad: true,
    onLoadOlder: vi.fn(),
    onFitHistory: vi.fn(),
  };

  it("shows the loaded candle count and a clearly qualified oldest source-clock timestamp", () => {
    render(<ChartHistoryControls {...base} />);
    const summary = screen.getByTestId("chart-loaded-window");
    expect(summary.textContent).toContain("200 loaded");
    expect(summary.textContent).toContain("2026-11-01 12:15");
    expect(summary.textContent).toContain("UTC unverified");
    expect(summary.textContent).not.toContain("12:15Z");
  });

  it("labels archived rows as display-only and keeps Load older and Fit history reachable", () => {
    const onLoadOlder = vi.fn();
    const onFitHistory = vi.fn();
    render(<ChartHistoryControls {...base} archiveCount={500} onLoadOlder={onLoadOlder} onFitHistory={onFitHistory} />);
    expect(screen.getByTestId("chart-archive-display-only").textContent).toContain("identity unverified");
    fireEvent.click(screen.getByRole("button", { name: "Load older candles" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit all loaded chart history" }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onFitHistory).toHaveBeenCalledTimes(1);
  });

  it("prevents repeated loads while busy or when the source reports no more pages", () => {
    const onLoadOlder = vi.fn();
    const { rerender } = render(<ChartHistoryControls {...base} loading onLoadOlder={onLoadOlder} />);
    expect(screen.getByRole("button", { name: "Loading older candles" })).toBeDisabled();
    rerender(<ChartHistoryControls {...base} hasMore={false} onLoadOlder={onLoadOlder} />);
    expect(screen.getByRole("button", { name: "Load older candles" })).toBeDisabled();
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});
