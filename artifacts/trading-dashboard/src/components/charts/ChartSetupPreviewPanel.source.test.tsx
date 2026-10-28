// Regression: the setup preview's "Source:" line names the feed that served the
// chart. A broker-bridge series carries no qualifier; any other source is
// marked "not a broker quote" (the old "(composite)" suffix was also printed
// for an unreported source, which is not known to be composite).
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChartSetupPreviewPanel } from "./ChartSetupPreviewPanel";
import type { SetupPreview } from "@/lib/setup-preview";
import type { UseChartSetupPreview } from "@/hooks/useChartSetupPreview";

afterEach(() => cleanup());

function preview(providerSource: SetupPreview["providerSource"]): SetupPreview {
  return {
    previewId: "p1", symbol: "EURUSD", displaySymbol: "EUR/USD", timeframe: "M15", side: "BUY",
    setupType: "Trend continuation",
    levels: { entry: 1.1, sl: 1.09, tp: 1.12, secondaryTp: null, invalidation: 1.09 },
    rewardToRisk: 2, riskAmount: null, potentialReward: null,
    confidence: { label: "High", score: 0.85 }, verdict: "tradeable", refusalReason: null,
    dataFreshness: { basis: "VERIFIED", trustLine: "Verified M15 candles · Live feed" },
    providerSource, bridgeStatus: null, allocationKnown: true,
    scannerScore: null, flameStage: null, runOnQuality: null, riskScore: null, governanceOutcome: null,
    explanation: ["A long idea."], invalidationNote: "Close below 1.09 invalidates this long.",
    createdBy: "ruby", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90_000).toISOString(), status: "preview",
  };
}
function data(p: SetupPreview): UseChartSetupPreview {
  return {
    preview: p, status: "ok", lifecycle: "preview", error: null, expired: false,
    requestDraw: () => {}, discard: () => {}, clear: () => {},
  } as unknown as UseChartSetupPreview;
}

describe("ChartSetupPreviewPanel — source line", () => {
  it("names the MT5 broker bridge without a composite qualifier", () => {
    render(<ChartSetupPreviewPanel data={data(preview({ assetClass: "forex", composite: false, label: "MetaTrader 5 broker bridge" }))} canUseSetup={false} onUseSetup={() => {}} />);
    expect(screen.getByTestId("chart-setup-source").textContent).toBe("Source: MetaTrader 5 broker bridge");
  });

  it("marks a non-broker or unreported source as not a broker quote", () => {
    render(<ChartSetupPreviewPanel data={data(preview({ assetClass: "forex", composite: true, label: "unreported" }))} canUseSetup={false} onUseSetup={() => {}} />);
    expect(screen.getByTestId("chart-setup-source").textContent).toBe("Source: unreported (not a broker quote)");
  });
});
