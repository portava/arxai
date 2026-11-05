// CS6/CS7 regression (panel): a failed scanner fetch says "unavailable", not
// "no signal"; drawn FVG zones get a legend line; a Eleanor read shows its as-of
// time and says when it has expired.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ChartAiOverlayPanel } from "./ChartAiOverlayPanel";
import type { UseAiChartOverlaysResult } from "@/hooks/useAiChartOverlays";

afterEach(() => cleanup());

function data(over: Partial<UseAiChartOverlaysResult> = {}): UseAiChartOverlaysResult {
  return {
    overlays: [], signal: null, scannerStatus: "ok", fvg: null,
    eleanor: { status: "idle", read: null, error: null },
    suppressed: false, suppressedReason: null, requestEleanorRead: vi.fn(), ...over,
  };
}

const READ = { bias: "Bullish", confidence: "Medium", supportZone: "1.1 – 1.101", resistanceZone: "1.12", dataQuality: "ok" as const, observedAt: "2026-11-04T11:45:00.000Z" };

describe("ChartAiOverlayPanel scanner status + legends", () => {
  it("a failed scanner fetch reads as unavailable, not as no signal", () => {
    render(<ChartAiOverlayPanel data={data({ scannerStatus: "unavailable" })} />);
    expect(screen.getByTestId("chart-ai-overlay-scanner-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("chart-ai-overlay-no-signal")).toBeNull();
  });

  it("a scanner that answered with nothing still says no signal", () => {
    render(<ChartAiOverlayPanel data={data({ scannerStatus: "ok" })} />);
    expect(screen.getByTestId("chart-ai-overlay-no-signal")).toBeTruthy();
  });

  it("explains drawn FVG zones", () => {
    render(<ChartAiOverlayPanel data={data({ fvg: { direction: "BUY", stage: "FVG_ENTRY_ZONE", entryTimeframe: "M5", asOf: "2026-11-04T11:55:00.000Z" } })} />);
    const fvg = screen.getByTestId("chart-ai-overlay-fvg");
    expect(fvg.textContent).toContain("FVG pullback");
    expect(fvg.textContent).toContain("M5 read as of 11:55 UTC");
  });

  it("shows the Eleanor read's as-of time and an expired notice", () => {
    render(<ChartAiOverlayPanel data={data({ eleanor: { status: "ok", read: READ, error: null, expired: true, asOf: "11:45 UTC" } })} />);
    expect(screen.getByTestId("chart-ai-overlay-eleanor-asof").textContent).toContain("11:45 UTC");
    expect(screen.getByTestId("chart-ai-overlay-eleanor-expired")).toBeTruthy();
  });
});
