// A scanner row shows only a timing read computed on its own timeframe: an H4
// card never shows an M15 grade / "Go" (downgrade-only on the client).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return { Flame: Stub, Clock: Stub, AlertTriangle: Stub, TrendingUp: Stub, TrendingDown: Stub, Minus: Stub };
});

import { ScannerTimingBadges, type ScannerTimingContext } from "./ScannerTimingBadges";

afterEach(() => cleanup());

function ctx(over: Partial<ScannerTimingContext> = {}): ScannerTimingContext {
  return {
    heatScore: 80, tradeabilityScore: 80, edgeScore: 70, dangerScore: 10,
    timingGrade: "A", entryPermission: "GO", heatState: "HOT", bestAction: "ENTER", actionReason: "fixture",
    pressureBias: "BUY", newsPhase: "NONE", broadFlowVerdict: "NEUTRAL", sessionName: "London",
    isKillZoneActive: false, trapProbability: 10, roomToMove: 60, heatBoost: 10, dataQualityLabel: "real",
    ...over,
  };
}

describe("ScannerTimingBadges timeframe", () => {
  it("does not show an M15 timing read on an H4 row", () => {
    const { container } = render(<ScannerTimingBadges ctx={ctx({ timeframe: "M15" })} rowTimeframe="H4" />);
    expect(container.textContent).not.toMatch(/Go/);
    expect(screen.queryByTestId("scanner-timing-grade")).toBeNull();
  });

  it("does not show an unstamped timing read on a row", () => {
    const { container } = render(<ScannerTimingBadges ctx={ctx()} rowTimeframe="M1" />);
    expect(container.textContent).toBe("");
  });

  it("shows the row's own timing read and names its timeframe", () => {
    render(<ScannerTimingBadges ctx={ctx({ timeframe: "H4" })} rowTimeframe="H4" />);
    expect(screen.getByTestId("scanner-timing-grade").textContent).toContain("A");
    expect(screen.getByTestId("scanner-timing-timeframe").textContent).toBe("timing H4");
  });
});
