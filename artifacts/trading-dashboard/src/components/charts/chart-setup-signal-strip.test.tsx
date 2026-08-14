// Task #382 — the setup-preview signal strip surfaces the real per-preview
// signals (scanner, risk, momentum, governance) and NEVER fabricates a value:
// a null backend signal renders an honest "not consulted", never a number or a
// made-up verdict. The strip reads straight from the draw-setup response.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

import { ChartSetupPreviewPanel } from "./ChartSetupPreviewPanel";
import {
  governanceSignal,
  momentumSignal,
  formatSignalScore,
  type SetupPreview,
} from "@/lib/setup-preview";
import type { UseChartSetupPreview } from "@/hooks/useChartSetupPreview";

afterEach(() => cleanup());

function makePreview(overrides: Partial<SetupPreview> = {}): SetupPreview {
  return {
    previewId: "p1",
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    side: "BUY",
    setupType: "Trend continuation",
    levels: { entry: 1.1, sl: 1.09, tp: 1.12, secondaryTp: null, invalidation: 1.09 },
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
    explanation: ["A long idea."],
    invalidationNote: "Close below 1.09 invalidates this long.",
    createdBy: "ruby",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    status: "preview",
    ...overrides,
  };
}

function makeData(preview: SetupPreview): UseChartSetupPreview {
  return {
    preview,
    status: "ok",
    lifecycle: "preview",
    error: null,
    expired: false,
    requestDraw: () => {},
    discard: () => {},
    clear: () => {},
  } as unknown as UseChartSetupPreview;
}

describe("SetupSignalStrip — honest per-signal readout", () => {
  it("shows real signal values when the backend consulted them", () => {
    render(
      <ChartSetupPreviewPanel
        data={makeData(
          makePreview({
            scannerScore: 72,
            riskScore: 4.5,
            flameStage: "RUN_ON",
            runOnQuality: "strong",
            governanceOutcome: "approved_with_caution",
          }),
        )}
        canUseSetup={false}
        onUseSetup={() => {}}
      />,
    );
    expect(screen.getByTestId("chart-setup-signal-strip")).toBeTruthy();
    expect(within(screen.getByTestId("chart-setup-signal-scanner")).getByText("72")).toBeTruthy();
    expect(within(screen.getByTestId("chart-setup-signal-risk")).getByText("4.5")).toBeTruthy();
    expect(within(screen.getByTestId("chart-setup-signal-momentum")).getByText("Run-on · strong")).toBeTruthy();
    expect(
      within(screen.getByTestId("chart-setup-signal-governance")).getByText("Team approves — caution"),
    ).toBeTruthy();
  });

  it("renders an honest 'not consulted' for every null signal — never a fabricated value", () => {
    render(
      <ChartSetupPreviewPanel
        data={makeData(makePreview())}
        canUseSetup={false}
        onUseSetup={() => {}}
      />,
    );
    for (const id of [
      "chart-setup-signal-scanner",
      "chart-setup-signal-risk",
      "chart-setup-signal-momentum",
      "chart-setup-signal-governance",
    ]) {
      // The "value present" testid must be absent; the "-not-consulted" one present.
      expect(screen.queryByTestId(id)).toBeNull();
      expect(screen.getByTestId(`${id}-not-consulted`)).toBeTruthy();
    }
    expect(screen.getAllByText("not consulted").length).toBe(4);
  });
});

describe("signal formatters — pure honesty", () => {
  it("formatSignalScore returns null (not a 0) for a null/NaN score", () => {
    expect(formatSignalScore(null)).toBeNull();
    expect(formatSignalScore(Number.NaN)).toBeNull();
    expect(formatSignalScore(0)).toBe("0");
    expect(formatSignalScore(72)).toBe("72");
    expect(formatSignalScore(4.5)).toBe("4.5");
  });

  it("momentumSignal returns null when flame stage is null, never a fake stage", () => {
    expect(momentumSignal(null, null)).toBeNull();
    expect(momentumSignal(null, "strong")).toBeNull();
    expect(momentumSignal("IGNITING", null)).toEqual({ label: "Developing run", tone: "good" });
    expect(momentumSignal("RUN_ON", "weak")).toEqual({ label: "Run-on · weak", tone: "caution" });
    expect(momentumSignal("FAILED", null)).toEqual({ label: "Failed", tone: "bad" });
  });

  it("governanceSignal returns null when the team did not weigh in", () => {
    expect(governanceSignal(null)).toBeNull();
    expect(governanceSignal("rejected")).toEqual({ label: "Team steering away", tone: "bad" });
    expect(governanceSignal("approved")).toEqual({ label: "Team approves", tone: "good" });
  });
});
