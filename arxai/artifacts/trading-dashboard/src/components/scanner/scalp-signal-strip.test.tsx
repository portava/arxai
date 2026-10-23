// Task #383 — the scanner scalp/signal card surfaces the SAME glanceable signal
// strip the chart AI setup-preview card shows, reusing the shared honest
// formatters. The card reads straight from its existing ScalpResult: the
// scanner (quality) score and live flame momentum are real; signals the scalp
// engine never sends to the client (risk score, team governance) are never
// fabricated — they are simply hidden, never shown as a fake value.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

import { ScalpSignalCard } from "./ScalpSignalCard";
import type { ScalpResult, ScalpFlameRead } from "@workspace/api-client-react";

afterEach(() => cleanup());

function makeFlame(overrides: Partial<ScalpFlameRead> = {}): ScalpFlameRead {
  return {
    scalpStatus: "STRONG",
    readDirection: "BUY",
    scalpScore: 80,
    flameStage: "RUN_ON",
    flameAgeCandles: 3,
    freshness: "FRESH",
    entryTiming: "CLEAN",
    chaseRisk: "LOW",
    runway: "CLEAR",
    executionQuality: "GOOD",
    htfContext: "ALIGNED",
    setupType: "CONTINUATION",
    riskPersonality: "BALANCED",
    whyNow: null,
    entryTrigger: null,
    targetIdea: null,
    invalidationIdea: null,
    decayNote: null,
    blind: false,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ScalpResult> = {}): ScalpResult {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    assetClass: "forex",
    direction: "BUY",
    scalpType: "Momentum",
    mode: "ANY",
    status: "READY",
    qualityScore: 72,
    confidenceLabel: "Strong",
    entryType: "MARKET_BUY",
    entryZone: { from: 1.1, to: 1.1005 },
    currentPrice: 1.1002,
    takeProfit: { quick: 1.101, main: 1.102, stretch: 1.103 },
    stopLoss: 1.099,
    invalidationPrice: 1.0985,
    suggestedLot: 0.1,
    minLot: 0.01,
    maxLot: 5,
    lotStep: 0.01,
    digits: 5,
    targetProfitAmount: 20,
    estimatedProfitMainTP: 20,
    estimatedRiskAmount: 10,
    rewardToRisk: 2,
    estimatedMargin: 100,
    spreadRisk: "LOW",
    slippageRisk: "LOW",
    newsRisk: "LOW",
    timingStatus: "VALID_NOW",
    validForSeconds: 90,
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    chaseWarning: null,
    plainEnglishReason: "Clean momentum continuation.",
    riskWarning: null,
    targetRealityCheck: "REALISTIC",
    userAction: "READY_TO_REVIEW",
    canBuildTrade: true,
    canWatch: true,
    noTradeReason: null,
    flame: makeFlame(),
    generatedAt: new Date().toISOString(),
    ...overrides,
  } as ScalpResult;
}

describe("ScalpSignalCard — shared honest signal strip", () => {
  it("renders the strip with the real scanner score and live flame momentum", () => {
    render(<ScalpSignalCard result={makeResult()} />);
    const strip = screen.getByTestId("scalp-signal-EURUSD-strip");
    expect(strip).toBeTruthy();
    // Scanner score is the real engine quality score — never fabricated.
    expect(within(screen.getByTestId("scalp-signal-EURUSD-scanner")).getByText("72")).toBeTruthy();
    // Live flame stage maps to the same plain-English momentum read as the chart.
    expect(within(screen.getByTestId("scalp-signal-EURUSD-momentum")).getByText("Run-on")).toBeTruthy();
  });

  it("hides the momentum chip when the flame read is blind — never invents a stage", () => {
    render(
      <ScalpSignalCard
        result={makeResult({ flame: makeFlame({ blind: true, flameStage: "NONE" }) })}
      />,
    );
    expect(screen.getByTestId("scalp-signal-EURUSD-strip")).toBeTruthy();
    expect(screen.queryByTestId("scalp-signal-EURUSD-momentum")).toBeNull();
    expect(screen.queryByTestId("scalp-signal-EURUSD-momentum-not-consulted")).toBeNull();
  });

  it("never shows risk-score or team chips the scalp result does not provide", () => {
    render(<ScalpSignalCard result={makeResult()} />);
    // The scalp result carries no numeric risk score or governance outcome, so
    // those chips must be absent entirely — never a fabricated value.
    expect(screen.queryByTestId("scalp-signal-EURUSD-risk")).toBeNull();
    expect(screen.queryByTestId("scalp-signal-EURUSD-governance")).toBeNull();
    expect(screen.queryByText("not consulted")).toBeNull();
  });
});
