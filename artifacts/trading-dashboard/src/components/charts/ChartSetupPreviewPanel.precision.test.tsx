// The setup preview card prints Entry / Stop / Target at the instrument's
// precision (truth upgrade, 2026-10-28).
//
// The server computes the levels at instrument precision (setupPreview.ts
// never rounds 1.08523 → 1.0852) and its explanation prints them that way, but
// the card's num() used a magnitude rule (>= 100 → 2 dp, >= 1 → 4 dp): entry
// 1.08523 read "1.0852" and a stop 1.08518 read the same "1.0852" while the
// explanation on the same card said "entry near 1.08523, stop at 1.08518".

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChartSetupPreviewPanel } from "./ChartSetupPreviewPanel";
import type { SetupPreview } from "@/lib/setup-preview";
import type { UseChartSetupPreview } from "@/hooks/useChartSetupPreview";
import { __resetChartPricePrecision, publishChartPricePrecision } from "./chartPricePrecisionStore";

afterEach(() => { cleanup(); __resetChartPricePrecision(); });

function makePreview(overrides: Partial<SetupPreview> = {}): SetupPreview {
  return {
    previewId: "p1",
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    side: "BUY",
    setupType: "Trend continuation",
    levels: { entry: 1.08523, sl: 1.08518, tp: 1.08533, secondaryTp: null, invalidation: 1.08518 },
    rewardToRisk: 2,
    riskAmount: null,
    potentialReward: null,
    confidence: { label: "High", score: 0.85 },
    verdict: "tradeable",
    refusalReason: null,
    dataFreshness: { basis: "VERIFIED", trustLine: "Verified live feed" },
    providerSource: { assetClass: "forex", composite: false, label: "Broker feed" },
    bridgeStatus: null,
    allocationKnown: true,
    scannerScore: null,
    flameStage: null,
    runOnQuality: null,
    riskScore: null,
    governanceOutcome: null,
    explanation: ["Trend continuation: a long idea with entry near 1.08523, stop at 1.08518, target 1.08533."],
    invalidationNote: "Close below 1.08518 invalidates this long.",
    createdBy: "ruby",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    status: "preview",
    ...overrides,
  } as SetupPreview;
}

function makeData(preview: SetupPreview): UseChartSetupPreview {
  return {
    preview, status: "ok", lifecycle: "preview", error: null, expired: false,
    requestDraw: () => {}, discard: () => {}, clear: () => {},
  } as unknown as UseChartSetupPreview;
}

function cell(label: string): string {
  const body = screen.getByTestId("chart-setup-body");
  const el = Array.from(body.querySelectorAll("div")).find((d) => d.textContent === label);
  expect(el, `cell ${label}`).toBeTruthy();
  return el!.nextElementSibling?.textContent ?? "";
}

describe("Setup preview card — level precision", () => {
  it("EURUSD entry/stop/target keep 5 dp and match the card's own explanation", () => {
    render(<ChartSetupPreviewPanel data={makeData(makePreview())} canUseSetup={false} onUseSetup={() => {}} />);
    expect(cell("Entry")).toBe("1.08523");
    expect(cell("Stop")).toBe("1.08518");
    expect(cell("Target")).toBe("1.08533");
    expect(cell("Entry")).not.toBe(cell("Stop"));
    expect(screen.getByTestId("chart-setup-explanation").textContent).toContain(cell("Entry"));
  });

  it("USDJPY keeps 3 dp (150.123, not 150.12)", () => {
    render(
      <ChartSetupPreviewPanel
        data={makeData(makePreview({ symbol: "USDJPY", levels: { entry: 150.123, sl: 149.987, tp: 150.395, secondaryTp: null, invalidation: 149.987 } }))}
        canUseSetup={false}
        onUseSetup={() => {}}
      />,
    );
    expect(cell("Entry")).toBe("150.123");
    expect(cell("Stop")).toBe("149.987");
  });

  it("uses the chart's published precision for the symbol (V75 at 4 dp)", () => {
    publishChartPricePrecision("V75", 4, {});
    render(
      <ChartSetupPreviewPanel
        data={makeData(makePreview({ symbol: "V75", levels: { entry: 401234.5, sl: 400987.1234, tp: 401730.25, secondaryTp: null, invalidation: 400987.1234 } }))}
        canUseSetup={false}
        onUseSetup={() => {}}
      />,
    );
    expect(cell("Entry")).toBe("401234.5000");
    expect(cell("Stop")).toBe("400987.1234");
  });
});
