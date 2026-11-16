// CS2 regression: the setup-preview "Scanner" chip names the timeframe its
// score was computed on. The assistant scanner now scores every chart timeframe
// M1..D1; a reading borrowed from a higher timeframe is labelled as a fallback,
// and only a timeframe outside M1..D1 says "no scanner score for X".
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { ChartSetupPreviewPanel } from "./ChartSetupPreviewPanel";
import { setupScannerChipContext, type SetupPreview } from "@/lib/setup-preview";
import type { UseChartSetupPreview } from "@/hooks/useChartSetupPreview";

afterEach(() => cleanup());

function makePreview(over: Partial<SetupPreview> = {}): SetupPreview {
  return {
    previewId: "p1", symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M15", side: "BUY",
    setupType: "Trend continuation",
    levels: { entry: 1.1, sl: 1.09, tp: 1.12, secondaryTp: null, invalidation: 1.09 },
    rewardToRisk: 2, riskAmount: null, potentialReward: null,
    confidence: { label: "High", score: 0.85 }, verdict: "tradeable", refusalReason: null,
    dataFreshness: { basis: "VERIFIED", trustLine: "Verified live feed" },
    providerSource: { assetClass: "forex", composite: false, label: "Broker feed" },
    bridgeStatus: null, allocationKnown: true,
    scannerScore: null, flameStage: null, runOnQuality: null, riskScore: null, governanceOutcome: null,
    explanation: ["A long idea."], invalidationNote: "x", createdBy: "eleanor",
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90_000).toISOString(),
    status: "preview", ...over,
  };
}

function renderPanel(p: SetupPreview) {
  const data = { preview: p, status: "ok", lifecycle: "preview", error: null, expired: false,
    requestDraw: () => {}, discard: () => {}, clear: () => {} } as unknown as UseChartSetupPreview;
  render(<ChartSetupPreviewPanel data={data} canUseSetup={false} onUseSetup={() => {}} />);
}

describe("setup-preview scanner chip timeframe", () => {
  it("labels a score with the chart timeframe it was scored on", () => {
    renderPanel(makePreview({ timeframe: "H1", scannerScore: 72 }));
    const chip = screen.getByTestId("chart-setup-signal-scanner");
    expect(chip.textContent).toContain("Scanner (H1)");
    expect(within(chip).getByText("72")).toBeTruthy();
  });

  it("an M5 draw-setup is scored on M5 (no longer an unscored timeframe)", () => {
    renderPanel(makePreview({ timeframe: "M5", scannerScore: 61, scannerTimeframe: "M5", scannerTimeframeBasis: "exact" }));
    const chip = screen.getByTestId("chart-setup-signal-scanner");
    expect(chip.textContent).toContain("Scanner (M5)");
    expect(chip.textContent).not.toContain("fallback");
  });

  it("a higher-timeframe fallback is labelled, never shown as the chart's own", () => {
    const label = "M5: no signal (insufficient data) — showing the H1 reading (higher-timeframe fallback)";
    renderPanel(makePreview({ timeframe: "M5", scannerScore: 80, scannerTimeframe: "H1", scannerTimeframeBasis: "higher_timeframe_fallback", scannerFallbackLabel: label }));
    const chip = screen.getByTestId("chart-setup-signal-scanner");
    expect(chip.textContent).toContain("Scanner (H1 fallback)");
    expect(chip.textContent).not.toContain("Scanner (M5)");
    const ctx = setupScannerChipContext({ timeframe: "M5", scannerScore: 80, scannerTimeframe: "H1", scannerTimeframeBasis: "higher_timeframe_fallback", scannerFallbackLabel: label });
    expect(ctx.fallback).toBe(true);
    expect(ctx.help).toContain(label);
  });

  it("M5 with no reading at all is 'not consulted', not 'unscored'", () => {
    expect(setupScannerChipContext({ timeframe: "M5", scannerScore: null }).nullNote).toBeNull();
    expect(setupScannerChipContext({ timeframe: "W1", scannerScore: null }).nullNote).toBe("no scanner score for W1");
  });

  it("help text names the engine so it is not confused with the overlay-panel scanner", () => {
    expect(setupScannerChipContext({ timeframe: "M15", scannerScore: 60 }).help).toMatch(/different engine/);
    expect(setupScannerChipContext({ timeframe: "M15", scannerScore: 60 }).help).toMatch(/uncalibrated/i);
    expect(setupScannerChipContext({ timeframe: "M15", scannerScore: 60 }).help).not.toMatch(/\bis (a )?(probability|confidence)\b/i);
    expect(setupScannerChipContext({ timeframe: "M15", scannerScore: null }).nullNote).toBeNull();
  });
});
