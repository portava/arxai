// Truth audit 2026-10-28 — the Focus scalp card runs one scalp read (no
// polling) and lifts its setup-aware verdict into the page store the header
// Action cell and the chart Plan Buy/Sell CTAs read. That verdict (a) must
// never outrank the CURRENT data-only verdict when that verdict says the feed
// can't support a live entry, and (b) must be retracted once the scalp read's
// own server-declared expiresAt has passed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ScalpResult } from "@workspace/api-client-react";
import { ScalpSignalCard } from "./ScalpSignalCard";
import {
  resolveSelectedSymbolActionability,
  resolveSelectedSymbolActionabilityDisplay,
} from "@/lib/scannerActionability";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const NOW = Date.parse("2026-10-28T10:00:00.000Z");

function makeResult(overrides: Partial<ScalpResult> = {}): ScalpResult {
  return {
    symbol: "EURUSD", displayName: "EUR/USD", assetClass: "forex", direction: "BUY", scalpType: "Momentum",
    mode: "ANY", status: "READY", qualityScore: 72, confidenceLabel: "Strong", entryType: "MARKET_BUY",
    entryZone: { from: 1.1, to: 1.1005 }, currentPrice: 1.1002, takeProfit: { quick: 1.101, main: 1.102, stretch: 1.103 },
    stopLoss: 1.099, invalidationPrice: 1.0985, suggestedLot: 0.1, minLot: 0.01, maxLot: 5, lotStep: 0.01, digits: 5,
    targetProfitAmount: 20, estimatedProfitMainTP: 20, estimatedRiskAmount: 10, rewardToRisk: 2, estimatedMargin: 100,
    spreadRisk: "LOW", slippageRisk: "LOW", newsRisk: "LOW", timingStatus: "VALID_NOW", validForSeconds: 60,
    expiresAt: new Date(NOW + 60_000).toISOString(), chaseWarning: null, plainEnglishReason: "Clean momentum continuation.",
    riskWarning: null, targetRealityCheck: "REALISTIC", userAction: "READY_TO_REVIEW", canBuildTrade: true, canWatch: false,
    noTradeReason: null, flame: null, generatedAt: new Date(NOW).toISOString(), timeframe: "M5",
    ...overrides,
  } as ScalpResult;
}

describe("lifted scalp verdict vs the current data-only verdict", () => {
  it.each(["ANALYSIS_ONLY", "FEED_LIMITED", "MARKET_CLOSED"] as const)(
    "a lifted READY_NOW never outranks a current %s data verdict",
    (dataOnly) => {
      expect(resolveSelectedSymbolActionabilityDisplay("READY_NOW", dataOnly)).toBe(dataOnly);
      expect(resolveSelectedSymbolActionability("READY_NOW", dataOnly)).toBe(dataOnly);
      expect(resolveSelectedSymbolActionability("WAIT_FOR_CONFIRMATION", dataOnly)).toBe(dataOnly);
    },
  );
  it("a lifted verdict still wins over clean data (setup-aware beats data-only WAIT)", () => {
    expect(resolveSelectedSymbolActionability("READY_NOW", "WAIT_FOR_CONFIRMATION")).toBe("READY_NOW");
    expect(resolveSelectedSymbolActionability("NO_CLEAN_SETUP", "WAIT_FOR_CONFIRMATION")).toBe("NO_CLEAN_SETUP");
  });
  it("the more severe of two data caps stands", () => {
    expect(resolveSelectedSymbolActionability("MARKET_CLOSED", "FEED_LIMITED")).toBe("MARKET_CLOSED");
    expect(resolveSelectedSymbolActionability("ANALYSIS_ONLY", "FEED_LIMITED")).toBe("FEED_LIMITED");
  });
});

describe("ScalpSignalCard — the scalp read's own lifetime", () => {
  it("retracts its lifted verdict and disables Build once expiresAt passes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    const publish = vi.fn();
    render(<ScalpSignalCard result={makeResult()} onBuild={() => {}} onActionability={publish} />);
    expect(publish).toHaveBeenLastCalledWith("EURUSD", "5m", "READY_NOW", "BUY");
    expect((screen.getByTestId("scalp-build-EURUSD") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("scalp-expired-EURUSD")).toBeNull();

    act(() => { vi.advanceTimersByTime(60_001); });

    expect(publish).toHaveBeenLastCalledWith("EURUSD", "5m", null, null);
    expect((screen.getByTestId("scalp-build-EURUSD") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("scalp-expired-EURUSD").textContent).toMatch(/expired/i);
    expect(screen.getByTestId("scalp-card-EURUSD").textContent).not.toMatch(/Ready now|Valid now/i);
  });

  it("a read with no parseable expiresAt is not lifted as current", () => {
    const publish = vi.fn();
    render(<ScalpSignalCard result={makeResult({ expiresAt: "not-a-date" })} onBuild={() => {}} onActionability={publish} />);
    expect(publish).toHaveBeenLastCalledWith("EURUSD", "5m", null, null);
    expect((screen.getByTestId("scalp-build-EURUSD") as HTMLButtonElement).disabled).toBe(true);
  });
});
